/**
 * staff Routes — Extracted from server.js
 * Staff management & scheduling
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { requirePlan } = require('../middleware/planGate');
const { log } = require('../utils/logger');
const { sanitizeString, validateNumber, validateId } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== EMPLEADOS (Staff Management) ==========

    // GET all empleados
    router.get('/empleados', authMiddleware, requirePlan('profesional'), async (req, res) => {
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

    // POST crear empleado
    router.post('/empleados', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

            if (!nombre) {
                return res.status(400).json({ error: 'nombre es requerido' });
            }

            const result = await pool.query(
                `INSERT INTO empleados (nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [sanitizeString(nombre), (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : '#3B82F6', validateNumber(horas_contrato, 40, 0, 168), validateNumber(coste_hora, 10, 0, 999), sanitizeString(dias_libres_fijos) || '', sanitizeString(puesto) || 'Camarero', req.restauranteId]
            );

            log('info', 'Empleado creado', { nombre });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando empleado', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // PUT actualizar empleado
    router.put('/empleados/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
            const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

            const result = await pool.query(
                `UPDATE empleados SET nombre = COALESCE($1, nombre), color = COALESCE($2, color), 
             horas_contrato = COALESCE($3, horas_contrato), coste_hora = COALESCE($4, coste_hora),
             dias_libres_fijos = COALESCE($5, dias_libres_fijos), puesto = COALESCE($6, puesto)
             WHERE id = $7 AND restaurante_id = $8 RETURNING *`,
                [sanitizeString(nombre), (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : undefined, horas_contrato != null ? validateNumber(horas_contrato, undefined, 0, 168) : undefined, coste_hora != null ? validateNumber(coste_hora, undefined, 0, 999) : undefined, sanitizeString(dias_libres_fijos), sanitizeString(puesto), id, req.restauranteId]
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

    // DELETE empleado (soft delete)
    router.delete('/empleados/:id', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
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

    // ========== HORARIOS (Staff Scheduling) ==========

    // GET horarios por rango de fechas
    router.get('/horarios', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const { desde, hasta } = req.query;

            if (!desde || !hasta) {
                return res.status(400).json({ error: 'desde y hasta son requeridos' });
            }

            const result = await pool.query(
                `SELECT h.*, e.nombre as empleado_nombre, e.color as empleado_color
             FROM horarios h
             JOIN empleados e ON h.empleado_id = e.id
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

    // POST asignar turno
    router.post('/horarios', authMiddleware, requirePlan('profesional'), async (req, res) => {
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

    // DELETE quitar turno
    router.delete('/horarios/:id', authMiddleware, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query(
                'DELETE FROM horarios WHERE id = $1 AND restaurante_id = $2',
                [id, req.restauranteId]
            );
            res.json({ success: true });
        } catch (err) {
            log('error', 'Error eliminando turno', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE turno por empleado y fecha (para toggle)
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

    // DELETE todos los horarios (borrado masivo)
    router.delete('/horarios/all', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(
                'DELETE FROM horarios WHERE restaurante_id = $1',
                [req.restauranteId]
            );
            log('info', 'Todos los horarios eliminados', { count: result.rowCount });
            res.json({ success: true, deleted: result.rowCount });
        } catch (err) {
            log('error', 'Error eliminando todos los horarios', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST copiar semana anterior
    router.post('/horarios/copiar-semana', authMiddleware, async (req, res) => {
        try {
            const { semana_origen, semana_destino } = req.body;

            if (!semana_origen || !semana_destino) {
                return res.status(400).json({ error: 'semana_origen y semana_destino son requeridos' });
            }

            // Obtener horarios de la semana origen
            const horariosOrigen = await pool.query(
                `SELECT empleado_id, turno, hora_inicio, hora_fin, es_extra, notas,
                    fecha - $1::date as dia_offset
             FROM horarios 
             WHERE fecha BETWEEN $1 AND ($1::date + 6) AND restaurante_id = $2`,
                [semana_origen, req.restauranteId]
            );

            // Insertar en semana destino
            let insertados = 0;
            for (const h of horariosOrigen.rows) {
                const nuevaFecha = new Date(semana_destino);
                nuevaFecha.setDate(nuevaFecha.getDate() + h.dia_offset);

                const insertResult = await pool.query(
                    `INSERT INTO horarios (empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (empleado_id, fecha) DO NOTHING
                 RETURNING id`,
                    [h.empleado_id, nuevaFecha.toISOString().split('T')[0], h.turno, h.hora_inicio, h.hora_fin, h.es_extra, h.notas, req.restauranteId]
                );
                if (insertResult.rows.length > 0) insertados++;
            }

            log('info', 'Semana copiada', { origen: semana_origen, destino: semana_destino, turnos: insertados });
            res.json({ success: true, turnos_copiados: insertados });
        } catch (err) {
            log('error', 'Error copiando semana', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });


    return router;
};
