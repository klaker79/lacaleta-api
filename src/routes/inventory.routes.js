/**
 * ============================================
 * routes/inventory.routes.js - Rutas de Inventario
 * ============================================
 *
 * Gestión avanzada de inventario y stock
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { validateNumber } = require('../utils/validators');

/**
 * GET /api/inventory/complete
 * Inventario completo con cálculos de precio y valoración
 */
router.get('/complete', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                i.id, i.nombre, i.unidad,
                i.stock_actual as stock_virtual,
                i.stock_real, i.stock_minimo, i.proveedor_id,
                i.ultima_actualizacion_stock,
                i.formato_compra, i.cantidad_por_formato,
                CASE 
                    WHEN i.stock_real IS NULL THEN NULL 
                    ELSE (i.stock_real - i.stock_actual) 
                END as diferencia,
                CASE 
                    WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0 
                    THEN i.precio / i.cantidad_por_formato
                    ELSE i.precio 
                END as precio_medio,
                (i.stock_actual * CASE 
                    WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0 
                    THEN i.precio / i.cantidad_por_formato
                    ELSE i.precio 
                END) as valor_stock
            FROM ingredientes i
            WHERE i.restaurante_id = $1
            ORDER BY i.id
        `, [req.restauranteId]);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error inventario completo', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

/**
 * PUT /api/inventory/:id/stock-real
 * Actualizar stock real de un ingrediente
 */
router.put('/:id/stock-real', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { stock_real } = req.body;

        const stockValidado = validateNumber(stock_real, 0, 0);
        if (stockValidado === null || stockValidado < 0) {
            return res.status(400).json({ error: 'Stock debe ser >= 0' });
        }

        const result = await pool.query(
            `UPDATE ingredientes 
             SET stock_real = $1, ultima_actualizacion_stock = CURRENT_TIMESTAMP 
             WHERE id = $2 AND restaurante_id = $3 RETURNING *`,
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

/**
 * PUT /api/inventory/bulk-update-stock
 * Actualización masiva de stock real
 */
router.put('/bulk-update-stock', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { stocks } = req.body;
        await client.query('BEGIN');

        const updated = [];
        for (const item of stocks) {
            const result = await client.query(
                `UPDATE ingredientes 
                 SET stock_real = $1, ultima_actualizacion_stock = CURRENT_TIMESTAMP 
                 WHERE id = $2 AND restaurante_id = $3 RETURNING *`,
                [item.stock_real, item.id, req.restauranteId]
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

/**
 * POST /api/inventory/consolidate
 * Consolidar inventario (snapshots + ajustes + actualización final)
 */
router.post('/consolidate', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { adjustments, snapshots, finalStock } = req.body;

        if (!req.restauranteId) {
            return res.status(401).json({ error: 'No autorizado' });
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

                await client.query(
                    `INSERT INTO inventory_adjustments_v2 
                     (ingrediente_id, cantidad, motivo, notas, restaurante_id) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [ingId, cantidad.toFixed(2), motivo, notas, req.restauranteId]
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

                const result = await client.query(
                    `UPDATE ingredientes
                     SET stock_actual = $1, stock_real = NULL, ultima_actualizacion_stock = CURRENT_TIMESTAMP
                     WHERE id = $2 AND restaurante_id = $3 RETURNING *`,
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

module.exports = router;
