/**
 * ============================================
 * routes/staff.routes.js - Rutas de Personal
 * ============================================
 *
 * Gestión de empleados y horarios
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');

// ========== EMPLEADOS ==========

/**
 * GET /api/staff/empleados (or /api/empleados via legacy alias)
 * Obtener todos los empleados activos
 */
router.get('/empleados', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM empleados WHERE activo = true AND restaurante_id = $1 ORDER BY nombre',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo empleados', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// Legacy alias: /api/empleados (sin subruta) - requerido por frontend
router.get('/', authMiddleware, async (req, res, next) => {
    // Solo responder si viene de /api/empleados, no de /api/staff
    if (req.baseUrl === '/api/empleados') {
        try {
            const result = await pool.query(
                'SELECT * FROM empleados WHERE activo = true AND restaurante_id = $1 ORDER BY nombre',
                [req.restauranteId]
            );
            return res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo empleados (legacy)', { error: err.message });
            return res.status(500).json({ error: 'Error interno' });
        }
    }
    next();
});

/**
 * POST /api/staff/empleados
 * Crear empleado
 */
router.post('/empleados', authMiddleware, async (req, res) => {
    try {
        const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

        if (!nombre) {
            return res.status(400).json({ error: 'nombre es requerido' });
        }

        const result = await pool.query(
            `INSERT INTO empleados (nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [nombre, color || '#3B82F6', horas_contrato || 40, coste_hora || 10,
                dias_libres_fijos || '', puesto || 'Camarero', req.restauranteId]
        );

        log('info', 'Empleado creado', { nombre });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando empleado', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/staff/empleados/:id
 * Actualizar empleado
 */
router.put('/empleados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

        const result = await pool.query(
            `UPDATE empleados SET 
             nombre = COALESCE($1, nombre), color = COALESCE($2, color), 
             horas_contrato = COALESCE($3, horas_contrato), coste_hora = COALESCE($4, coste_hora),
             dias_libres_fijos = COALESCE($5, dias_libres_fijos), puesto = COALESCE($6, puesto)
             WHERE id = $7 AND restaurante_id = $8 RETURNING *`,
            [nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando empleado', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/staff/empleados/:id
 * Soft delete empleado
 */
router.delete('/empleados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'UPDATE empleados SET activo = false WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando empleado', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== HORARIOS ==========

/**
 * GET /api/staff/horarios (or /api/horarios via legacy alias)
 * Obtener horarios por rango de fechas
 */
router.get('/horarios', authMiddleware, async (req, res) => {
    try {
        const { desde, hasta } = req.query;

        if (!desde || !hasta) {
            return res.status(400).json({ error: 'desde y hasta son requeridos' });
        }

        const result = await pool.query(
            `SELECT h.*, e.nombre as empleado_nombre, e.color as empleado_color
             FROM horarios h JOIN empleados e ON h.empleado_id = e.id
             WHERE h.fecha BETWEEN $1 AND $2 AND h.restaurante_id = $3
             ORDER BY h.fecha, e.nombre`,
            [desde, hasta, req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo horarios', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// Legacy alias: /api/horarios (sin subruta) - requerido por frontend  
// Nota: El handler GET '/' arriba maneja empleados, este middleware adicional maneja horarios
router.use('/', (req, res, next) => {
    if (req.baseUrl === '/api/horarios' && req.method === 'GET' && req.path === '/') {
        // Redirigir internamente a /horarios
        req.url = '/horarios' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
    }
    next();
});

/**
 * POST /api/staff/horarios
 * Asignar turno (upsert)
 */
router.post('/horarios', authMiddleware, async (req, res) => {
    try {
        const { empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas } = req.body;

        if (!empleado_id || !fecha) {
            return res.status(400).json({ error: 'empleado_id y fecha son requeridos' });
        }

        const result = await pool.query(
            `INSERT INTO horarios (empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (empleado_id, fecha) DO UPDATE SET 
                turno = EXCLUDED.turno, hora_inicio = EXCLUDED.hora_inicio, 
                hora_fin = EXCLUDED.hora_fin, es_extra = EXCLUDED.es_extra, notas = EXCLUDED.notas
             RETURNING *`,
            [empleado_id, fecha, turno || 'completo', hora_inicio, hora_fin, es_extra || false, notas, req.restauranteId]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error asignando turno', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/staff/horarios/:id
 * Eliminar turno por ID
 */
router.delete('/horarios/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM horarios WHERE id = $1 AND restaurante_id = $2', [req.params.id, req.restauranteId]);
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando turno', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/staff/horarios/empleado/:empleadoId/fecha/:fecha
 * Eliminar turno por empleado y fecha (toggle)
 */
router.delete('/horarios/empleado/:empleadoId/fecha/:fecha', authMiddleware, async (req, res) => {
    try {
        const { empleadoId, fecha } = req.params;
        await pool.query(
            'DELETE FROM horarios WHERE empleado_id = $1 AND fecha = $2 AND restaurante_id = $3',
            [empleadoId, fecha, req.restauranteId]
        );
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando turno', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/staff/horarios/all
 * Borrado masivo de horarios
 */
router.delete('/horarios/all', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM horarios WHERE restaurante_id = $1', [req.restauranteId]);
        log('info', 'Todos los horarios eliminados', { count: result.rowCount });
        res.json({ success: true, deleted: result.rowCount });
    } catch (err) {
        log('error', 'Error eliminando horarios', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * POST /api/staff/horarios/copiar-semana
 * Copiar semana anterior
 */
router.post('/horarios/copiar-semana', authMiddleware, async (req, res) => {
    try {
        const { semana_origen, semana_destino } = req.body;

        if (!semana_origen || !semana_destino) {
            return res.status(400).json({ error: 'semana_origen y semana_destino requeridos' });
        }

        const horariosOrigen = await pool.query(
            `SELECT empleado_id, turno, hora_inicio, hora_fin, es_extra, notas,
                    fecha - $1::date as dia_offset
             FROM horarios 
             WHERE fecha BETWEEN $1 AND ($1::date + 6) AND restaurante_id = $2`,
            [semana_origen, req.restauranteId]
        );

        let insertados = 0;
        for (const h of horariosOrigen.rows) {
            const nuevaFecha = new Date(semana_destino);
            nuevaFecha.setDate(nuevaFecha.getDate() + h.dia_offset);

            await pool.query(
                `INSERT INTO horarios (empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (empleado_id, fecha) DO NOTHING`,
                [h.empleado_id, nuevaFecha.toISOString().split('T')[0], h.turno, h.hora_inicio,
                h.hora_fin, h.es_extra, h.notas, req.restauranteId]
            );
            insertados++;
        }

        log('info', 'Semana copiada', { origen: semana_origen, destino: semana_destino, turnos: insertados });
        res.json({ success: true, turnos_copiados: insertados });
    } catch (err) {
        log('error', 'Error copiando semana', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
