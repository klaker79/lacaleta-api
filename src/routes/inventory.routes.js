/**
 * inventory Routes — Extracted from server.js
 * Advanced inventory: complete view, stock real updates, bulk updates, health check, consolidation
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validateNumber, validateId } = require('../utils/validators');
const { getBackendIngredientUnitPrice, computeInventoryDifference } = require('../utils/businessHelpers');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== INVENTARIO AVANZADO ==========
    // ========== 📉 DIFERENCIA DE INVENTARIO ==========
    // Cada recuento físico guarda en inventory_snapshots_v2 lo que el sistema creía
    // tener y lo que había de verdad. Se llevaba haciendo desde diciembre de 2025 —560
    // registros en La Nave 5— y NADIE lo leía: se calculaba y se tiraba.
    //
    // Este endpoint lo saca a la luz valorado en euros. NO corrige nada: el stock
    // virtual es una aproximación y el recuento es lo único que pone los dos mundos a
    // cero. Lo que mide es cuánto puedes fiarte de tu propio stock entre recuento y
    // recuento, que es una decisión de negocio, no un número técnico.
    router.get('/inventory/differences', authMiddleware, async (req, res) => {
        try {
            const lim = parseInt(req.query.limit, 10);
            const limite = Number.isFinite(lim) ? Math.min(50, Math.max(1, lim)) : 12;
            // 90 días por defecto. Con ventanas más largas el acumulado se contamina
            // con la carga INICIAL de stock (en La Nave 5, diciembre de 2025): dar de
            // alta el inventario por primera vez aparece como una diferencia positiva
            // enorme y le da la vuelta al signo del total (a 365 días sale +48.927 €
            // cuando la realidad de los últimos 90 es −39.199 €).
            const dias = Number.isFinite(parseInt(req.query.dias, 10))
                ? Math.min(730, Math.max(1, parseInt(req.query.dias, 10)))
                : 90;

            const result = await pool.query(`
            SELECT s.fecha, s.ingrediente_id, s.stock_virtual, s.stock_real, s.diferencia,
                   i.nombre, i.unidad, i.precio, i.cantidad_por_formato, i.precio_fijado,
                   pcd.precio_medio_compra
            FROM inventory_snapshots_v2 s
            JOIN ingredientes i ON i.id = s.ingrediente_id AND i.restaurante_id = $1
            LEFT JOIN (
                SELECT ingrediente_id,
                       ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) AS precio_medio_compra
                FROM precios_compra_diarios WHERE restaurante_id = $1
                GROUP BY ingrediente_id
            ) pcd ON pcd.ingrediente_id = s.ingrediente_id
            WHERE s.restaurante_id = $1
              AND s.fecha >= CURRENT_DATE - ($2 || ' days')::interval
            ORDER BY s.fecha DESC
        `, [req.restauranteId, String(dias)]);

            const sesiones = computeInventoryDifference(result.rows).slice(0, limite);

            // El frontend enseña el último recuento en grande y compara con el anterior:
            // lo que importa no es el número suelto, es si mejora o empeora.
            res.json({
                dias,
                sesiones,
                ultimo: sesiones[0] || null,
                anterior: sesiones[1] || null,
                // Acumulado del periodo: cuánto se ha desviado el stock en total.
                acumulado_eur: Math.round(sesiones.reduce((s, x) => s + x.neto_eur, 0) * 100) / 100,
                recuentos: sesiones.length
            });
        } catch (err) {
            log('error', 'Error en inventory/differences', { error: err.message });
            res.status(500).json({ error: 'Error interno', sesiones: [] });
        }
    });

    router.get('/inventory/complete', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(`
      SELECT
        i.id,
        i.nombre,
        i.unidad,
        i.stock_actual as stock_virtual,
        i.stock_real,
        i.stock_minimo,
        i.proveedor_id,
        i.ultima_actualizacion_stock,
        i.formato_compra,
        i.cantidad_por_formato,
        i.precio,
        i.precio_fijado,
        -- 🧹 2026-08-01: la familia viaja al frontend para que el Valor de Stock
        -- pueda separar género (alimento/bebida) de suministros. Guantes, servilletas
        -- y mantelillos entran por pedido pero no salen por ninguna receta, así que
        -- inflaban el valor de inventario sin techo (11.283 € en La Nave 5).
        -- valor_stock NO cambia de definición: quien decide qué sumar es el frontend.
        COALESCE(i.familia, 'alimento') AS familia,
        CASE
            WHEN i.stock_real IS NULL THEN NULL
            ELSE (i.stock_real - i.stock_actual)
        END as diferencia,
        -- Precio unitario config: precio / cantidad_por_formato (para valor stock)
        CASE
          WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0
          THEN i.precio / i.cantidad_por_formato
          ELSE i.precio
        END as precio_medio,
        -- Precio medio de compras reales (para coste de recetas)
        pcd_avg.precio_medio_compra,
        -- Valor stock = stock_actual x precio_unitario (siempre usa precio config)
        (i.stock_actual * CASE
          WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0
          THEN i.precio / i.cantidad_por_formato
          ELSE i.precio
        END) as valor_stock
      FROM ingredientes i
      LEFT JOIN (
        SELECT ingrediente_id,
               ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) as precio_medio_compra
        FROM precios_compra_diarios
        WHERE restaurante_id = $1
        GROUP BY ingrediente_id
      ) pcd_avg ON pcd_avg.ingrediente_id = i.id
      WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL
      ORDER BY i.id
    `, [req.restauranteId]);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error inventario completo', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    router.put('/inventory/:id/stock-real', authMiddleware, async (req, res) => {
        try {
            const { id } = req.params;
            const idCheck = validateId(id);
            if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

            const { stock_real } = req.body;

            const stockValidado = validateNumber(stock_real, 0, 0);
            if (stockValidado === null || stockValidado < 0) {
                return res.status(400).json({ error: 'Stock debe ser un número no negativo' });
            }

            const result = await pool.query(
                `UPDATE ingredientes 
       SET stock_real = $1, 
           ultima_actualizacion_stock = CURRENT_TIMESTAMP 
       WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL
       RETURNING *`,
                [stockValidado, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando stock real', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.put('/inventory/bulk-update-stock', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { stocks } = req.body;

            // C8: Validar input
            if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
                return res.status(400).json({ error: 'Se requiere un array "stocks" con items {id, stock_real}' });
            }

            await client.query('BEGIN');

            const updated = [];
            for (const item of stocks) {
                if (!item.id || item.stock_real === undefined) continue;
                const stockVal = parseFloat(item.stock_real);
                if (isNaN(stockVal) || stockVal < 0) continue;

                // 🛡️ Guardrail defensa-en-profundidad: rechazar valores absolutos
                //    absurdos (>10000). Coherente con bulk-adjust-stock (auditoria B4).
                if (stockVal > 10000) {
                    continue;
                }

                // C2: FOR UPDATE lock to prevent race condition
                // 🔒 deleted_at IS NULL en lock + UPDATE (auditoria A1-A3).
                await client.query(
                    'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL FOR UPDATE',
                    [item.id, req.restauranteId]
                );
                const result = await client.query(
                    `UPDATE ingredientes
         SET stock_real = $1,
             ultima_actualizacion_stock = CURRENT_TIMESTAMP
         WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL
         RETURNING *`,
                    [stockVal, item.id, req.restauranteId]
                );
                if (result.rows.length > 0) {
                    updated.push(result.rows[0]);
                }
            }

            await client.query('COMMIT');
            res.json({ success: true, updated: updated.length, items: updated });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error bulk update stock', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // 🏥 INVENTORY HEALTH CHECK — Detecta anomalías de stock
    router.get('/inventory/health-check', authMiddleware, async (req, res) => {
        try {
            const anomalies = [];

            // 1. Ingredientes con stock negativo
            const negRes = await pool.query(
                `SELECT id, nombre, stock_actual FROM ingredientes 
             WHERE restaurante_id = $1 AND deleted_at IS NULL AND stock_actual < 0`,
                [req.restauranteId]
            );
            negRes.rows.forEach(r => {
                anomalies.push({
                    type: 'negative_stock',
                    severity: 'critical',
                    ingredientId: r.id,
                    message: `${r.nombre}: stock negativo (${r.stock_actual})`
                });
            });

            // 2. Ingredientes con stock NULL
            const nullRes = await pool.query(
                `SELECT id, nombre FROM ingredientes 
             WHERE restaurante_id = $1 AND deleted_at IS NULL AND stock_actual IS NULL`,
                [req.restauranteId]
            );
            nullRes.rows.forEach(r => {
                anomalies.push({
                    type: 'null_stock',
                    severity: 'warning',
                    ingredientId: r.id,
                    message: `${r.nombre}: stock es NULL (debería ser 0)`
                });
            });

            // 3. Ingredientes con stock > 0 pero precio = 0 (valor invisible)
            const zeroPriceRes = await pool.query(
                `SELECT id, nombre, stock_actual FROM ingredientes 
             WHERE restaurante_id = $1 AND deleted_at IS NULL 
             AND stock_actual > 0 AND (precio IS NULL OR precio = 0)`,
                [req.restauranteId]
            );
            zeroPriceRes.rows.forEach(r => {
                anomalies.push({
                    type: 'stock_without_price',
                    severity: 'warning',
                    ingredientId: r.id,
                    message: `${r.nombre}: tiene ${r.stock_actual} en stock pero precio=0€`
                });
            });

            // 4. Calcular valor total del stock
            const valueRes = await pool.query(
                `SELECT COALESCE(SUM(
                COALESCE(stock_actual, 0) * COALESCE(precio, 0) / 
                GREATEST(COALESCE(cantidad_por_formato, 1), 1)
             ), 0) as total_value,
             COUNT(*) as total_items,
             COUNT(*) FILTER (WHERE stock_actual > 0) as items_with_stock
             FROM ingredientes 
             WHERE restaurante_id = $1 AND deleted_at IS NULL`,
                [req.restauranteId]
            );

            const { total_value, total_items, items_with_stock } = valueRes.rows[0];

            // Determine status
            const hasCritical = anomalies.some(a => a.severity === 'critical');
            const hasWarning = anomalies.some(a => a.severity === 'warning');
            const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

            res.json({
                status,
                timestamp: new Date().toISOString(),
                summary: {
                    totalIngredients: parseInt(total_items),
                    ingredientsWithStock: parseInt(items_with_stock),
                    totalStockValue: parseFloat(parseFloat(total_value).toFixed(2)),
                    anomalyCount: anomalies.length
                },
                anomalies
            });
        } catch (err) {
            log('error', 'Error en health-check de inventario', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // Endpoint para consolidar stock con lógica de Ajustes (ERP)
    router.post('/inventory/consolidate', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { adjustments, snapshots, finalStock } = req.body;

            if (!req.restauranteId) {
                return res.status(401).json({ error: 'No autorizado: Restaurante ID nulo' });
            }

            await client.query('BEGIN');

            // 1. Guardar Snapshots
            if (snapshots && Array.isArray(snapshots)) {
                for (const snap of snapshots) {
                    const ingId = parseInt(snap.id, 10);
                    const real = parseFloat(snap.stock_real);
                    const virtual = parseFloat(snap.stock_virtual);

                    if (isNaN(ingId)) continue;

                    const safeReal = isNaN(real) ? 0 : real;
                    const safeVirtual = isNaN(virtual) ? 0 : virtual;
                    const diff = safeReal - safeVirtual;

                    await client.query(
                        `INSERT INTO inventory_snapshots_v2 
                     (ingrediente_id, stock_virtual, stock_real, diferencia, restaurante_id) 
                     VALUES ($1, $2, $3, $4, $5)`,
                        [ingId, safeVirtual.toFixed(2), safeReal.toFixed(2), diff.toFixed(2), req.restauranteId]
                    );
                }
            }

            // 2. Guardar Ajustes
            //
            // 🩹 FIX 2026-08-01 — LA MERMA DEL RECUENTO ERA INVISIBLE
            // Había DOS tablas de merma y solo una se leía:
            //   · `mermas`                    ← escribe POST /mermas (modal "merma rápida").
            //                                   La leen los informes, Omnes y el informe mensual.
            //   · `inventory_adjustments_v2`  ← escribía SOLO este endpoint... y NADIE la leía.
            // Resultado: todo lo que se perdía al cuadrar el inventario físico desaparecía de
            // los informes. En La Nave 5 eran 551 registros invisibles; al auditar el pulpo,
            // la tabla `mermas` decía 5,5 kg cuando el movimiento real era mucho mayor.
            //
            // Se mantiene el INSERT en inventory_adjustments_v2 (es el libro del recuento, con
            // su snapshot asociado) y se AÑADE la fila en `mermas`, que es la tabla canónica de
            // pérdida. Así los informes existentes funcionan sin tocar ni una consulta de lectura.
            //
            // Solo las pérdidas (cantidad < 0) son merma: un ajuste positivo significa que
            // apareció más género del contabilizado, y eso no se ha perdido.
            // OJO: aquí NO se toca el stock — de eso se encarga el paso 3 (finalStock). Duplicar
            // el descuento dejaría el inventario recién contado a la mitad.
            const ingredientesInfo = new Map();
            if (adjustments && Array.isArray(adjustments) && adjustments.length > 0) {
                const idsAjustados = adjustments
                    .map(a => parseInt(a.ingrediente_id, 10))
                    .filter(n => Number.isFinite(n));
                if (idsAjustados.length > 0) {
                    const infoRes = await client.query(
                        `SELECT i.id, i.nombre, i.unidad, i.precio, i.cantidad_por_formato, i.precio_fijado,
                                pcd.precio_medio_compra
                         FROM ingredientes i
                         LEFT JOIN (
                             SELECT ingrediente_id,
                                    ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) AS precio_medio_compra
                             FROM precios_compra_diarios WHERE restaurante_id = $1
                             GROUP BY ingrediente_id
                         ) pcd ON pcd.ingrediente_id = i.id
                         WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL AND i.id = ANY($2::int[])`,
                        [req.restauranteId, idsAjustados]
                    );
                    infoRes.rows.forEach(r => ingredientesInfo.set(r.id, r));
                }
            }
            // periodo_id YYYYMM, mismo formato que POST /mermas.
            const ahora = new Date();
            const periodoId = ahora.getFullYear() * 100 + (ahora.getMonth() + 1);

            if (adjustments && Array.isArray(adjustments)) {
                for (const adj of adjustments) {
                    const ingId = parseInt(adj.ingrediente_id, 10);
                    const cantidad = parseFloat(adj.cantidad);
                    const motivo = adj.motivo ? String(adj.motivo).substring(0, 100) : 'Ajuste';
                    const notas = adj.notas ? String(adj.notas) : '';

                    if (isNaN(ingId)) continue;

                    const safeCant = isNaN(cantidad) ? 0 : cantidad;

                    await client.query(
                        `INSERT INTO inventory_adjustments_v2
                     (ingrediente_id, cantidad, motivo, notas, restaurante_id)
                     VALUES ($1, $2, $3, $4, $5)`,
                        [ingId, safeCant.toFixed(2), motivo, notas, req.restauranteId]
                    );

                    // Espejo en `mermas` para que la pérdida sea visible en los informes.
                    // Si el ingrediente no se resolvió (borrado o de otro tenant), se salta:
                    // el libro del recuento ya quedó arriba, y `mermas` no admite huérfanos.
                    const info = ingredientesInfo.get(ingId);
                    if (safeCant < 0 && info) {
                        const perdida = Math.abs(safeCant);
                        const precioUnitario = getBackendIngredientUnitPrice(info);
                        await client.query(`
                            INSERT INTO mermas
                            (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, nota, responsable_id, restaurante_id, periodo_id)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        `, [
                            ingId,
                            info.nombre || 'Sin nombre',
                            perdida,
                            info.unidad || 'ud',
                            Math.round(perdida * precioUnitario * 100) / 100,
                            motivo,
                            notas || 'Diferencia detectada en el recuento de inventario',
                            // responsable_id es nullable: si el token no trae id, se guarda null
                            // antes que reventar el registro de la merma.
                            req.user?.userId || req.user?.id || null,
                            req.restauranteId,
                            periodoId
                        ]);
                    }
                }
            }

            // 3. Actualizar Stock Maestro
            const updated = [];
            if (finalStock && Array.isArray(finalStock)) {
                for (const item of finalStock) {
                    const ingId = parseInt(item.id, 10);
                    const real = parseFloat(item.stock_real);

                    if (isNaN(ingId)) continue;

                    const safeReal = isNaN(real) ? 0 : real;

                    // Lock ingredient row to prevent race condition during consolidation
                    // 🔒 deleted_at IS NULL en lock + UPDATE (auditoria A1-A3).
                    await client.query(
                        'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL FOR UPDATE',
                        [ingId, req.restauranteId]
                    );
                    const result = await client.query(
                        `UPDATE ingredientes
                     SET stock_actual = $1,
                         stock_real = NULL,
                         ultima_actualizacion_stock = CURRENT_TIMESTAMP
                     WHERE id = $2 AND restaurante_id = $3 AND deleted_at IS NULL
                     RETURNING *`,
                        [safeReal.toFixed(2), ingId, req.restauranteId]
                    );

                    if (result.rows.length > 0) {
                        updated.push(result.rows[0]);
                    }
                }
            }

            await client.query('COMMIT');
            res.json({ success: true, updated: updated.length, items: updated });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error en consolidación', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });


    return router;
};
