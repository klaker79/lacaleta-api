/**
 * balance Routes — Extracted from server.js
 * Balance, statistics, daily cost/sales tracking
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { requirePlan } = require('../middleware/planGate');
const { log } = require('../utils/logger');
const { costlyApiLimiter } = require('../middleware/rateLimit');
const crypto = require('crypto');
const { upsertCompraDiaria, resolveProveedorId, updateProveedorPrecio } = require('../utils/businessHelpers');

/**
 * Duplicate albaran detection using resolved INGREDIENT IDs.
 * OCR produces different text each scan, so comparing product names is unreliable.
 * Compares ingredient IDs against 3 sources. Flags duplicate when:
 *   1. Ingredient IDs overlap ≥ 70%
 *   2. Dates within ±2 days
 */
async function checkDuplicateAlbaran(pool, restauranteId, ingredientIds, fecha) {
    try {
        const newIds = ingredientIds.filter(Boolean).map(Number).sort((a, b) => a - b);
        if (newIds.length === 0) return null;

        const newDate = fecha ? new Date(fecha) : null;

        const isDateClose = (existingFecha) => {
            if (!newDate || !existingFecha) return true;
            const diffDays = Math.abs(newDate.getTime() - new Date(existingFecha).getTime()) / 86400000;
            return diffDays <= 2;
        };

        const calcSimilarity = (existingIds) => {
            const s = new Set(existingIds);
            let m = 0;
            for (const id of newIds) { if (s.has(id)) m++; }
            return m / Math.max(newIds.length, existingIds.length);
        };

        // ── Source 1: compras_pendientes (ALL states — pendiente, aprobado, rechazado) ──
        const pendingResult = await pool.query(
            `SELECT batch_id, ingrediente_id, fecha, estado
             FROM compras_pendientes
             WHERE restaurante_id = $1
               AND ingrediente_id IS NOT NULL
               AND fecha >= (CURRENT_DATE - INTERVAL '60 days')
             ORDER BY batch_id, id`,
            [restauranteId]
        );

        if (pendingResult.rows.length > 0) {
            const batches = new Map();
            for (const row of pendingResult.rows) {
                if (!batches.has(row.batch_id)) batches.set(row.batch_id, { ids: [], fecha: row.fecha, estado: row.estado });
                batches.get(row.batch_id).ids.push(Number(row.ingrediente_id));
            }
            for (const [batchId, batch] of batches) {
                if (!isDateClose(batch.fecha)) continue;
                const similarity = calcSimilarity(batch.ids.sort((a, b) => a - b));
                if (similarity >= 0.7) {
                    const source = batch.estado === 'aprobado' ? 'approved' : 'pending';
                    return { batchId, fecha: batch.fecha, itemCount: batch.ids.length, similarity: Math.round(similarity * 100), source };
                }
            }
        }

        // ── Source 2: precios_compra_diarios (consolidated purchases, last 60 days) ──
        const approvedResult = await pool.query(
            `SELECT pcd.fecha, pcd.proveedor_id, pcd.pedido_id, pcd.ingrediente_id
             FROM precios_compra_diarios pcd
             WHERE pcd.restaurante_id = $1
               AND pcd.fecha >= (CURRENT_DATE - INTERVAL '60 days')
             ORDER BY pcd.fecha, pcd.proveedor_id`,
            [restauranteId]
        );

        if (approvedResult.rows.length > 0) {
            const approvedBatches = new Map();
            for (const row of approvedResult.rows) {
                const key = `${row.fecha}_${row.pedido_id || row.proveedor_id || 0}`;
                if (!approvedBatches.has(key)) approvedBatches.set(key, { ids: [], fecha: row.fecha });
                approvedBatches.get(key).ids.push(Number(row.ingrediente_id));
            }
            for (const [key, batch] of approvedBatches) {
                if (batch.ids.length < 2) continue;
                if (!isDateClose(batch.fecha)) continue;
                const similarity = calcSimilarity(batch.ids.sort((a, b) => a - b));
                if (similarity >= 0.7) {
                    return {
                        batchId: key,
                        fecha: batch.fecha,
                        itemCount: batch.ids.length,
                        similarity: Math.round(similarity * 100),
                        source: 'approved'
                    };
                }
            }
        }

        // ── Source 3: pedidos manuales (JSONB ingredientes, last 60 days) ──
        const ordersResult = await pool.query(
            `SELECT p.id, p.fecha, p.ingredientes
             FROM pedidos p
             WHERE p.restaurante_id = $1
               AND p.deleted_at IS NULL
               AND p.estado = 'recibido'
               AND p.fecha >= (CURRENT_DATE - INTERVAL '60 days')`,
            [restauranteId]
        );

        if (ordersResult.rows.length > 0) {
            for (const order of ordersResult.rows) {
                if (!isDateClose(order.fecha)) continue;
                const ings = Array.isArray(order.ingredientes) ? order.ingredientes : [];
                const orderIds = ings
                    .map(ing => Number(ing.ingredienteId || ing.ingrediente_id))
                    .filter(Boolean)
                    .sort((a, b) => a - b);
                if (orderIds.length < 2) continue;
                const similarity = calcSimilarity(orderIds);
                if (similarity >= 0.7) {
                    return { batchId: `order_${order.id}`, fecha: order.fecha, itemCount: orderIds.length, similarity: Math.round(similarity * 100), source: 'manual_order' };
                }
            }
        }

        return null;
    } catch (err) {
        log('error', 'Error checking duplicate albaran', { error: err.message });
        return null;
    }
}

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== BALANCE Y ESTADÍSTICAS ==========
    router.get('/balance/mes', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();

            // Use date range instead of EXTRACT for index usage
            const startDate = `${anoActual}-${String(mesActual).padStart(2, '0')}-01`;
            const nextMonth = mesActual === 12 ? 1 : mesActual + 1;
            const nextYear = mesActual === 12 ? anoActual + 1 : anoActual;
            const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

            const ventasMes = await pool.query(
                `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
       FROM ventas
       WHERE fecha >= $1 AND fecha < $2 AND restaurante_id = $3 AND deleted_at IS NULL`,
                [startDate, endDate, req.restauranteId]
            );

            const ventasDetalle = await pool.query(
                `SELECT v.cantidad, r.ingredientes
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL`,
                [startDate, endDate, req.restauranteId]
            );

            // Precargar precios de ingredientes + media de compras reales
            const ingredientesResult = await pool.query(
                `SELECT i.id, i.precio, i.cantidad_por_formato, i.rendimiento,
                        pcd.precio_medio_compra
                 FROM ingredientes i
                 LEFT JOIN (
                     SELECT ingrediente_id, ROUND(AVG(precio_unitario)::numeric, 4) as precio_medio_compra
                     FROM precios_compra_diarios WHERE restaurante_id = $1
                     GROUP BY ingrediente_id
                 ) pcd ON pcd.ingrediente_id = i.id
                 WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );
            const preciosMap = new Map();
            const rendimientoBaseMap = new Map();
            ingredientesResult.rows.forEach(i => {
                if (i.precio_medio_compra) {
                    preciosMap.set(i.id, parseFloat(i.precio_medio_compra));
                } else {
                    const precio = parseFloat(i.precio) || 0;
                    const cpf = parseFloat(i.cantidad_por_formato) || 1;
                    preciosMap.set(i.id, precio / cpf);
                }
                if (i.rendimiento) {
                    rendimientoBaseMap.set(i.id, parseFloat(i.rendimiento));
                }
            });

            // Calcular costos usando el Map (sin queries adicionales)
            let costos = 0;
            for (const venta of ventasDetalle.rows) {
                const ingredientes = venta.ingredientes || [];
                for (const ing of ingredientes) {
                    const precio = preciosMap.get(ing.ingredienteId) || 0;
                    // 🔧 FIX: Rendimiento con fallback al ingrediente base
                    let rendimiento = parseFloat(ing.rendimiento);
                    if (!rendimiento || rendimiento === 100) {
                        rendimiento = rendimientoBaseMap.get(ing.ingredienteId) || 100;
                    }
                    const factorRendimiento = rendimiento / 100;
                    const costeReal = factorRendimiento > 0 ? (precio / factorRendimiento) : precio;
                    costos += costeReal * (ing.cantidad || 0) * venta.cantidad;
                }
            }

            const ingresos = parseFloat(ventasMes.rows[0].ingresos) || 0;
            const ganancia = ingresos - costos;
            const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;

            const platoMasVendido = await pool.query(
                `SELECT r.nombre, SUM(v.cantidad) as total_vendido
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_vendido DESC
       LIMIT 1`,
                [startDate, endDate, req.restauranteId]
            );

            const ventasPorPlato = await pool.query(
                `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE v.fecha >= $1 AND v.fecha < $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_ingresos DESC`,
                [startDate, endDate, req.restauranteId]
            );

            const valorInventario = await pool.query(
                `SELECT COALESCE(SUM(stock_actual * (precio / COALESCE(NULLIF(cantidad_por_formato, 0), 1))), 0) as valor
       FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL`,
                [req.restauranteId]
            );

            res.json({
                ingresos,
                costos,
                ganancia,
                margen: parseFloat(margen),
                num_ventas: parseInt(ventasMes.rows[0].num_ventas) || 0,
                plato_mas_vendido: platoMasVendido.rows[0] || null,
                ventas_por_plato: ventasPorPlato.rows || [],
                valor_inventario: parseFloat(valorInventario.rows[0].valor) || 0
            });
        } catch (error) {
            log('error', 'Error obteniendo balance', { error: error.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.get('/balance/comparativa', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const meses = await pool.query(
                `SELECT 
         TO_CHAR(fecha, 'YYYY-MM') as mes,
         SUM(total) as ingresos,
         COUNT(*) as num_ventas
       FROM ventas
       WHERE restaurante_id = $1 AND deleted_at IS NULL
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`,
                [req.restauranteId]
            );
            res.json(meses.rows || []);
        } catch (error) {
            log('error', 'Error comparativa', { error: error.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // ========== TRACKING DIARIO DE COSTES/VENTAS ==========

    // Obtener precios de compra diarios
    router.get('/daily/purchases', authMiddleware, async (req, res) => {
        try {
            const { fecha, mes, ano } = req.query;
            let query = `
            SELECT p.ingrediente_id, p.fecha, p.restaurante_id,
                   i.nombre as ingrediente_nombre, i.unidad,
                   -- Agregar cantidades de múltiples pedidos del mismo día
                   SUM(p.cantidad_comprada) as cantidad_comprada,
                   SUM(p.total_compra) as total_compra,
                   -- Precio unitario ponderado: total / cantidad
                   CASE WHEN SUM(p.cantidad_comprada) > 0 
                        THEN SUM(p.total_compra) / SUM(p.cantidad_comprada)
                        ELSE MAX(p.precio_unitario)
                   END as precio_unitario,
                   MAX(pr.nombre) as proveedor_nombre,
                   MAX(p.proveedor_id) as proveedor_id,
                   MAX(p.id) as id,
                   MAX(p.pedido_id) as pedido_id,
                   MAX(p.created_at) as created_at,
                   MAX(p.notas) as notas
            FROM precios_compra_diarios p
            LEFT JOIN ingredientes i ON p.ingrediente_id = i.id
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            WHERE p.restaurante_id = $1
        `;
            let params = [req.restauranteId];

            if (fecha) {
                query += ' AND p.fecha = $2';
                params.push(fecha);
            } else if (mes && ano) {
                const m = parseInt(mes), y = parseInt(ano);
                const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
                const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
                const endDate = `${ny}-${String(nm).padStart(2, '0')}-01`;
                query += ' AND p.fecha >= $2 AND p.fecha < $3';
                params.push(startDate, endDate);
            }

            query += ' GROUP BY p.ingrediente_id, p.fecha, p.restaurante_id, i.nombre, i.unidad';
            query += ' ORDER BY p.fecha DESC, i.nombre';

            const result = await pool.query(query, params);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo compras diarias', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // ==========================================
    // 📸 ESCANEO DE ALBARANES CON CLAUDE VISION
    // ==========================================

    router.post('/parse-albaran', authMiddleware, requirePlan('profesional'), costlyApiLimiter, async (req, res) => {
        try {
            const { imageBase64, mediaType, filename } = req.body;

            if (!imageBase64) {
                return res.status(400).json({ error: 'Se requiere imageBase64' });
            }

            // Validar tipo
            const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
            const finalMediaType = mediaType || 'image/jpeg';
            if (!validTypes.includes(finalMediaType)) {
                return res.status(400).json({ error: `Tipo no soportado: ${finalMediaType}. Usa JPG, PNG, WebP o PDF.` });
            }

            // Límite de tamaño: 10MB en base64
            const MAX_SIZE = 10 * 1024 * 1024;
            if (imageBase64.length > MAX_SIZE) {
                return res.status(413).json({ error: 'Archivo demasiado grande. Máximo 10MB.' });
            }

            // ── Image hash dedup: SHA-256 of the raw base64 content ──
            const imageHash = crypto.createHash('sha256').update(imageBase64).digest('hex');

            const hashCheck = await pool.query(
                `SELECT batch_id, fecha, COUNT(*) as item_count
                 FROM compras_pendientes
                 WHERE restaurante_id = $1 AND image_hash = $2
                   AND estado IN ('pendiente', 'aprobado')
                 GROUP BY batch_id, fecha
                 LIMIT 1`,
                [req.restauranteId, imageHash]
            );

            if (hashCheck.rows.length > 0) {
                const dup = hashCheck.rows[0];
                log('warn', 'Duplicate albaran blocked by image hash', {
                    existingBatchId: dup.batch_id, imageHash, restauranteId: req.restauranteId
                });
                return res.json({
                    success: true,
                    batchId: dup.batch_id,
                    proveedor: null,
                    fecha: dup.fecha,
                    totalItems: parseInt(dup.item_count),
                    matched: 0,
                    unmatched: 0,
                    totalImporte: 0,
                    duplicateWarning: {
                        batchId: dup.batch_id,
                        fecha: dup.fecha,
                        itemCount: parseInt(dup.item_count),
                        similarity: 100,
                        source: 'image_hash'
                    }
                });
            }

            // API Key
            const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
            if (!ANTHROPIC_API_KEY) {
                return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' });
            }

            log('info', 'Procesando albarán con Claude Vision', { filename, mediaType: finalMediaType, tamaño: imageBase64.length });

            // Construir content según tipo
            const documentContent = finalMediaType === 'application/pdf'
                ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
                : { type: 'image', source: { type: 'base64', media_type: finalMediaType, data: imageBase64 } };

            // Llamar Claude Vision
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4096,
                    messages: [{
                        role: 'user',
                        content: [
                            documentContent,
                            {
                                type: 'text',
                                text: `Eres un sistema de OCR de alta precisión para albaranes y facturas de proveedores de hostelería en España.

TAREA: Extrae TODOS los datos del documento con PRECISIÓN EXACTA. Copia el texto EXACTAMENTE como aparece impreso.

Retorna ÚNICAMENTE un JSON válido (sin explicaciones, sin markdown):
{
  "proveedor": "nombre EXACTO de la empresa emisora tal como aparece en el documento",
  "numero_factura": "número de serie/albarán/factura tal como aparece (ej: '426', 'A-7005900', 'F2024-001')",
  "fecha": "YYYY-MM-DD",
  "lineas": [
    {
      "producto": "nombre EXACTO del producto tal como aparece impreso",
      "cantidad": 15.00,
      "precio_unitario": 1.65,
      "total": 24.75,
      "unidad": "kg"
    }
  ]
}

REGLAS CRÍTICAS DE PRECISIÓN:

1. PROVEEDOR: Copia el nombre de la empresa emisora EXACTAMENTE como aparece en la cabecera del documento. Incluye razón social completa (ej: "AS VACAS DA ULLOA SCG", no "Sen Mais").

2. NÚMERO DE FACTURA/ALBARÁN: Busca en la cabecera campos como "Serie/Número", "Nº Albarán", "Nº Factura", "Serie", "Número". Copia el valor EXACTO.

3. FECHA: 
   - Busca la fecha en la cabecera del documento (no en caducidades ni lotes).
   - Los documentos son RECIENTES (años 2024, 2025, 2026). Si ves "04/02/2026", la fecha es 2026-02-04.
   - Si la fecha dice "04/02/26", el año es 2026 (NO 1926, NO 2006).
   - Formato de salida SIEMPRE: YYYY-MM-DD.
   - CUIDADO: En España las fechas son DD/MM/YYYY, no MM/DD/YYYY.

4. PRODUCTOS:
   - Copia el nombre del producto EXACTAMENTE como está impreso (respeta mayúsculas, tildes, abreviaturas).
   - Incluye TODAS las líneas con productos, incluso devoluciones (cantidad negativa).
   - "precio_unitario" = precio por UNA unidad/kg (NO el importe total de la línea).
   - Si solo ves importe total y cantidad: precio_unitario = total / cantidad.
   - "unidad": extrae la unidad si aparece (kg, ud, litro, caja, bandeja). Si no aparece, usa "ud".

5. NO INCLUIR: líneas de totales, subtotales, IVA, bases imponibles, portes, recargos de equivalencia.

6. Si un campo no es legible, usa null. NUNCA inventes datos.`
                            }
                        ]
                    }]
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                log('error', 'Error de Claude API procesando albarán', errorData);
                return res.status(500).json({ error: 'Error procesando albarán con IA' });
            }

            const claudeResponse = await response.json();
            let textContent = claudeResponse.content?.[0]?.text || '';

            // Limpiar respuesta (quitar markdown code blocks)
            textContent = textContent.replace(/```json/g, '').replace(/```/g, '').trim();

            // Extraer JSON
            const startIdx = textContent.indexOf('{');
            const endIdx = textContent.lastIndexOf('}');
            if (startIdx === -1 || endIdx === -1) {
                return res.status(500).json({ error: 'No se pudo extraer datos del albarán' });
            }

            let data;
            try {
                data = JSON.parse(textContent.substring(startIdx, endIdx + 1));
            } catch (parseError) {
                log('error', 'Error parseando JSON de albarán', { error: parseError.message, rawText: textContent.substring(0, 500) });
                return res.status(500).json({ error: 'Error parseando respuesta de IA' });
            }

            if (!data.lineas || !Array.isArray(data.lineas) || data.lineas.length === 0) {
                return res.status(400).json({ error: 'No se detectaron líneas de producto en el albarán' });
            }

            // ══════════════════════════════════════════════
            // POST-PROCESSING: Validación y corrección de datos
            // ══════════════════════════════════════════════

            // ── Fecha: normalizar y validar ──
            let fecha = data.fecha || new Date().toISOString().split('T')[0];

            if (typeof fecha === 'string') {
                // Normalizar separadores (/, ., -) 
                const cleanFecha = fecha.replace(/[/.]/g, '-').trim();

                // DD-MM-YY → YYYY-MM-DD
                if (/^\d{2}-\d{2}-\d{2}$/.test(cleanFecha)) {
                    const [dd, mm, yy] = cleanFecha.split('-');
                    let year = parseInt(yy);
                    year = year < 100 ? year + 2000 : year;
                    fecha = `${year}-${mm}-${dd}`;
                }
                // DD-MM-YYYY → YYYY-MM-DD
                else if (/^\d{2}-\d{2}-\d{4}$/.test(cleanFecha)) {
                    const [dd, mm, yyyy] = cleanFecha.split('-');
                    fecha = `${yyyy}-${mm}-${dd}`;
                }
                // Already YYYY-MM-DD — keep as is
                else if (/^\d{4}-\d{2}-\d{2}$/.test(cleanFecha)) {
                    fecha = cleanFecha;
                }

                // Sanity check: year must be >= 2020
                const yearMatch = fecha.match(/^(\d{4})/);
                if (yearMatch) {
                    const year = parseInt(yearMatch[1]);
                    if (year < 2020) {
                        // Common OCR error: 2008 instead of 2026, 2020 instead of 2026
                        // Fix by using current year or inferring from context
                        const currentYear = new Date().getFullYear();
                        fecha = fecha.replace(/^\d{4}/, String(currentYear));
                        log('warn', `Fecha del albarán corregida: año ${year} → ${currentYear}`, { original: data.fecha, corrected: fecha });
                    }
                }
            }

            // ── Dedup por numero_factura: mismo nº + mismo restaurante = duplicado seguro ──
            // Solo bloquea si el batch sigue pendiente o aprobado (rechazados se pueden volver a subir)
            const numFactura = (data.numero_factura || '').toString().trim();
            if (numFactura) {
                const facturaCheck = await pool.query(
                    `SELECT batch_id, fecha, COUNT(*) as item_count
                     FROM compras_pendientes
                     WHERE restaurante_id = $1
                       AND TRIM(numero_factura) = $2
                       AND estado IN ('pendiente', 'aprobado')
                     GROUP BY batch_id, fecha
                     ORDER BY fecha DESC
                     LIMIT 1`,
                    [req.restauranteId, numFactura]
                );

                if (facturaCheck.rows.length > 0) {
                    const dup = facturaCheck.rows[0];
                    log('warn', 'Duplicate albaran blocked by numero_factura', {
                        existingBatchId: dup.batch_id, numero_factura: numFactura, restauranteId: req.restauranteId
                    });
                    return res.json({
                        success: false,
                        duplicateWarning: {
                            batchId: dup.batch_id,
                            fecha: dup.fecha,
                            itemCount: parseInt(dup.item_count),
                            similarity: 100,
                            source: 'numero_factura',
                            numero_factura: numFactura
                        }
                    });
                }
            }

            // ── Cantidades y precios: asegurar valores absolutos y numéricos ──
            data.lineas = data.lineas.map(l => ({
                ...l,
                cantidad: Math.abs(parseFloat(l.cantidad)) || 0,
                precio_unitario: Math.abs(parseFloat(l.precio_unitario)) || 0,
                total: l.total != null ? parseFloat(l.total) : null
            }));

            // ── Matching de ingredientes (misma lógica que POST /purchases/pending) ──
            const normalizar = (str) => {
                return (str || '')
                    .toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^a-z0-9\s]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            const ingredientesResult = await pool.query(
                'SELECT id, nombre FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL',
                [req.restauranteId]
            );
            const ingredientesMap = new Map();
            ingredientesResult.rows.forEach(i => {
                ingredientesMap.set(normalizar(i.nombre), i.id);
            });

            const aliasResult = await pool.query(
                `SELECT a.alias, a.ingrediente_id FROM ingredientes_alias a 
                 JOIN ingredientes i ON a.ingrediente_id = i.id
                 WHERE a.restaurante_id = $1`,
                [req.restauranteId]
            );
            const aliasMap = new Map();
            aliasResult.rows.forEach(a => {
                aliasMap.set(normalizar(a.alias), a.ingrediente_id);
            });

            // ── Preparar INSERT en compras_pendientes ──
            const batchId = crypto.randomUUID();

            const values = [];
            const placeholders = [];
            let paramIdx = 1;
            let matched = 0;
            let totalImporte = 0;
            const resolvedIngredientIds = [];

            for (const linea of data.lineas) {
                const nombreNorm = normalizar(linea.producto);
                let ingredienteId = null;

                // 4 niveles de búsqueda
                ingredienteId = ingredientesMap.get(nombreNorm) || null;
                if (!ingredienteId) {
                    for (const [nombreDB, id] of ingredientesMap) {
                        if (nombreDB.includes(nombreNorm) || nombreNorm.includes(nombreDB)) {
                            ingredienteId = id;
                            break;
                        }
                    }
                }
                if (!ingredienteId) {
                    ingredienteId = aliasMap.get(nombreNorm) || null;
                }
                if (!ingredienteId) {
                    for (const [aliasNombre, id] of aliasMap) {
                        if (aliasNombre.includes(nombreNorm) || nombreNorm.includes(aliasNombre)) {
                            ingredienteId = id;
                            break;
                        }
                    }
                }

                if (ingredienteId) {
                    matched++;
                    resolvedIngredientIds.push(ingredienteId);
                }

                const precio = Math.abs(parseFloat(linea.precio_unitario)) || 0;
                const cantidad = Math.abs(parseFloat(linea.cantidad)) || 0;
                totalImporte += parseFloat(linea.total) || (precio * cantidad);

                placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9})`);
                values.push(batchId, linea.producto, ingredienteId, precio, cantidad, fecha, req.restauranteId, data.proveedor || null, data.numero_factura || null, imageHash);
                paramIdx += 10;
            }

            // 🔍 Check for duplicate albaran before inserting (using resolved ingredient IDs)
            const duplicateWarning = await checkDuplicateAlbaran(
                pool, req.restauranteId, resolvedIngredientIds, fecha
            );

            // 🔒 BLOCK insertion if duplicate detected (not just a warning)
            if (duplicateWarning && duplicateWarning.similarity >= 70) {
                log('warn', 'Duplicate albaran blocked by checkDuplicateAlbaran', {
                    existingBatchId: duplicateWarning.batchId,
                    newBatchId: batchId,
                    similarity: duplicateWarning.similarity,
                    source: duplicateWarning.source
                });
                return res.json({
                    success: true,
                    batchId: duplicateWarning.batchId,
                    proveedor: data.proveedor || null,
                    fecha,
                    totalItems: data.lineas.length,
                    matched,
                    unmatched: data.lineas.length - matched,
                    totalImporte: Math.round(totalImporte * 100) / 100,
                    duplicateWarning
                });
            }

            // 🔒 Server-side dedup: reject if ANY batch was created in last 2 minutes
            // OCR produces different spellings each scan, so comparing names is unreliable.
            // Physically impossible to scan 2 different albaranes in under 2 minutes.
            const recentBatch = await pool.query(
                `SELECT batch_id, COUNT(*) as item_count
                 FROM compras_pendientes
                 WHERE restaurante_id = $1
                   AND created_at >= NOW() - INTERVAL '2 minutes'
                 GROUP BY batch_id
                 LIMIT 1`,
                [req.restauranteId]
            );

            if (recentBatch.rows.length > 0) {
                const existing = recentBatch.rows[0];
                log('warn', 'Duplicate albaran rejected (cooldown 2 min)', {
                    existingBatchId: existing.batch_id, newBatchId: batchId
                });
                return res.json({
                    success: true,
                    batchId: existing.batch_id,
                    proveedor: data.proveedor || null,
                    fecha,
                    totalItems: data.lineas.length,
                    matched,
                    unmatched: data.lineas.length - matched,
                    totalImporte: Math.round(totalImporte * 100) / 100,
                    duplicateWarning: {
                        batchId: existing.batch_id,
                        fecha,
                        itemCount: parseInt(existing.item_count),
                        similarity: 100,
                        source: 'recent_duplicate'
                    }
                });
            }

            if (placeholders.length > 0) {
                await pool.query(
                    `INSERT INTO compras_pendientes (batch_id, ingrediente_nombre, ingrediente_id, precio, cantidad, fecha, restaurante_id, proveedor, numero_factura, image_hash)
                     VALUES ${placeholders.join(', ')}`,
                    values
                );
            }

            log('info', 'Albarán escaneado y pendientes creados', {
                batchId, proveedor: data.proveedor, fecha, items: data.lineas.length, matched
            });

            const albaranResponse = {
                success: true,
                batchId,
                proveedor: data.proveedor || null,
                fecha,
                totalItems: data.lineas.length,
                matched,
                unmatched: data.lineas.length - matched,
                totalImporte: Math.round(totalImporte * 100) / 100
            };
            if (duplicateWarning) {
                albaranResponse.duplicateWarning = duplicateWarning;
                log('info', 'Duplicate albaran detected', { batchId, duplicate: duplicateWarning });
            }
            res.json(albaranResponse);
        } catch (err) {
            log('error', 'Error procesando albarán', { error: err.message });
            res.status(500).json({ error: 'Error interno procesando albarán' });
        }
    });

    // ==========================================
    // 🔔 COMPRAS PENDIENTES (Cola de revisión)
    // ==========================================

    // POST: n8n envía compras aquí (van a cola de revisión, NO directamente al diario)
    router.post('/purchases/pending', authMiddleware, async (req, res) => {
        try {
            const { compras } = req.body;

            if (!Array.isArray(compras) || compras.length === 0) {
                return res.status(400).json({
                    error: 'Formato inválido: se esperaba un array "compras" no vacío',
                    ejemplo: { compras: [{ ingrediente: "Pulpo", precio: 26, cantidad: 10, fecha: "2025-12-17" }] }
                });
            }

            // Generar batch_id único para agrupar items del mismo albarán
            const batchId = require('crypto').randomUUID();

            // Función para normalizar nombres
            const normalizar = (str) => {
                return (str || '')
                    .toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^a-z0-9\s]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            // Obtener ingredientes y alias para matching
            const ingredientesResult = await pool.query(
                'SELECT id, nombre FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL',
                [req.restauranteId]
            );
            const ingredientesMap = new Map();
            ingredientesResult.rows.forEach(i => {
                ingredientesMap.set(normalizar(i.nombre), i.id);
            });

            const aliasResult = await pool.query(
                `SELECT a.alias, a.ingrediente_id FROM ingredientes_alias a 
             JOIN ingredientes i ON a.ingrediente_id = i.id
             WHERE a.restaurante_id = $1`,
                [req.restauranteId]
            );
            const aliasMap = new Map();
            aliasResult.rows.forEach(a => {
                aliasMap.set(normalizar(a.alias), a.ingrediente_id);
            });

            const resultados = { recibidos: 0, batchId };
            const values = [];
            const placeholders = [];
            let paramIdx = 1;

            for (const compra of compras) {
                const nombreNorm = normalizar(compra.ingrediente);
                let ingredienteId = null;

                // Búsqueda exacta
                ingredienteId = ingredientesMap.get(nombreNorm) || null;

                // Búsqueda parcial en ingredientes
                if (!ingredienteId) {
                    for (const [nombreDB, id] of ingredientesMap) {
                        if (nombreDB.includes(nombreNorm) || nombreNorm.includes(nombreDB)) {
                            ingredienteId = id;
                            break;
                        }
                    }
                }

                // Búsqueda en alias
                if (!ingredienteId) {
                    ingredienteId = aliasMap.get(nombreNorm) || null;
                }

                // Búsqueda parcial en alias
                if (!ingredienteId) {
                    for (const [aliasNombre, id] of aliasMap) {
                        if (aliasNombre.includes(nombreNorm) || nombreNorm.includes(aliasNombre)) {
                            ingredienteId = id;
                            break;
                        }
                    }
                }

                const precio = Math.abs(parseFloat(compra.precio)) || 0;
                const cantidad = Math.abs(parseFloat(compra.cantidad)) || 0;
                let fecha = compra.fecha || new Date().toISOString().split('T')[0];

                // ⚡ Robust date parsing: handles DD-MM-YY, YY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, etc.
                if (typeof fecha === 'string') {
                    const origFecha = fecha;
                    // Normalize separators: / . → -
                    fecha = fecha.replace(/[/.]/g, '-').trim();

                    // Already YYYY-MM-DD — keep as is
                    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(fecha)) {
                        // valid, keep
                    }
                    // DD-MM-YYYY or D-M-YYYY
                    else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(fecha)) {
                        const pts = fecha.split('-');
                        fecha = `${pts[2]}-${pts[1].padStart(2, '0')}-${pts[0].padStart(2, '0')}`;
                    }
                    // Ambiguous XX-YY-ZZ (all 1-2 digits) — could be DD-MM-YY or YY-MM-DD
                    else if (/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(fecha)) {
                        const pts = fecha.split('-');
                        const a = parseInt(pts[0]), b = parseInt(pts[1]), c = parseInt(pts[2]);
                        const now = new Date(); now.setHours(0, 0, 0, 0);

                        const currentYear = now.getFullYear();

                        // Interpretation 1: DD-MM-YY (European)
                        let y1 = (c < 100 ? c + 2000 : c);
                        if (y1 < currentYear - 1) y1 = currentYear; // correct old years
                        const dmy = `${y1}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
                        const dmyValid = b >= 1 && b <= 12 && a >= 1 && a <= 31;

                        // Interpretation 2: YY-MM-DD (short ISO)
                        let y2 = (a < 100 ? a + 2000 : a);
                        if (y2 < currentYear - 1) y2 = currentYear; // correct old years
                        const ymd = `${y2}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
                        const ymdValid = b >= 1 && b <= 12 && c >= 1 && c <= 31;

                        if (dmyValid && ymdValid) {
                            // Both valid — pick the one closest to today
                            const dmyDiff = Math.abs(new Date(dmy + 'T00:00:00') - now);
                            const ymdDiff = Math.abs(new Date(ymd + 'T00:00:00') - now);
                            fecha = ymdDiff <= dmyDiff ? ymd : dmy;
                        } else if (dmyValid) {
                            fecha = dmy;
                        } else if (ymdValid) {
                            fecha = ymd;
                        } else {
                            // Fallback: DD-MM-YY
                            fecha = dmy;
                        }

                        log('info', 'Date parsed from ambiguous format', { original: origFecha, result: fecha, dmyCandidate: dmy, ymdCandidate: ymd });
                    }

                    // Sanity: year must be >= 2020, otherwise use current year
                    const ym = fecha.match(/^(\d{4})/);
                    if (ym && parseInt(ym[1]) < 2020) {
                        const currentYear = new Date().getFullYear();
                        fecha = fecha.replace(/^\d{4}/, String(currentYear));
                        log('warn', 'Date year corrected', { original: origFecha, corrected: fecha });
                    }
                }


                placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`);
                values.push(batchId, compra.ingrediente, ingredienteId, precio, cantidad, fecha, req.restauranteId);
                paramIdx += 7;
                resultados.recibidos++;
            }


            // ══════════════════════════════════════════════════════════
            // 🔍 DEDUPLICATION: Block duplicate albaranes BEFORE insert
            // Uses 3 layers — tolerant of OCR variations from Gemini
            // ══════════════════════════════════════════════════════════

            let duplicateWarning = null;

            // Get ALL recent pending/approved items for comparison
            const recentPending = await pool.query(
                `SELECT batch_id, fecha, ingrediente_nombre, ingrediente_id, cantidad, precio,
                        COUNT(*) OVER (PARTITION BY batch_id) as batch_size
                 FROM compras_pendientes
                 WHERE restaurante_id = $1
                   AND estado IN ('pendiente', 'aprobado')
                   AND created_at >= NOW() - INTERVAL '7 days'
                 ORDER BY batch_id`,
                [req.restauranteId]
            );

            if (recentPending.rows.length > 0) {
                // Group existing items by batch
                const existingBatches = new Map();
                for (const row of recentPending.rows) {
                    if (!existingBatches.has(row.batch_id)) {
                        existingBatches.set(row.batch_id, { items: [], fecha: row.fecha, size: Number(row.batch_size) });
                    }
                    existingBatches.get(row.batch_id).items.push(row);
                }

                // Build new albaran data for comparison
                const newItemCount = compras.length;
                const newTotal = compras.reduce((sum, c) => sum + (Math.abs(parseFloat(c.precio)) || 0) * (Math.abs(parseFloat(c.cantidad)) || 0), 0);
                const newPairs = compras.map(c => ({
                    qty: Math.abs(parseFloat(c.cantidad)) || 0,
                    price: Math.abs(parseFloat(c.precio)) || 0
                })).sort((a, b) => a.qty - b.qty || a.price - b.price);

                for (const [existingBatchId, batch] of existingBatches) {
                    // ── Layer 1: Item count + total amount (fast pre-filter) ──
                    // If item count differs by more than 1 or total differs by more than 15%, skip
                    const existingTotal = batch.items.reduce((sum, i) => sum + Number(i.precio) * Number(i.cantidad), 0);
                    if (Math.abs(batch.size - newItemCount) > 1) continue;
                    if (existingTotal > 0 && newTotal > 0) {
                        const totalDiff = Math.abs(existingTotal - newTotal) / Math.max(existingTotal, newTotal);
                        if (totalDiff > 0.15) continue;
                    }

                    // ── Layer 2: Fuzzy qty+price pair matching ──
                    // Compare sorted (qty, price) pairs with ±10% tolerance
                    // This works even when Gemini produces slightly different product names
                    const existingPairs = batch.items.map(i => ({
                        qty: Number(i.cantidad),
                        price: Number(i.precio)
                    })).sort((a, b) => a.qty - b.qty || a.price - b.price);

                    let matchedPairs = 0;
                    const usedExisting = new Set();
                    for (const newPair of newPairs) {
                        for (let j = 0; j < existingPairs.length; j++) {
                            if (usedExisting.has(j)) continue;
                            const ep = existingPairs[j];
                            const qtyMatch = newPair.qty === 0 && ep.qty === 0 ||
                                (newPair.qty > 0 && ep.qty > 0 && Math.abs(newPair.qty - ep.qty) / Math.max(newPair.qty, ep.qty) <= 0.10);
                            const priceMatch = newPair.price === 0 && ep.price === 0 ||
                                (newPair.price > 0 && ep.price > 0 && Math.abs(newPair.price - ep.price) / Math.max(newPair.price, ep.price) <= 0.10);
                            if (qtyMatch && priceMatch) {
                                matchedPairs++;
                                usedExisting.add(j);
                                break;
                            }
                        }
                    }

                    const pairSimilarity = matchedPairs / Math.max(newPairs.length, existingPairs.length);
                    if (pairSimilarity >= 0.7) {
                        duplicateWarning = {
                            batchId: existingBatchId,
                            fecha: batch.fecha,
                            itemCount: batch.size,
                            similarity: Math.round(pairSimilarity * 100),
                            source: 'qty_price_match'
                        };
                        break;
                    }

                    // ── Layer 3: Ingredient ID overlap (when both batches have matched IDs) ──
                    const resolvedIds = values
                        .filter((_, i) => i % 7 === 2)
                        .filter(Boolean)
                        .map(Number);
                    const existingIds = batch.items
                        .filter(i => i.ingrediente_id)
                        .map(i => Number(i.ingrediente_id));

                    if (resolvedIds.length > 0 && existingIds.length > 0) {
                        const newIdSet = new Set(resolvedIds);
                        const existingIdSet = new Set(existingIds);
                        let overlap = 0;
                        for (const id of newIdSet) { if (existingIdSet.has(id)) overlap++; }
                        const idSimilarity = overlap / Math.max(newIdSet.size, existingIdSet.size);
                        if (idSimilarity >= 0.7) {
                            duplicateWarning = {
                                batchId: existingBatchId,
                                fecha: batch.fecha,
                                itemCount: batch.size,
                                similarity: Math.round(idSimilarity * 100),
                                source: 'ingredient_ids'
                            };
                            break;
                        }
                    }
                }
            }

            // 🔒 BLOCK insertion if duplicate detected
            if (duplicateWarning) {
                log('warn', 'Duplicate purchase BLOCKED (not inserted)', { batchId, duplicate: duplicateWarning });
                return res.status(409).json({
                    error: 'Albarán duplicado detectado',
                    duplicateWarning,
                    batchId
                });
            }

            if (placeholders.length > 0) {
                await pool.query(
                    `INSERT INTO compras_pendientes (batch_id, ingrediente_nombre, ingrediente_id, precio, cantidad, fecha, restaurante_id)
                 VALUES ${placeholders.join(', ')}`,
                    values
                );
            }

            log('info', 'Compras pendientes recibidas', { batchId, items: resultados.recibidos });
            res.json(resultados);
        } catch (err) {
            log('error', 'Error recibiendo compras pendientes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // GET: Listar compras pendientes
    router.get('/purchases/pending', authMiddleware, async (req, res) => {
        try {
            const { estado } = req.query;
            let query = `
            SELECT cp.*, i.nombre as ingrediente_nombre_db, i.unidad, i.proveedor_id as ingrediente_proveedor_id,
                   i.formato_compra as ingrediente_formato_compra, i.cantidad_por_formato as ingrediente_cantidad_por_formato
            FROM compras_pendientes cp
            LEFT JOIN ingredientes i ON cp.ingrediente_id = i.id
            WHERE cp.restaurante_id = $1`;
            const params = [req.restauranteId];

            if (estado) {
                query += ' AND cp.estado = $2';
                params.push(estado);
            } else {
                query += " AND cp.estado = 'pendiente'";
            }

            query += ' ORDER BY cp.created_at DESC, cp.batch_id, cp.ingrediente_nombre';

            const result = await pool.query(query, params);
            const rows = result.rows;

            // NOTE: Per-item duplicate detection removed — caused constant false positives
            // for restaurants with multiple daily deliveries from the same supplier.
            // Duplicate detection now ONLY happens at parse time via checkDuplicateAlbaran()
            // which uses product-name fingerprinting (≥70% similarity) + date proximity (±2 days).

            // Limpiar campo interno antes de enviar
            rows.forEach(r => delete r.ingrediente_proveedor_id);
            res.json(rows);
        } catch (err) {
            log('error', 'Error listando compras pendientes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // PATCH: Actualizar formato_override de un item pendiente + recalcular precio
    router.patch('/purchases/pending/:id/formato', authMiddleware, async (req, res) => {
        try {
            const { formato_override } = req.body;
            if (formato_override === undefined || formato_override === null || Number(formato_override) <= 0) {
                return res.status(400).json({ error: 'formato_override debe ser un número positivo' });
            }

            // Obtener item actual + datos del ingrediente para recalcular precio
            const itemResult = await pool.query(
                `SELECT cp.id, cp.ingrediente_id, cp.precio, i.precio as ingrediente_precio, i.cantidad_por_formato
                 FROM compras_pendientes cp
                 LEFT JOIN ingredientes i ON cp.ingrediente_id = i.id
                 WHERE cp.id = $1 AND cp.restaurante_id = $2 AND cp.estado = 'pendiente'`,
                [req.params.id, req.restauranteId]
            );

            if (itemResult.rows.length === 0) {
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            const item = itemResult.rows[0];
            const cantidadPorFormato = parseFloat(item.cantidad_por_formato) || 1;
            const precioFormato = parseFloat(item.ingrediente_precio) || 0;
            const nuevoFormato = Number(formato_override);

            // Recalcular precio: ingrediente.precio es siempre el precio por formato_compra (ej: por CAJA)
            // Si el usuario elige unidad (×1): precio = precioFormato / cantidadPorFormato
            // Si el usuario elige formato completo (×N): precio = precioFormato
            let nuevoPrecio = item.precio; // fallback: no cambiar si no hay datos
            if (precioFormato > 0 && cantidadPorFormato > 1) {
                if (nuevoFormato === 1) {
                    // Unidad individual: dividir precio del formato entre cantidad por formato
                    nuevoPrecio = +(precioFormato / cantidadPorFormato).toFixed(4);
                } else {
                    // Formato completo: usar precio del formato tal cual
                    nuevoPrecio = precioFormato;
                }
            }

            const result = await pool.query(
                `UPDATE compras_pendientes SET formato_override = $1, precio = $2
                 WHERE id = $3 AND restaurante_id = $4 AND estado = 'pendiente'
                 RETURNING id, formato_override, precio`,
                [nuevoFormato, nuevoPrecio, req.params.id, req.restauranteId]
            );

            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando formato_override', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST: Aprobar un item pendiente → insertar en precios_compra_diarios + actualizar stock
    router.post('/purchases/pending/:id/approve', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Obtener el item pendiente
            const itemResult = await client.query(
                "SELECT * FROM compras_pendientes WHERE id = $1 AND restaurante_id = $2 AND estado = 'pendiente' FOR UPDATE",
                [req.params.id, req.restauranteId]
            );

            if (itemResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            const item = itemResult.rows[0];

            if (!item.ingrediente_id) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'El item no tiene ingrediente asignado. Edítalo primero.' });
            }

            const total = item.precio * item.cantidad;

            // Resolver proveedor: texto OCR → proveedor_id, fallback a proveedor principal
            const proveedorId = await resolveProveedorId(client, {
                proveedorTexto: item.proveedor,
                ingredienteId: item.ingrediente_id,
                restauranteId: req.restauranteId
            });

            // Insertar en precios_compra_diarios con proveedor
            await upsertCompraDiaria(client, {
                ingredienteId: item.ingrediente_id,
                fecha: item.fecha,
                precioUnitario: item.precio,
                cantidad: item.cantidad,
                total,
                restauranteId: req.restauranteId,
                proveedorId
            });

            // Actualizar precio en ingredientes_proveedores para tracking de precios
            await updateProveedorPrecio(client, {
                ingredienteId: item.ingrediente_id,
                proveedorId,
                precio: item.precio
            });

            // Actualizar stock — usar formato_override si el usuario lo configuró,
            // si no, usar cantidad_por_formato del ingrediente (consistente con pedidos manuales y n8n)
            const ingRow = await client.query('SELECT id, cantidad_por_formato FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [item.ingrediente_id, req.restauranteId]);
            const cantidadPorFormato = parseFloat(ingRow.rows[0]?.cantidad_por_formato) || 1;
            const formato = parseFloat(item.formato_override) || cantidadPorFormato;
            const stockASumar = item.cantidad * formato;

            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                [stockASumar, item.ingrediente_id, req.restauranteId]
            );

            // Marcar como aprobado
            await client.query(
                "UPDATE compras_pendientes SET estado = 'aprobado', aprobado_at = NOW() WHERE id = $1 AND restaurante_id = $2",
                [req.params.id, req.restauranteId]
            );

            await client.query('COMMIT');
            log('info', 'Compra pendiente aprobada', { id: req.params.id, ingredienteId: item.ingrediente_id, proveedorId });
            res.json({ success: true, message: 'Compra aprobada y registrada' });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error aprobando compra pendiente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // POST: Aprobar todos los items de un batch
    router.post('/purchases/pending/approve-batch', authMiddleware, requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            const { batchId } = req.body;
            if (!batchId) {
                return res.status(400).json({ error: 'batchId requerido' });
            }

            await client.query('BEGIN');

            // Obtener items pendientes del batch
            const itemsResult = await client.query(
                "SELECT * FROM compras_pendientes WHERE batch_id = $1 AND restaurante_id = $2 AND estado = 'pendiente' FOR UPDATE",
                [batchId, req.restauranteId]
            );

            if (itemsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'No hay items pendientes en este batch' });
            }

            const resultados = { aprobados: 0, omitidos: 0 };

            for (const item of itemsResult.rows) {
                if (!item.ingrediente_id) {
                    resultados.omitidos++;
                    continue;
                }

                const total = item.precio * item.cantidad;

                // Resolver proveedor: texto OCR → proveedor_id, fallback a proveedor principal
                const proveedorId = await resolveProveedorId(client, {
                    proveedorTexto: item.proveedor,
                    ingredienteId: item.ingrediente_id,
                    restauranteId: req.restauranteId
                });

                // Insertar en precios_compra_diarios con proveedor
                await upsertCompraDiaria(client, {
                    ingredienteId: item.ingrediente_id,
                    fecha: item.fecha,
                    precioUnitario: item.precio,
                    cantidad: item.cantidad,
                    total,
                    restauranteId: req.restauranteId,
                    proveedorId
                });

                // Actualizar precio en ingredientes_proveedores para tracking de precios
                await updateProveedorPrecio(client, {
                    ingredienteId: item.ingrediente_id,
                    proveedorId,
                    precio: item.precio
                });

                // Actualizar stock — usar formato_override si el usuario lo configuró,
                // si no, usar cantidad_por_formato del ingrediente (consistente con pedidos manuales y n8n)
                const ingRow = await client.query('SELECT id, cantidad_por_formato FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [item.ingrediente_id, req.restauranteId]);
                const cantidadPorFormato = parseFloat(ingRow.rows[0]?.cantidad_por_formato) || 1;
                const formato = parseFloat(item.formato_override) || cantidadPorFormato;
                const stockASumar = item.cantidad * formato;

                await client.query(
                    'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                    [stockASumar, item.ingrediente_id, req.restauranteId]
                );

                // Marcar como aprobado
                await client.query(
                    "UPDATE compras_pendientes SET estado = 'aprobado', aprobado_at = NOW() WHERE id = $1 AND restaurante_id = $2",
                    [item.id, req.restauranteId]
                );

                resultados.aprobados++;
            }

            await client.query('COMMIT');
            log('info', 'Batch de compras aprobado', { batchId, aprobados: resultados.aprobados, omitidos: resultados.omitidos });

            // ── Sync approved data to Google Sheets via n8n webhook (fire-and-forget) ──
            // Only fires AFTER approval with final edited data
            const webhookUrl = process.env.N8N_ALBARAN_WEBHOOK_URL;
            if (webhookUrl && resultados.aprobados > 0) {
                const approvedItems = itemsResult.rows.filter(i => i.ingrediente_id);

                // Get proveedor and numero_factura from batch (stored at parse time)
                const proveedor = approvedItems.find(i => i.proveedor)?.proveedor || '';
                const numeroFactura = approvedItems.find(i => i.numero_factura)?.numero_factura || '';

                // Format date as DD/MM/YYYY from the stored fecha
                const fecha = approvedItems[0]?.fecha;
                let fechaSheets = '';
                if (fecha) {
                    const d = new Date(fecha);
                    const dd = String(d.getUTCDate()).padStart(2, '0');
                    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
                    const yyyy = d.getUTCFullYear();
                    fechaSheets = `${dd}/${mm}/${yyyy}`;
                }

                const totalImporte = approvedItems.reduce((sum, i) => sum + (i.precio * i.cantidad), 0);
                const totalFactura = Math.round(totalImporte * 100) / 100;

                // Build PRODUCTOS from final approved data
                const productos = approvedItems.map(i => ({
                    'Descripción': i.ingrediente_nombre || '',
                    'Cantidad': String(i.cantidad || 0),
                    'Unidad': 'ud',
                    'Contenido': null,
                    'Precio Unitario': String(i.precio || 0),
                    'Descuento_Porcentaje': '0',
                    'Importe_Descuento': '0.00',
                    'Importe_Final': String(Math.round((i.precio * i.cantidad) * 100) / 100)
                }));

                const rows = [{
                    'NUMERO DE FACTURA': numeroFactura,
                    'FECHA DE FACTURA': fechaSheets,
                    'REMITENTE': proveedor,
                    'DESCRIPCION': `Albarán ${proveedor || 'aprobado'} - ${approvedItems.length} productos`,
                    'CATEGORIA': '',
                    'IMPORTE SIN IVA': totalFactura,
                    'IVA': 0,
                    'TOTAL': totalFactura,
                    'MONEDA': 'EUR',
                    'PRODUCTOS': JSON.stringify(productos),
                    'LINK FACTURA': ''
                }];

                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows })
                }).catch(err => {
                    log('warn', 'Error enviando batch aprobado a n8n webhook (no-blocking)', { error: err.message });
                });
            }

            res.json(resultados);
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error aprobando batch', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // PUT: Editar un item pendiente (cambiar ingrediente_id, precio, cantidad)
    router.put('/purchases/pending/:id', authMiddleware, async (req, res) => {
        try {
            const { ingrediente_id, precio, cantidad, fecha } = req.body;

            // Verificar que el item existe y es pendiente
            const existing = await pool.query(
                "SELECT id FROM compras_pendientes WHERE id = $1 AND restaurante_id = $2 AND estado = 'pendiente'",
                [req.params.id, req.restauranteId]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            // Construir update dinámico
            const updates = [];
            const values = [];
            let paramIdx = 1;

            if (ingrediente_id !== undefined) {
                // Validar que el ingrediente existe y pertenece al restaurante
                const ingCheck = await pool.query(
                    'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
                    [ingrediente_id, req.restauranteId]
                );
                if (ingCheck.rows.length === 0) {
                    return res.status(400).json({ error: 'Ingrediente no válido' });
                }
                updates.push(`ingrediente_id = $${paramIdx++}`);
                values.push(ingrediente_id);
            }
            if (precio !== undefined) {
                updates.push(`precio = $${paramIdx++}`);
                values.push(Math.abs(parseFloat(precio)));
            }
            if (cantidad !== undefined) {
                updates.push(`cantidad = $${paramIdx++}`);
                values.push(Math.abs(parseFloat(cantidad)));
            }
            if (fecha !== undefined) {
                updates.push(`fecha = $${paramIdx++}`);
                values.push(fecha);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No se proporcionó nada para actualizar' });
            }

            values.push(req.params.id, req.restauranteId);
            await pool.query(
                `UPDATE compras_pendientes SET ${updates.join(', ')} WHERE id = $${paramIdx} AND restaurante_id = $${paramIdx + 1}`,
                values
            );

            res.json({ success: true, message: 'Item actualizado' });
        } catch (err) {
            log('error', 'Error editando compra pendiente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE: Rechazar/eliminar un item pendiente
    router.delete('/purchases/pending/:id', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                "UPDATE compras_pendientes SET estado = 'rechazado' WHERE id = $1 AND restaurante_id = $2 AND estado IN ('pendiente', 'aprobado') RETURNING id",
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Item no encontrado o ya procesado' });
            }

            res.json({ success: true, message: 'Item rechazado' });
        } catch (err) {
            log('error', 'Error rechazando compra pendiente', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // Admin: Corregir registro de compra diaria (precios_compra_diarios)
    router.put('/daily/purchases/correct', authMiddleware, async (req, res) => {
        try {
            const { ingredienteId, fecha, cantidad, total } = req.body;
            if (!ingredienteId || !fecha) {
                return res.status(400).json({ error: 'ingredienteId y fecha son obligatorios' });
            }
            const result = await pool.query(
                `UPDATE precios_compra_diarios 
                 SET cantidad_comprada = $1, total_compra = $2
                 WHERE ingrediente_id = $3 AND fecha = $4 AND restaurante_id = $5
                 RETURNING *`,
                [cantidad, total, ingredienteId, fecha, req.restauranteId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Registro no encontrado' });
            }
            log('info', 'Compra diaria corregida', { ingredienteId, fecha, cantidad, total });
            res.json({ success: true, updated: result.rows[0] });
        } catch (err) {
            log('error', 'Error corrigiendo compra diaria', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // Registrar compras diarias (bulk - para n8n, LEGACY — mantenido por compatibilidad)
    router.post('/daily/purchases/bulk', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { compras } = req.body;

            if (!Array.isArray(compras)) {
                return res.status(400).json({
                    error: 'Formato inválido: se esperaba un array "compras"',
                    ejemplo: { compras: [{ ingrediente: "Pulpo", precio: 26, cantidad: 10, fecha: "2025-12-17" }] }
                });
            }

            await client.query('BEGIN');

            const resultados = { procesados: 0, fallidos: 0, duplicados: 0, errores: [] };

            // Función para normalizar nombres (quitar acentos, mayúsculas, espacios extra)
            const normalizar = (str) => {
                return (str || '')
                    .toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
                    .replace(/[^a-z0-9\s]/g, '') // quitar caracteres especiales
                    .replace(/\s+/g, ' ') // espacios múltiples a uno
                    .trim();
            };

            // Obtener todos los ingredientes para búsqueda flexible (incluyendo cantidad_por_formato)
            const ingredientesResult = await client.query(
                'SELECT id, nombre, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL',
                [req.restauranteId]
            );
            const ingredientesMap = new Map();
            ingredientesResult.rows.forEach(i => {
                ingredientesMap.set(normalizar(i.nombre), { id: i.id, cantidadPorFormato: parseFloat(i.cantidad_por_formato) || 0 });
            });

            // Obtener todos los alias para búsqueda
            const aliasResult = await client.query(
                `SELECT a.alias, a.ingrediente_id, i.cantidad_por_formato 
             FROM ingredientes_alias a 
             JOIN ingredientes i ON a.ingrediente_id = i.id
             WHERE a.restaurante_id = $1`,
                [req.restauranteId]
            );
            const aliasMap = new Map();
            aliasResult.rows.forEach(a => {
                aliasMap.set(normalizar(a.alias), { id: a.ingrediente_id, cantidadPorFormato: parseFloat(a.cantidad_por_formato) || 0 });
            });

            for (const compra of compras) {
                const nombreNormalizado = normalizar(compra.ingrediente);
                let ingredienteData = ingredientesMap.get(nombreNormalizado);

                // Si no encuentra exacto, buscar coincidencia parcial
                if (!ingredienteData) {
                    for (const [nombreDB, data] of ingredientesMap) {
                        if (nombreDB.includes(nombreNormalizado) || nombreNormalizado.includes(nombreDB)) {
                            ingredienteData = data;
                            break;
                        }
                    }
                }

                // Si aún no encuentra, buscar en tabla de alias
                if (!ingredienteData) {
                    ingredienteData = aliasMap.get(nombreNormalizado);
                }

                // Si aún no encuentra, buscar alias con coincidencia parcial
                if (!ingredienteData) {
                    for (const [aliasNombre, data] of aliasMap) {
                        if (aliasNombre.includes(nombreNormalizado) || nombreNormalizado.includes(aliasNombre)) {
                            ingredienteData = data;
                            break;
                        }
                    }
                }

                if (!ingredienteData) {
                    resultados.fallidos++;
                    resultados.errores.push({ ingrediente: compra.ingrediente, error: 'Ingrediente no encontrado' });
                    continue;
                }

                const ingredienteId = ingredienteData.id;
                const cantidadPorFormato = ingredienteData.cantidadPorFormato;

                const precio = parseFloat(compra.precio) || 0;
                const cantidad = parseFloat(compra.cantidad) || 0;
                const total = precio * cantidad;
                // 🛡️ Fecha validation: if OCR produced garbage, use today
                let fecha = compra.fecha || null;
                if (fecha) {
                    const d = new Date(fecha);
                    if (isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2030) {
                        log('warn', 'Fecha inválida en compra bulk, usando hoy', { original: fecha, ingrediente: compra.ingrediente });
                        fecha = new Date().toISOString().split('T')[0];
                    }
                } else {
                    fecha = new Date().toISOString().split('T')[0];
                }

                // 🛡️ Deduplicación: si ya existe una compra de este ingrediente en esta fecha
                // (por ejemplo, desde un pedido manual), SKIP para no duplicar
                const existingPurchase = await client.query(
                    `SELECT id FROM precios_compra_diarios 
                 WHERE ingrediente_id = $1 AND fecha = $2 AND restaurante_id = $3
                 LIMIT 1`,
                    [ingredienteId, fecha, req.restauranteId]
                );

                if (existingPurchase.rows.length > 0) {
                    resultados.duplicados++;
                    continue;
                }

                // Insertar nueva compra (sin pedido_id = NULL → COALESCE default 0)
                await upsertCompraDiaria(client, {
                    ingredienteId,
                    fecha,
                    precioUnitario: precio,
                    cantidad, total,
                    restauranteId: req.restauranteId
                });

                // Solo actualizar stock, NO el precio (el precio solo se cambia manualmente)
                // Si tiene cantidad_por_formato, multiplicar: cantidad × cantidad_por_formato
                const stockASumar = cantidadPorFormato > 0 ? cantidad * cantidadPorFormato : cantidad;
                // ⚡ FIX Bug #8: Lock row before update to prevent race condition
                await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [ingredienteId, req.restauranteId]);
                await client.query(
                    'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                    [stockASumar, ingredienteId, req.restauranteId]
                );

                resultados.procesados++;
            }

            await client.query('COMMIT');
            log('info', 'Compras diarias importadas', { procesados: resultados.procesados, fallidos: resultados.fallidos, duplicados: resultados.duplicados });
            res.json(resultados);
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error importando compras diarias', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // Obtener resumen diario de ventas
    router.get('/daily/sales', authMiddleware, async (req, res) => {
        try {
            const { fecha, mes, ano } = req.query;
            let query = `
            SELECT v.*, r.nombre as receta_nombre, r.categoria
            FROM ventas_diarias_resumen v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1
        `;
            let params = [req.restauranteId];

            if (fecha) {
                query += ' AND v.fecha = $2';
                params.push(fecha);
            } else if (mes && ano) {
                const m = parseInt(mes), y = parseInt(ano);
                const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
                const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
                const endDate = `${ny}-${String(nm).padStart(2, '0')}-01`;
                query += ' AND v.fecha >= $2 AND v.fecha < $3';
                params.push(startDate, endDate);
            }

            query += ' ORDER BY v.fecha DESC, r.nombre';

            const result = await pool.query(query, params);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo ventas diarias', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    // Resumen mensual completo (formato tipo Excel)
    router.get('/monthly/summary', authMiddleware, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();

            // Obtener días del mes con compras (incluye proveedor con fallback a proveedor principal del ingrediente)
            const comprasDiarias = await pool.query(`
            SELECT 
                p.fecha,
                i.id as ingrediente_id,
                i.nombre as ingrediente,
                p.precio_unitario,
                p.cantidad_comprada,
                p.total_compra,
                COALESCE(pr.nombre, pr_fallback.nombre) as proveedor_nombre,
                COALESCE(p.proveedor_id, ip.proveedor_id) as proveedor_id
            FROM precios_compra_diarios p
            JOIN ingredientes i ON p.ingrediente_id = i.id
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            LEFT JOIN ingredientes_proveedores ip ON ip.ingrediente_id = p.ingrediente_id AND ip.es_proveedor_principal = true
            LEFT JOIN proveedores pr_fallback ON ip.proveedor_id = pr_fallback.id AND p.proveedor_id IS NULL
            WHERE p.restaurante_id = $1
              AND p.fecha >= $2 AND p.fecha < $3
            ORDER BY p.fecha, i.nombre
        `, [req.restauranteId, `${anoActual}-${String(mesActual).padStart(2, '0')}-01`, `${mesActual === 12 ? anoActual + 1 : anoActual}-${String(mesActual === 12 ? 1 : mesActual + 1).padStart(2, '0')}-01`]);

            // Obtener ventas directamente de la tabla ventas (agrupadas por día y receta)
            const ventasDiarias = await pool.query(`
            SELECT 
                DATE(v.fecha) as fecha,
                r.id as receta_id,
                r.nombre as receta,
                r.ingredientes as receta_ingredientes,
                SUM(v.cantidad) as cantidad_vendida,
                AVG(v.precio_unitario) as precio_venta_unitario,
                SUM(v.total) as total_ingresos
            FROM ventas v
            JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
              AND v.fecha >= $2 AND v.fecha < $3
            GROUP BY DATE(v.fecha), r.id, r.nombre, r.ingredientes
            ORDER BY DATE(v.fecha), r.nombre
        `, [req.restauranteId, `${anoActual}-${String(mesActual).padStart(2, '0')}-01`, `${mesActual === 12 ? anoActual + 1 : anoActual}-${String(mesActual === 12 ? 1 : mesActual + 1).padStart(2, '0')}-01`]);

            // Obtener precios de todos los ingredientes para calcular costes
            // CORREGIDO: Incluir cantidad_por_formato para calcular precio UNITARIO
            const ingredientesPrecios = await pool.query(
                'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL',
                [req.restauranteId]
            );
            const preciosMap = {};
            ingredientesPrecios.rows.forEach(ing => {
                const precio = parseFloat(ing.precio) || 0;
                const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
                // Precio unitario = precio del formato / cantidad en el formato
                preciosMap[ing.id] = precio / cantidadPorFormato;
            });

            // Función para calcular coste de una receta
            const calcularCosteReceta = (ingredientesReceta) => {
                if (!ingredientesReceta || !Array.isArray(ingredientesReceta)) return 0;
                return ingredientesReceta.reduce((sum, item) => {
                    const precio = preciosMap[item.ingredienteId] || 0;
                    const cantidad = parseFloat(item.cantidad) || 0;
                    return sum + (precio * cantidad);
                }, 0);
            };

            // Procesar datos en formato tipo Excel
            const ingredientesData = {};
            const recetasData = {};
            const diasSet = new Set();

            // Procesar compras
            comprasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                diasSet.add(fechaStr);

                if (!ingredientesData[row.ingrediente]) {
                    ingredientesData[row.ingrediente] = { id: row.ingrediente_id, dias: {}, total: 0, totalCantidad: 0 };
                }

                if (!ingredientesData[row.ingrediente].dias[fechaStr]) {
                    ingredientesData[row.ingrediente].dias[fechaStr] = {
                        precio: parseFloat(row.precio_unitario),
                        cantidad: parseFloat(row.cantidad_comprada),
                        total: parseFloat(row.total_compra)
                    };
                } else {
                    // ⚡ FIX: Acumular cantidades de múltiples pedidos del mismo día
                    const existing = ingredientesData[row.ingrediente].dias[fechaStr];
                    existing.cantidad += parseFloat(row.cantidad_comprada);
                    existing.total += parseFloat(row.total_compra);
                    // Precio unitario ponderado: total / cantidad
                    existing.precio = existing.cantidad > 0 ? existing.total / existing.cantidad : existing.precio;
                }
                ingredientesData[row.ingrediente].total += parseFloat(row.total_compra);
                ingredientesData[row.ingrediente].totalCantidad += parseFloat(row.cantidad_comprada);
            });

            // Agrupar compras por proveedor
            const proveedoresData = {};
            comprasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                const provNombre = row.proveedor_nombre || 'Sin proveedor';

                if (!proveedoresData[provNombre]) {
                    proveedoresData[provNombre] = { id: row.proveedor_id, dias: {}, total: 0 };
                }

                if (!proveedoresData[provNombre].dias[fechaStr]) {
                    proveedoresData[provNombre].dias[fechaStr] = 0;
                }
                proveedoresData[provNombre].dias[fechaStr] += parseFloat(row.total_compra);
                proveedoresData[provNombre].total += parseFloat(row.total_compra);
            });

            // Procesar ventas CON CÁLCULO DE COSTES
            ventasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                diasSet.add(fechaStr);

                const cantidadVendida = parseInt(row.cantidad_vendida);
                const totalIngresos = parseFloat(row.total_ingresos);

                // Calcular coste real desde ingredientes de la receta
                const costePorUnidad = calcularCosteReceta(row.receta_ingredientes);
                const costeTotal = costePorUnidad * cantidadVendida;
                const beneficio = totalIngresos - costeTotal;

                if (!recetasData[row.receta]) {
                    recetasData[row.receta] = { id: row.receta_id, dias: {}, totalVendidas: 0, totalIngresos: 0, totalCoste: 0, totalBeneficio: 0 };
                }

                recetasData[row.receta].dias[fechaStr] = {
                    vendidas: cantidadVendida,
                    precioVenta: parseFloat(row.precio_venta_unitario),
                    coste: costeTotal,
                    ingresos: totalIngresos,
                    beneficio: beneficio
                };
                recetasData[row.receta].totalVendidas += cantidadVendida;
                recetasData[row.receta].totalIngresos += totalIngresos;
                recetasData[row.receta].totalCoste += costeTotal;
                recetasData[row.receta].totalBeneficio += beneficio;
            });

            // Ordenar días
            const dias = Array.from(diasSet).sort();

            // Calcular totales generales
            const totalesCompras = Object.values(ingredientesData).reduce((sum, i) => sum + i.total, 0);
            const totalesVentas = Object.values(recetasData).reduce((sum, r) => sum + r.totalIngresos, 0);
            const totalesCostes = Object.values(recetasData).reduce((sum, r) => sum + r.totalCoste, 0);
            const totalesBeneficio = Object.values(recetasData).reduce((sum, r) => sum + r.totalBeneficio, 0);

            res.json({
                mes: mesActual,
                ano: anoActual,
                dias,
                compras: {
                    ingredientes: ingredientesData,
                    porProveedor: proveedoresData,
                    total: totalesCompras
                },
                ventas: {
                    recetas: recetasData,
                    totalIngresos: totalesVentas,
                    totalCostes: totalesCostes,
                    beneficioBruto: totalesBeneficio
                },
                resumen: {
                    margenBruto: totalesVentas > 0 ? ((totalesBeneficio / totalesVentas) * 100).toFixed(1) : 0,
                    foodCost: totalesVentas > 0 ? ((totalesCostes / totalesVentas) * 100).toFixed(1) : 0
                }
            });
        } catch (err) {
            log('error', 'Error resumen mensual', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });


    return router;
};
