/**
 * elaboraciones Routes — pesaje real de una producción de cocina.
 *
 * El problema que resuelve (caso PULPO, auditoría 2026-08-02): la ficha dice
 * rendimiento 60% pero el consumo real implica ~44%, y esa diferencia son miles
 * de euros de food cost invisible. La única forma de saberlo es PESAR: lo que
 * entra crudo (bruta) y lo que sale utilizable (neta).
 *
 * ⚠️ NO toca stock, a propósito: el censo de escritores de stock está congelado
 * (solo puede encoger) y una elaboración es una MEDICIÓN, no un movimiento.
 * El stock ya se descuenta por la venta; esto solo mide cuánto se pierde al
 * cocinar/limpiar para contrastarlo con el `rendimiento` de la ficha.
 *
 * ⚠️ Tampoco cambia `ingredientes.rendimiento` solo: ver el real vs la ficha y
 * decidir si se ajusta es del chef (misma filosofía que la diferencia de
 * inventario: se ENSEÑA, no se compensa automáticamente).
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { globalLimiter, costlyApiLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const { validateId, validateDate, sanitizeString } = require('../utils/validators');
const { calcularRendimientoReal } = require('../utils/rendimientoReal');
const { logChange } = require('../utils/auditLog');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== RESUMEN: rendimiento real (ponderado) vs ficha ==========
    // Ponderado = SUM(neta)/SUM(bruta): pesar 10 kg y 100 kg no valen lo mismo.
    router.get('/elaboraciones/rendimientos', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT e.ingrediente_id,
                        COALESCE(i.nombre, MAX(e.ingrediente_nombre)) AS nombre,
                        i.unidad,
                        COUNT(*)::int AS n_elaboraciones,
                        ROUND(SUM(e.cantidad_bruta)::numeric, 3) AS total_bruta,
                        ROUND(SUM(e.cantidad_neta)::numeric, 3) AS total_neta,
                        ROUND((SUM(e.cantidad_neta) / NULLIF(SUM(e.cantidad_bruta), 0) * 100)::numeric, 2) AS rendimiento_real,
                        i.rendimiento AS rendimiento_ficha,
                        MAX(e.fecha) AS ultima_elaboracion
                 FROM elaboraciones e
                 LEFT JOIN ingredientes i
                        ON i.id = e.ingrediente_id
                       AND i.restaurante_id = e.restaurante_id
                       AND i.deleted_at IS NULL
                 WHERE e.restaurante_id = $1
                   AND e.deleted_at IS NULL
                 GROUP BY e.ingrediente_id, i.nombre, i.unidad, i.rendimiento
                 ORDER BY MAX(e.fecha) DESC`,
                [req.restauranteId]
            );

            const resumen = rows.map(r => {
                const real = parseFloat(r.rendimiento_real);
                const ficha = r.rendimiento_ficha !== null ? parseFloat(r.rendimiento_ficha) : null;
                return {
                    ...r,
                    // Desviación en PUNTOS: ficha 60 y real 44 ⇒ −16 pts (la ficha es optimista,
                    // el coste real es mayor). Null si la ficha no tiene rendimiento.
                    desviacion_pts: ficha !== null && Number.isFinite(real)
                        ? Math.round((real - ficha) * 100) / 100
                        : null
                };
            });

            res.json({ rendimientos: resumen, total: resumen.length });
        } catch (err) {
            log('error', 'Error en resumen de rendimientos', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== LISTAR ==========
    router.get('/elaboraciones', globalLimiter, authMiddleware, async (req, res) => {
        try {
            const { ingredienteId, desde, hasta } = req.query;
            const params = [req.restauranteId];
            let where = 'restaurante_id = $1 AND deleted_at IS NULL';

            if (ingredienteId) {
                const idCheck = validateId(ingredienteId);
                if (!idCheck.valid) return res.status(400).json({ error: `ingredienteId: ${idCheck.error}` });
                params.push(idCheck.value);
                where += ` AND ingrediente_id = $${params.length}`;
            }
            if (desde) {
                const d = validateDate(desde);
                if (!d.valid) return res.status(400).json({ error: `desde: ${d.error}` });
                params.push(desde);
                where += ` AND fecha >= $${params.length}`;
            }
            if (hasta) {
                const h = validateDate(hasta);
                if (!h.valid) return res.status(400).json({ error: `hasta: ${h.error}` });
                params.push(hasta);
                where += ` AND fecha < $${params.length}`;
            }

            const { rows } = await pool.query(
                `SELECT id, ingrediente_id, ingrediente_nombre, cantidad_bruta, cantidad_neta,
                        rendimiento_real, nota, usuario_id, fecha, created_at
                 FROM elaboraciones
                 WHERE ${where}
                 ORDER BY fecha DESC, id DESC
                 LIMIT 500`,
                params
            );

            res.json({ elaboraciones: rows, total_registros: rows.length });
        } catch (err) {
            log('error', 'Error listando elaboraciones', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== REGISTRAR (no toca stock: es una medición) ==========
    router.post('/elaboraciones', globalLimiter, authMiddleware, async (req, res) => {
        try {
            const { ingredienteId, cantidadBruta, cantidadNeta, nota, fecha } = req.body;

            const idCheck = validateId(ingredienteId);
            if (!idCheck.valid) return res.status(400).json({ error: `ingredienteId: ${idCheck.error}` });

            const calc = calcularRendimientoReal(cantidadBruta, cantidadNeta);
            if (!calc.valid) return res.status(400).json({ error: calc.error });

            // Fecha opcional: por defecto hoy; pasado sí (apuntar lo de ayer), futuro no.
            let fechaElaboracion = new Date();
            if (fecha) {
                const f = validateDate(fecha, { allowFuture: false });
                if (!f.valid) return res.status(400).json({ error: `fecha: ${f.error}` });
                fechaElaboracion = f.value;
            }

            const notaLimpia = nota ? sanitizeString(nota, 500) : null;

            // 🔒 Cross-tenant: el ingrediente debe ser del tenant y no estar borrado.
            const ingRes = await pool.query(
                'SELECT id, nombre, rendimiento FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [idCheck.value, req.restauranteId]
            );
            if (ingRes.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado en este restaurante' });
            }
            const ingrediente = ingRes.rows[0];

            const insertRes = await pool.query(
                `INSERT INTO elaboraciones
                 (restaurante_id, ingrediente_id, ingrediente_nombre, cantidad_bruta,
                  cantidad_neta, rendimiento_real, nota, usuario_id, fecha)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [
                    req.restauranteId, ingrediente.id, ingrediente.nombre, calc.bruta,
                    calc.neta, calc.rendimiento, notaLimpia, req.user?.id || null,
                    fechaElaboracion.toISOString().split('T')[0]
                ]
            );

            logChange(pool, {
                req, tabla: 'elaboraciones', operacion: 'INSERT',
                registroId: insertRes.rows[0].id,
                datosAntes: null, datosDespues: insertRes.rows[0]
            });

            // La ficha viaja en la respuesta para que el modal pinte la comparación
            // al momento ("real 44% vs ficha 60%") sin otra llamada.
            res.status(201).json({
                ...insertRes.rows[0],
                rendimiento_ficha: ingrediente.rendimiento !== null ? parseFloat(ingrediente.rendimiento) : null
            });
        } catch (err) {
            log('error', 'Error registrando elaboración', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== BORRAR (soft delete; no hay stock que revertir) ==========
    router.delete('/elaboraciones/:id', globalLimiter, authMiddleware, requireAdmin, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

            const { rows } = await pool.query(
                `UPDATE elaboraciones SET deleted_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL
                 RETURNING *`,
                [idCheck.value, req.restauranteId]
            );
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Elaboración no encontrada' });
            }

            logChange(pool, {
                req, tabla: 'elaboraciones', operacion: 'DELETE',
                registroId: idCheck.value,
                datosAntes: rows[0], datosDespues: null
            });

            res.json({ success: true, id: idCheck.value });
        } catch (err) {
            log('error', 'Error borrando elaboración', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
