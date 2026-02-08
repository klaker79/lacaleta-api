/**
 * ============================================
 * routes/expense.routes.js - Rutas de Gastos Fijos
 * ============================================
 *
 * Gestión de gastos fijos mensuales
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { validatePrecio } = require('../utils/validators');

/**
 * GET /api/expenses
 * Obtener todos los gastos fijos activos
 */
router.get('/', authMiddleware, async (req, res) => {
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

/**
 * POST /api/expenses
 * Crear gasto fijo
 */
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { concepto, monto_mensual } = req.body;

        if (!concepto) {
            return res.status(400).json({ error: 'concepto es requerido' });
        }

        const montoValidado = validatePrecio(monto_mensual);

        const result = await pool.query(
            'INSERT INTO gastos_fijos (concepto, monto_mensual, restaurante_id) VALUES ($1, $2, $3) RETURNING *',
            [concepto, montoValidado, req.restauranteId]
        );

        log('info', 'Gasto fijo creado', { id: result.rows[0].id, concepto });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando gasto fijo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/expenses/:id
 * Actualizar gasto fijo
 */
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { concepto, monto_mensual } = req.body;

        const montoValidado = monto_mensual !== undefined ? validatePrecio(monto_mensual) : undefined;

        const result = await pool.query(
            `UPDATE gastos_fijos SET 
             concepto = COALESCE($1, concepto), 
             monto_mensual = COALESCE($2, monto_mensual), 
             updated_at = CURRENT_TIMESTAMP 
             WHERE id = $3 AND restaurante_id = $4 RETURNING *`,
            [concepto, montoValidado, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Gasto fijo no encontrado' });
        }

        log('info', 'Gasto fijo actualizado', { id });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando gasto fijo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/expenses/:id
 * Soft delete gasto fijo
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query(
            'UPDATE gastos_fijos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );

        log('info', 'Gasto fijo eliminado', { id });
        res.json({ message: 'Eliminado' });
    } catch (err) {
        log('error', 'Error eliminando gasto fijo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
