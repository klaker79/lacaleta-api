/**
 * ============================================
 * routes/merma.routes.js - Rutas de Mermas
 * ============================================
 *
 * Registro, listado y estadísticas de mermas
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');

/**
 * POST /api/mermas
 * Registrar mermas
 */
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { mermas } = req.body;
        log('info', 'Recibiendo mermas', { count: mermas?.length, restauranteId: req.restauranteId });

        if (!mermas || !Array.isArray(mermas)) {
            return res.status(400).json({ error: 'Array de mermas requerido' });
        }

        let insertados = 0;
        for (const m of mermas) {
            try {
                const ingredienteId = m.ingredienteId ? parseInt(m.ingredienteId) : null;
                const now = new Date();
                const periodoId = now.getFullYear() * 100 + (now.getMonth() + 1);

                await pool.query(`
                    INSERT INTO mermas 
                    (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, nota, responsable_id, restaurante_id, periodo_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    ingredienteId,
                    m.ingredienteNombre || 'Sin nombre',
                    parseFloat(m.cantidad) || 0,
                    m.unidad || 'ud',
                    parseFloat(m.valorPerdida) || 0,
                    m.motivo || 'Otros',
                    m.nota || '',
                    m.responsableId ? parseInt(m.responsableId) : null,
                    req.restauranteId,
                    periodoId
                ]);
                insertados++;
            } catch (insertErr) {
                log('error', 'Error insertando merma', { error: insertErr.message });
            }
        }

        log('info', `Registradas ${insertados}/${mermas.length} mermas`);
        res.json({ success: true, count: insertados });
    } catch (err) {
        log('error', 'Error registrando mermas', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/mermas
 * Listar historial de mermas
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { limite } = req.query;
        const lim = parseInt(limite) || 100;

        const result = await pool.query(`
            SELECT m.*, i.nombre as ingrediente_actual
            FROM mermas m
            LEFT JOIN ingredientes i ON m.ingrediente_id = i.id
            WHERE m.restaurante_id = $1
            ORDER BY m.fecha DESC, m.id DESC
            LIMIT $2
        `, [req.restauranteId, lim]);

        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error listando mermas', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

/**
 * GET /api/mermas/resumen
 * Resumen mensual de mermas
 */
router.get('/resumen', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COALESCE(SUM(valor_perdida), 0) as total_perdida,
                COUNT(DISTINCT ingrediente_id) as total_productos,
                COUNT(*) as total_registros
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `, [req.restauranteId]);

        const data = result.rows[0] || {};
        res.json({
            totalPerdida: parseFloat(data.total_perdida || 0),
            totalProductos: parseInt(data.total_productos || 0),
            totalRegistros: parseInt(data.total_registros || 0)
        });
    } catch (err) {
        log('error', 'Error en resumen', { error: err.message });
        res.status(500).json({ totalPerdida: 0, totalProductos: 0, totalRegistros: 0 });
    }
});

/**
 * GET /api/mermas/stats
 * Estadísticas de mermas (waste-stats)
 */
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const mesActual = await pool.query(`
            SELECT COALESCE(SUM(valor_perdida), 0) as total_perdida, COUNT(*) as total_registros
            FROM mermas WHERE restaurante_id = $1 AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `, [req.restauranteId]);

        const topProductos = await pool.query(`
            SELECT ingrediente_nombre as nombre, SUM(cantidad) as cantidad_total, 
                   SUM(valor_perdida) as perdida_total, COUNT(*) as veces
            FROM mermas WHERE restaurante_id = $1 AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
            GROUP BY ingrediente_nombre ORDER BY perdida_total DESC LIMIT 5
        `, [req.restauranteId]);

        const mesAnterior = await pool.query(`
            SELECT COALESCE(SUM(valor_perdida), 0) as total_perdida
            FROM mermas WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
              AND fecha < DATE_TRUNC('month', CURRENT_DATE)
        `, [req.restauranteId]);

        const totalActual = parseFloat(mesActual.rows[0]?.total_perdida || 0);
        const totalAnterior = parseFloat(mesAnterior.rows[0]?.total_perdida || 0);
        const variacion = totalAnterior > 0 ? ((totalActual - totalAnterior) / totalAnterior) * 100 : 0;

        res.json({
            mes_actual: { total_perdida: totalActual, registros: parseInt(mesActual.rows[0]?.total_registros || 0) },
            top_productos: topProductos.rows,
            comparacion: { mes_anterior: totalAnterior, variacion: Math.round(variacion) }
        });
    } catch (err) {
        log('error', 'Error en stats', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/mermas/:id
 * Eliminar merma y restaurar stock
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const mermaResult = await client.query(
            'SELECT * FROM mermas WHERE id = $1 AND restaurante_id = $2',
            [req.params.id, req.restauranteId]
        );

        if (mermaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Merma no encontrada' });
        }

        const merma = mermaResult.rows[0];

        // Restaurar stock
        if (merma.ingrediente_id && merma.cantidad > 0) {
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual + $1 WHERE id = $2 AND restaurante_id = $3',
                [parseFloat(merma.cantidad), merma.ingrediente_id, req.restauranteId]
            );
        }

        await client.query('DELETE FROM mermas WHERE id = $1', [req.params.id]);
        await client.query('COMMIT');

        log('info', 'Merma eliminada', { id: req.params.id });
        res.json({ success: true, message: 'Merma eliminada y stock restaurado' });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando merma', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/mermas/reset
 * Reset mensual de mermas
 */
router.delete('/reset', authMiddleware, async (req, res) => {
    try {
        const deleted = await pool.query(`
            DELETE FROM mermas WHERE restaurante_id = $1 AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
            RETURNING *
        `, [req.restauranteId]);

        log('info', 'Mermas reseteadas', { count: deleted.rowCount });
        res.json({ success: true, deleted: deleted.rowCount });
    } catch (err) {
        log('error', 'Error reset mermas', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
