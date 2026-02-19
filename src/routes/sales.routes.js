/**
 * sales Routes — Extracted from server.js
 * Sales CRUD, PDF parsing (Claude), bulk import with stock deduction
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const { validateCantidad } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== VENTAS ==========
    // ✅ PRODUCCIÓN: Rutas inline activas con descuento de inventario completo.
    router.get('/sales', authMiddleware, async (req, res) => {
        try {
            const { fecha, limit, page } = req.query;
            let query = 'SELECT v.*, r.nombre as receta_nombre FROM ventas v LEFT JOIN recetas r ON v.receta_id = r.id WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL';
            let params = [req.restauranteId];
            let paramIdx = 1;

            if (fecha) {
                paramIdx++;
                query += ` AND DATE(v.fecha) = $${paramIdx}`;
                params.push(fecha);
            }

            query += ' ORDER BY v.fecha DESC';

            if (limit) {
                const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
                const pageNum = Math.max(parseInt(page) || 1, 1);
                const offset = (pageNum - 1) * limitNum;

                let countQuery = 'SELECT COUNT(*) FROM ventas v WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL';
                const countParams = [req.restauranteId];
                if (fecha) {
                    countQuery += ' AND DATE(v.fecha) = $2';
                    countParams.push(fecha);
                }
                const countResult = await pool.query(countQuery, countParams);
                res.set('X-Total-Count', countResult.rows[0].count);

                paramIdx++;
                query += ` LIMIT $${paramIdx}`;
                params.push(limitNum);
                paramIdx++;
                query += ` OFFSET $${paramIdx}`;
                params.push(offset);
            }

            const result = await pool.query(query, params);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo ventas', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    router.post('/sales', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            // ⚡ Soportar ambos formatos: recetaId (camelCase) y receta_id (snake_case)
            const { recetaId: recetaIdCamel, receta_id, cantidad, varianteId: varianteIdCamel, variante_id, precioVariante, precio_unitario, fecha } = req.body;
            const recetaId = recetaIdCamel || receta_id;
            const varianteId = varianteIdCamel || variante_id;

            // 🔒 Validar recetaId requerido
            if (!recetaId) {
                return res.status(400).json({ error: 'recetaId es requerido' });
            }

            // Validar cantidad
            const cantidadValidada = validateCantidad(cantidad);
            if (cantidadValidada === 0) {
                return res.status(400).json({ error: 'Cantidad debe ser un número positivo' });
            }

            await client.query('BEGIN');

            const recetaResult = await client.query('SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2', [recetaId, req.restauranteId]);
            if (recetaResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Receta no encontrada' });
            }

            const receta = recetaResult.rows[0];

            // ⚡ NUEVO: Si hay variante, obtener su precio y factor
            let precioUnitario = parseFloat(receta.precio_venta);
            let factorVariante = 1;

            if (varianteId) {
                const varianteResult = await client.query(
                    'SELECT precio_venta, factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2 AND restaurante_id = $3',
                    [varianteId, recetaId, req.restauranteId]
                );
                if (varianteResult.rows.length > 0) {
                    const variante = varianteResult.rows[0];
                    precioUnitario = parseFloat(variante.precio_venta);
                    factorVariante = parseFloat(variante.factor) || 1;
                    log('info', 'Venta con variante', { varianteId, precio: precioUnitario, factor: factorVariante });
                }
            } else if (precioVariante && precioVariante > 0) {
                // Fallback: usar precio enviado desde frontend
                precioUnitario = precioVariante;
            }

            const total = precioUnitario * cantidadValidada;

            const ingredientesReceta = receta.ingredientes || [];
            /**
             * @deprecated VALIDACIÓN DE STOCK DESACTIVADA (desde 2025-12)
             * Motivo: Los restaurantes frecuentemente venden antes de recibir mercancía.
             * El stock negativo es un comportamiento esperado en este contexto.
             * Reactivar solo si se implementa un sistema de alertas de stock bajo.
             */
            /* VALIDACIÓN DESACTIVADA - Permitir stock negativo (restaurantes venden antes de recibir mercancía)
            for (const ing of ingredientesReceta) {
                const stockResult = await client.query('SELECT stock_actual, nombre FROM ingredientes WHERE id = $1', [ing.ingredienteId]);
                if (stockResult.rows.length > 0) {
                    const stockActual = parseFloat(stockResult.rows[0].stock_actual);
                    const stockNecesario = ing.cantidad * cantidad;
                    if (stockActual < stockNecesario) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({
                            error: `Stock insuficiente de ${stockResult.rows[0].nombre}: necesitas ${stockNecesario}, tienes ${stockActual}`
                        });
                    }
                }
            }
            */

            // 📅 Usar fecha proporcionada o NOW() por defecto
            const fechaVenta = fecha ? new Date(fecha) : new Date();

            // ⚡ FIX Bug #5: Guardar factor_variante para restaurar stock correctamente al borrar
            const ventaResult = await client.query(
                'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id, factor_variante, variante_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
                [recetaId, cantidadValidada, precioUnitario, total, fechaVenta, req.restauranteId, factorVariante, varianteId || null]
            );

            // ⚡ NUEVO: Aplicar factor de variante al descuento de stock
            // 🔧 FIX: Dividir por porciones - cada venta es 1 porción, no el lote completo
            const porciones = Math.max(1, parseInt(receta.porciones) || 1);
            const stockDeductions = []; // ⚡ FIX BUG-02: Rastrear descuentos reales
            for (const ing of ingredientesReceta) {
                // 🔧 FIX: Soportar múltiples formatos de ID de ingrediente
                const ingId = ing.ingredienteId || ing.ingrediente_id || ing.ingredientId || ing.id;
                const ingCantidad = ing.cantidad || ing.quantity || 0;

                if (!ingId) {
                    log('warn', 'Ingrediente sin ID en receta', { recetaId, ing });
                    continue;
                }

                // SELECT FOR UPDATE para prevenir race condition en ventas simultáneas
                const lockResult = await client.query(
                    'SELECT id, stock_actual FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                    [ingId, req.restauranteId]
                );
                const stockAntes = parseFloat(lockResult.rows[0]?.stock_actual) || 0;

                // Cantidad a descontar = (cantidad_receta ÷ porciones) × cantidad_vendida × factor_variante
                const cantidadADescontar = (ingCantidad / porciones) * cantidadValidada * factorVariante;
                const updateResult = await client.query(
                    'UPDATE ingredientes SET stock_actual = GREATEST(0, stock_actual - $1) WHERE id = $2 AND restaurante_id = $3 RETURNING stock_actual',
                    [cantidadADescontar, ingId, req.restauranteId]
                );
                const stockDespues = parseFloat(updateResult.rows[0]?.stock_actual) || 0;
                const descuentoReal = stockAntes - stockDespues;

                // ⚡ FIX BUG-02: Guardar el descuento REAL (no el calculado)
                stockDeductions.push({ ingredienteId: ingId, real: descuentoReal, calculado: cantidadADescontar });
                log('debug', 'Stock descontado', { ingredienteId: ingId, calculado: cantidadADescontar, real: descuentoReal });
            }

            // ⚡ FIX BUG-02: Guardar los descuentos reales en la venta
            if (stockDeductions.length > 0) {
                await client.query(
                    'UPDATE ventas SET stock_deductions = $1 WHERE id = $2',
                    [JSON.stringify(stockDeductions), ventaResult.rows[0].id]
                );
            }

            await client.query('COMMIT');
            res.status(201).json(ventaResult.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error registrando venta', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    router.delete('/sales/:id', authMiddleware, requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Obtener la venta antes de borrarla
            const ventaResult = await client.query(
                'SELECT * FROM ventas WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL',
                [req.params.id, req.restauranteId]
            );

            if (ventaResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Venta no encontrada o ya eliminada' });
            }

            const venta = ventaResult.rows[0];

            // 2. Restaurar stock — usar stock_deductions si existe (FIX BUG-02)
            if (venta.stock_deductions && Array.isArray(venta.stock_deductions)) {
                // ⚡ FIX BUG-02: Restaurar solo lo que se descontó REALMENTE
                for (const deduction of venta.stock_deductions) {
                    if (deduction.ingredienteId && deduction.real > 0) {
                        await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [deduction.ingredienteId, req.restauranteId]);
                        await client.query(
                            'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                            [deduction.real, deduction.ingredienteId, req.restauranteId]
                        );
                        log('info', 'Stock restaurado (descuento real)', {
                            ingredienteId: deduction.ingredienteId,
                            real: deduction.real,
                            calculado: deduction.calculado,
                            ventaId: venta.id
                        });
                    }
                }
            } else {
                // Fallback para ventas antiguas sin stock_deductions
                const recetaResult = await client.query(
                    'SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2',
                    [venta.receta_id, req.restauranteId]
                );

                if (recetaResult.rows.length > 0) {
                    const receta = recetaResult.rows[0];
                    const ingredientesReceta = receta.ingredientes || [];
                    const porciones = Math.max(1, parseInt(receta.porciones) || 1);
                    const factorVariante = parseFloat(venta.factor_variante) || 1;

                    for (const ing of ingredientesReceta) {
                        const ingId = ing.ingredienteId || ing.ingrediente_id || ing.ingredientId || ing.id;
                        if (ingId && ing.cantidad) {
                            const cantidadARestaurar = ((ing.cantidad || 0) / porciones) * venta.cantidad * factorVariante;
                            await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [ingId, req.restauranteId]);
                            await client.query(
                                'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                                [cantidadARestaurar, ingId, req.restauranteId]
                            );
                            log('info', 'Stock restaurado (fallback legacy)', {
                                ingredienteId: ingId,
                                cantidad: cantidadARestaurar,
                                ventaId: venta.id
                            });
                        }
                    }
                }
            }

            // 4. SOFT DELETE: marca como eliminado
            await client.query(
                'UPDATE ventas SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1',
                [req.params.id]
            );

            // 5. Actualizar ventas_diarias_resumen (restar la venta eliminada)
            const fechaVenta = new Date(venta.fecha).toISOString().split('T')[0];
            await client.query(`
            UPDATE ventas_diarias_resumen 
            SET cantidad_vendida = GREATEST(0, cantidad_vendida - $1),
                total_ingresos = GREATEST(0, total_ingresos - $2),
                coste_ingredientes = GREATEST(0, coste_ingredientes - $3),
                beneficio_bruto = GREATEST(0, total_ingresos - $2) - GREATEST(0, coste_ingredientes - $3)
            WHERE receta_id = $4 AND fecha = $5 AND restaurante_id = $6
        `, [venta.cantidad, parseFloat(venta.total) || 0, 0, venta.receta_id, fechaVenta, req.restauranteId]);

            await client.query('COMMIT');
            log('info', 'Venta eliminada con stock restaurado', { id: req.params.id });
            res.json({ message: 'Eliminado y stock restaurado', id: venta.id });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error eliminando venta', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });


    // ========== ENDPOINT: PARSEAR PDF DE TPV CON IA ==========
    // Recibe un PDF del TPV y extrae los datos de ventas usando Claude API
    router.post('/parse-pdf', authMiddleware, costlyApiLimiter, async (req, res) => {
        try {
            const { pdfBase64, filename } = req.body;

            if (!pdfBase64) {
                return res.status(400).json({ error: 'Se requiere pdfBase64' });
            }

            // Límite de tamaño: 10MB en base64 (~7.5MB archivo real)
            const MAX_PDF_SIZE = 10 * 1024 * 1024;
            if (pdfBase64.length > MAX_PDF_SIZE) {
                return res.status(413).json({ error: 'PDF demasiado grande. Máximo 10MB.' });
            }

            // API Key de Anthropic (configurar en variables de entorno)
            const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
            if (!ANTHROPIC_API_KEY) {
                return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' });
            }

            log('info', 'Procesando PDF con Claude API', { filename, tamaño: pdfBase64.length });

            // Llamar a Claude API con el PDF
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 32000,
                    messages: [{
                        role: 'user',
                        content: [
                            {
                                type: 'document',
                                source: {
                                    type: 'base64',
                                    media_type: 'application/pdf',
                                    data: pdfBase64
                                }
                            },
                            {
                                type: 'text',
                                text: `Extrae las líneas de venta de este informe de TPV.

PRIMERO, extrae la FECHA del documento (busca "Fecha:" o "Desde:" en el encabezado).

Retorna ÚNICAMENTE JSON válido sin explicaciones:
{
  "fecha": "2026-01-12",
  "ventas": [
    {"codigo": "00117", "descripcion": "CAÑA", "unidades": 67, "importe": 201.00, "familia": "BEBIDAS"}
  ]
}

REGLAS:
- La fecha debe estar en formato YYYY-MM-DD
- Solo líneas con código numérico de 5-6 dígitos
- Ignora líneas de TOTAL
- El importe usa punto decimal`
                            }
                        ]
                    }]
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                log('error', 'Error de Claude API', errorData);
                return res.status(500).json({ error: 'Error procesando PDF con IA' });
            }

            const claudeResponse = await response.json();
            let textContent = claudeResponse.content?.[0]?.text || '';

            // Limpiar respuesta de Claude (quitar markdown code blocks)
            textContent = textContent.replace(/```json/g, '').replace(/```/g, '').trim();

            // Extraer JSON
            const startIdx = textContent.indexOf('{');
            const endIdx = textContent.lastIndexOf('}');
            if (startIdx === -1 || endIdx === -1) {
                return res.status(500).json({ error: 'No se pudo extraer JSON de la respuesta de IA' });
            }

            const jsonStr = textContent.substring(startIdx, endIdx + 1);
            let data;
            try {
                data = JSON.parse(jsonStr);
            } catch (parseError) {
                log('error', 'Error parseando JSON de Claude', { error: parseError.message, rawText: textContent.substring(0, 500) });
                return res.status(500).json({ error: 'Error parseando respuesta de IA', details: parseError.message });
            }

            // Formatear para el frontend
            const fechaDocumento = data.fecha || new Date().toISOString().split('T')[0];
            const ventasFormateadas = (data.ventas || []).map(v => ({
                receta: v.descripcion,
                codigo_tpv: v.codigo,
                cantidad: parseInt(v.unidades) || 1,
                total: parseFloat(v.importe) || 0,
                fecha: fechaDocumento + 'T12:00:00.000Z'
            }));

            log('info', 'PDF procesado exitosamente', { fecha: fechaDocumento, ventas: ventasFormateadas.length });

            res.json({
                success: true,
                fecha: fechaDocumento,
                ventas: ventasFormateadas,
                totalVentas: ventasFormateadas.length,
                totalImporte: ventasFormateadas.reduce((sum, v) => sum + v.total, 0)
            });

        } catch (error) {
            log('error', 'Error procesando PDF', { error: error.message, stack: error.stack });
            res.status(500).json({ error: 'Error procesando PDF' });
        }
    });

    // Endpoint para carga masiva de ventas (n8n compatible)
    router.post('/sales/bulk', authMiddleware, requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            const { ventas } = req.body;

            if (!Array.isArray(ventas)) {
                return res.status(400).json({
                    error: 'Formato inválido: se esperaba un array "ventas"',
                    ejemplo: { ventas: [{ receta: "Nombre Plato", cantidad: 1 }] }
                });
            }

            // Obtener la fecha de las ventas (usar la primera venta o la fecha actual)
            const fechaVenta = ventas[0]?.fecha ? ventas[0].fecha.split('T')[0] : new Date().toISOString().split('T')[0];

            // Verificar si ya existen ventas para esta fecha (ignorar soft-deleted)
            const existingResult = await client.query(
                'SELECT COUNT(*) as count FROM ventas WHERE restaurante_id = $1 AND fecha::date = $2 AND deleted_at IS NULL',
                [req.restauranteId, fechaVenta]
            );

            if (parseInt(existingResult.rows[0].count) > 0) {
                client.release();
                return res.status(409).json({
                    error: 'Ya existen ventas para esta fecha',
                    fecha: fechaVenta,
                    mensaje: 'Para reemplazar los datos, primero elimine las ventas existentes de esta fecha',
                    ventasExistentes: parseInt(existingResult.rows[0].count)
                });
            }

            await client.query('BEGIN');

            const resultados = {
                procesados: 0,
                fallidos: 0,
                errores: []
            };

            // Obtener recetas y precios de ingredientes
            // Incluir campo codigo para mapeo con códigos del TPV
            const recetasResult = await client.query('SELECT id, nombre, precio_venta, ingredientes, codigo FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL', [req.restauranteId]);

            // Mapa por nombre (para compatibilidad)
            const recetasMapNombre = new Map();
            // Mapa por código TPV (prioridad)
            const recetasMapCodigo = new Map();

            recetasResult.rows.forEach(r => {
                recetasMapNombre.set(r.nombre.toLowerCase().trim(), r);
                // Mapear por código TPV si existe
                if (r.codigo && r.codigo.trim() !== '' && r.codigo !== 'SIN_TPV') {
                    recetasMapCodigo.set(r.codigo.trim(), r);
                }
            });

            // ⚡ NUEVO: También mapear códigos de variantes (COPA, BOTELLA, etc.)
            const variantesResult = await client.query(
                `SELECT rv.id as variante_id, rv.codigo, rv.factor, rv.nombre as variante_nombre, 
                    r.id as receta_id, r.nombre as receta_nombre, r.precio_venta, r.ingredientes
             FROM recetas_variantes rv
             JOIN recetas r ON rv.receta_id = r.id
             WHERE r.restaurante_id = $1 AND r.deleted_at IS NULL
             AND rv.codigo IS NOT NULL AND rv.codigo != ''`,
                [req.restauranteId]
            );

            // Mapa de código de variante -> {receta, variante_id, factor}
            const variantesMapCodigo = new Map();
            variantesResult.rows.forEach(v => {
                variantesMapCodigo.set(v.codigo.trim(), {
                    id: v.receta_id,
                    nombre: v.receta_nombre,
                    precio_venta: v.precio_venta,
                    ingredientes: v.ingredientes,
                    variante_id: v.variante_id,
                    variante_nombre: v.variante_nombre,
                    factor: parseFloat(v.factor) || 1
                });
            });

            // CORREGIDO: Incluir cantidad_por_formato para calcular precio UNITARIO
            const ingredientesResult = await client.query('SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1', [req.restauranteId]);
            const ingredientesPrecios = new Map();
            ingredientesResult.rows.forEach(i => {
                const precio = parseFloat(i.precio) || 0;
                const cantidadPorFormato = parseFloat(i.cantidad_por_formato) || 1;
                // Precio unitario = precio del formato / cantidad en el formato
                const precioUnitario = precio / cantidadPorFormato;
                ingredientesPrecios.set(i.id, precioUnitario);
            });

            // Acumulador para resumen diario
            const resumenDiario = new Map(); // key: "recetaId-fecha", value: { cantidad, ingresos, coste }

            for (const venta of ventas) {
                const nombreReceta = (venta.receta || '').toLowerCase().trim();
                const codigoTpv = (venta.codigo_tpv || venta.codigo || '').toString().trim();
                const cantidad = validateCantidad(venta.cantidad);
                const varianteId = venta.variante_id || null; // ⚡ NUEVO: Soporte para variantes

                if (cantidad === 0) {
                    resultados.fallidos++;
                    resultados.errores.push({ receta: venta.receta, error: 'Cantidad inválida' });
                    continue;
                }

                // Prioridad: buscar por código TPV, luego en variantes, luego por nombre
                let receta = null;
                let factorAplicado = 1;  // Factor por defecto
                let varianteEncontrada = null;

                if (codigoTpv && recetasMapCodigo.has(codigoTpv)) {
                    receta = recetasMapCodigo.get(codigoTpv);
                } else if (codigoTpv && variantesMapCodigo.has(codigoTpv)) {
                    // ⚡ Código encontrado en variantes (COPA, BOTELLA, etc.)
                    varianteEncontrada = variantesMapCodigo.get(codigoTpv);
                    receta = varianteEncontrada;  // Tiene los mismos campos que receta
                    factorAplicado = varianteEncontrada.factor;
                } else if (nombreReceta && recetasMapNombre.has(nombreReceta)) {
                    receta = recetasMapNombre.get(nombreReceta);
                }

                if (!receta) {
                    resultados.fallidos++;
                    resultados.errores.push({
                        receta: venta.receta,
                        codigo: codigoTpv || 'sin código',
                        error: 'Receta no encontrada'
                    });
                    continue;
                }

                // Si se pasó varianteId explícitamente, usarlo para obtener factor
                if (varianteId && !varianteEncontrada) {
                    const varianteResult = await client.query(
                        'SELECT factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2',
                        [varianteId, receta.id]
                    );
                    if (varianteResult.rows.length > 0) {
                        factorAplicado = parseFloat(varianteResult.rows[0].factor) || 1;
                    }
                }

                const precioVenta = parseFloat(receta.precio_venta);
                const total = parseFloat(venta.total) || (precioVenta * cantidad);
                const fecha = venta.fecha || new Date().toISOString();
                const fechaDate = fecha.split('T')[0]; // Solo la fecha sin hora

                // ⚠️ Warning para ventas con total ≤ 0 (posible anulación TPV o precio faltante)
                if (total <= 0) {
                    log('warn', 'Venta con total ≤ 0 detectada', {
                        receta: receta.nombre || receta.id,
                        cantidad,
                        precioVenta,
                        totalRecibido: venta.total,
                        totalCalculado: total,
                        fecha: fechaDate
                    });
                }

                // Calcular coste de ingredientes para esta venta (aplicando factor de variante)
                let costeIngredientes = 0;
                const ingredientesReceta = receta.ingredientes || [];
                if (Array.isArray(ingredientesReceta)) {
                    for (const ing of ingredientesReceta) {
                        const precioIng = ingredientesPrecios.get(ing.ingredienteId) || 0;
                        costeIngredientes += precioIng * (ing.cantidad || 0) * cantidad * factorAplicado;
                    }
                }

                // Registrar venta individual
                // ⚡ FIX Bug #5: Guardar factor_variante para restaurar stock correctamente al borrar
                await client.query(
                    'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id, factor_variante, variante_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [receta.id, cantidad, precioVenta, total, fecha, req.restauranteId, factorAplicado, varianteEncontrada ? varianteEncontrada.variante_id : null]
                );

                // Descontar stock (aplicando factor de variante)
                // 🔧 FIX: Dividir por porciones - cada venta es 1 porción, no el lote completo
                const porciones = Math.max(1, parseInt(receta.porciones) || 1);
                if (Array.isArray(ingredientesReceta) && ingredientesReceta.length > 0) {
                    for (const ing of ingredientesReceta) {
                        // Cantidad a descontar = (cantidad_receta ÷ porciones) × cantidad_vendida × factor
                        const cantidadADescontar = ((ing.cantidad || 0) / porciones) * cantidad * factorAplicado;
                        if (cantidadADescontar > 0 && ing.ingredienteId) {
                            // SELECT FOR UPDATE para prevenir race condition en ventas simultáneas
                            await client.query(
                                'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                                [ing.ingredienteId, req.restauranteId]
                            );
                            // ⚡ NUEVO: Multiplicar por factorAplicado (copa = 0.2 de botella)
                            const updateResult = await client.query(
                                'UPDATE ingredientes SET stock_actual = GREATEST(0, stock_actual - $1), ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3 RETURNING id, nombre, stock_actual',
                                [cantidadADescontar, ing.ingredienteId, req.restauranteId]
                            );
                            if (updateResult.rows.length > 0) {
                                log('info', 'Stock descontado', {
                                    ingrediente: updateResult.rows[0].nombre,
                                    cantidad: cantidadADescontar,
                                    nuevoStock: updateResult.rows[0].stock_actual
                                });
                            }
                        }
                    }
                }

                // Acumular para resumen diario
                const key = `${receta.id}-${fechaDate}`;
                if (!resumenDiario.has(key)) {
                    resumenDiario.set(key, {
                        recetaId: receta.id,
                        fecha: fechaDate,
                        precioVenta: precioVenta,
                        cantidad: 0,
                        ingresos: 0,
                        coste: 0
                    });
                }
                const resumen = resumenDiario.get(key);
                resumen.cantidad += cantidad;
                resumen.ingresos += total;
                resumen.coste += costeIngredientes;

                resultados.procesados++;
            }

            // Actualizar tabla ventas_diarias_resumen (upsert)
            for (const [key, data] of resumenDiario) {
                await client.query(`
                INSERT INTO ventas_diarias_resumen 
                (receta_id, fecha, cantidad_vendida, precio_venta_unitario, coste_ingredientes, total_ingresos, beneficio_bruto, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (receta_id, fecha, restaurante_id)
                DO UPDATE SET 
                    cantidad_vendida = ventas_diarias_resumen.cantidad_vendida + EXCLUDED.cantidad_vendida,
                    coste_ingredientes = ventas_diarias_resumen.coste_ingredientes + EXCLUDED.coste_ingredientes,
                    total_ingresos = ventas_diarias_resumen.total_ingresos + EXCLUDED.total_ingresos,
                    beneficio_bruto = ventas_diarias_resumen.beneficio_bruto + EXCLUDED.beneficio_bruto
            `, [
                    data.recetaId,
                    data.fecha,
                    data.cantidad,
                    data.precioVenta,
                    data.coste,
                    data.ingresos,
                    data.ingresos - data.coste,
                    req.restauranteId
                ]);
            }

            await client.query('COMMIT');

            log('info', 'Carga masiva ventas', {
                procesados: resultados.procesados,
                fallidos: resultados.fallidos,
                resumenesActualizados: resumenDiario.size
            });

            res.json(resultados);
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error carga masiva ventas', { error: err.message });
            res.status(500).json({ error: 'Error interno procesando carga masiva' });
        } finally {
            client.release();
        }
    });


    return router;
};
