/**
 * inventory Routes — Extracted from server.js
 * Advanced inventory: complete view, stock real updates, bulk updates, health check, consolidation
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validateNumber, validateId } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== INVENTARIO AVANZADO ==========
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
        CASE 
            WHEN i.stock_real IS NULL THEN NULL 
            ELSE (i.stock_real - i.stock_actual) 
        END as diferencia,
        -- Precio unitario: SIEMPRE dividir precio por cantidad_por_formato
        -- (La subquery de pedidos se elimina porque los pedidos históricos tienen precios por formato sin dividir)
        CASE 
          WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0 
          THEN i.precio / i.cantidad_por_formato
          ELSE i.precio 
        END as precio_medio,
        -- Valor stock = stock_actual × precio_unitario
        (i.stock_actual * CASE 
          WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0 
          THEN i.precio / i.cantidad_por_formato
          ELSE i.precio 
        END) as valor_stock
      FROM ingredientes i
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

                // C2: FOR UPDATE lock to prevent race condition
                await client.query(
                    'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                    [item.id, req.restauranteId]
                );
                const result = await client.query(
                    `UPDATE ingredientes 
         SET stock_real = $1, 
             ultima_actualizacion_stock = CURRENT_TIMESTAMP 
         WHERE id = $2 AND restaurante_id = $3 
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
                    await client.query('SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE', [ingId, req.restauranteId]);
                    const result = await client.query(
                        `UPDATE ingredientes
                     SET stock_actual = $1,
                         stock_real = NULL,
                         ultima_actualizacion_stock = CURRENT_TIMESTAMP
                     WHERE id = $2 AND restaurante_id = $3
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
