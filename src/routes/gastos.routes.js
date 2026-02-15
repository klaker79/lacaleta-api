/**
 * gastos Routes — Extracted from server.js
 * Fixed expenses (gastos fijos) CRUD
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validatePrecio, sanitizeString } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== GASTOS FIJOS (Fixed Expenses) ==========
    // GET all gastos fijos
    router.get('/gastos-fijos', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT * FROM gastos_fijos WHERE activo = true AND restaurante_id = $1 ORDER BY id',
                [req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo gastos fijos', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST create gasto fijo
    router.post('/gastos-fijos', authMiddleware, async (req, res) => {
        try {
            const { concepto, monto_mensual } = req.body;

            const conceptoLimpio = sanitizeString(concepto, 255);
            if (!conceptoLimpio) {
                return res.status(400).json({ error: 'El concepto es requerido' });
            }

            const montoValidado = validatePrecio(monto_mensual);

            const result = await pool.query(
                'INSERT INTO gastos_fijos (concepto, monto_mensual, restaurante_id) VALUES ($1, $2, $3) RETURNING *',
                [conceptoLimpio, montoValidado, req.restauranteId]
            );

            log('info', 'Gasto fijo creado', { id: result.rows[0].id, concepto });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando gasto fijo', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // PUT update gasto fijo
    router.put('/gastos-fijos/:id', authMiddleware, async (req, res) => {
        try {
            const { id } = req.params;
            const { concepto, monto_mensual } = req.body;

            const montoValidado = monto_mensual !== undefined ? validatePrecio(monto_mensual) : undefined;

            const result = await pool.query(
                'UPDATE gastos_fijos SET concepto = COALESCE($1, concepto), monto_mensual = COALESCE($2, monto_mensual), updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND restaurante_id = $4 RETURNING *',
                [concepto, montoValidado, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Gasto fijo no encontrado' });
            }

            log('info', 'Gasto fijo actualizado', { id, monto_mensual });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando gasto fijo', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE gasto fijo (soft delete)
    router.delete('/gastos-fijos/:id', authMiddleware, async (req, res) => {
        try {
            const { id } = req.params;

            await pool.query(
                'UPDATE gastos_fijos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurante_id = $2',
                [id, req.restauranteId]
            );

            log('info', 'Gasto fijo eliminado', { id });
            res.json({ message: 'Gasto fijo eliminado' });
        } catch (err) {
            log('error', 'Error eliminando gasto fijo', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });


    return router;
};
