/**
 * personal-extra Routes — pagos a extras por horas (cuentan en el PyG).
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validatePrecio, sanitizeString, validateId } = require('../utils/validators');
const { logChange } = require('../utils/auditLog');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fechaOk = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;

module.exports = function (pool) {
    const router = Router();

    router.get('/personal-extra', authMiddleware, async (req, res) => {
        try {
            const hoy = new Date();
            const ym = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}`;
            const desde = fechaOk(req.query.desde) || `${ym}-01`;
            const hasta = fechaOk(req.query.hasta) || `${ym}-31`;
            const result = await pool.query(
                'SELECT * FROM personal_extra WHERE restaurante_id = $1 AND fecha >= $2 AND fecha <= $3 ORDER BY fecha DESC, id DESC',
                [req.restauranteId, desde, hasta]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.post('/personal-extra', authMiddleware, async (req, res) => {
        try {
            const fecha = fechaOk(req.body.fecha);
            if (!fecha) return res.status(400).json({ error: 'Fecha inválida (YYYY-MM-DD)' });
            const nombre = req.body.nombre !== undefined ? sanitizeString(req.body.nombre, 255) : null;
            const horas = validatePrecio(req.body.horas);
            const precio_hora = validatePrecio(req.body.precio_hora);
            const observaciones = req.body.observaciones !== undefined ? sanitizeString(req.body.observaciones, 1000) : null;
            const total = round2(horas * precio_hora);
            const result = await pool.query(
                `INSERT INTO personal_extra (restaurante_id, fecha, nombre, horas, precio_hora, total, observaciones)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [req.restauranteId, fecha, nombre, horas, precio_hora, total, observaciones]
            );
            log('info', 'Personal extra creado', { id: result.rows[0].id });
            logChange(pool, { req, tabla: 'personal_extra', operacion: 'INSERT', registroId: result.rows[0].id, datosAntes: null, datosDespues: result.rows[0] });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.put('/personal-extra/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
            const prev = (await pool.query('SELECT * FROM personal_extra WHERE id = $1 AND restaurante_id = $2', [id, req.restauranteId])).rows[0];
            if (!prev) return res.status(404).json({ error: 'No encontrado' });
            const fecha = req.body.fecha !== undefined ? (fechaOk(req.body.fecha) || prev.fecha) : prev.fecha;
            const nombre = req.body.nombre !== undefined ? sanitizeString(req.body.nombre, 255) : prev.nombre;
            const horas = req.body.horas !== undefined ? validatePrecio(req.body.horas) : Number(prev.horas);
            const precio_hora = req.body.precio_hora !== undefined ? validatePrecio(req.body.precio_hora) : Number(prev.precio_hora);
            const observaciones = req.body.observaciones !== undefined ? sanitizeString(req.body.observaciones, 1000) : prev.observaciones;
            const total = round2(horas * precio_hora);
            const result = await pool.query(
                `UPDATE personal_extra SET fecha=$1, nombre=$2, horas=$3, precio_hora=$4, total=$5, observaciones=$6, updated_at=CURRENT_TIMESTAMP
                 WHERE id=$7 AND restaurante_id=$8 RETURNING *`,
                [fecha, nombre, horas, precio_hora, total, observaciones, id, req.restauranteId]
            );
            logChange(pool, { req, tabla: 'personal_extra', operacion: 'UPDATE', registroId: id, datosAntes: prev, datosDespues: result.rows[0] });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.delete('/personal-extra/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
            const result = await pool.query('DELETE FROM personal_extra WHERE id = $1 AND restaurante_id = $2 RETURNING id', [id, req.restauranteId]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
            logChange(pool, { req, tabla: 'personal_extra', operacion: 'DELETE', registroId: id, datosAntes: { id }, datosDespues: null });
            res.json({ message: 'Personal extra eliminado' });
        } catch (err) {
            log('error', 'Error eliminando personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
