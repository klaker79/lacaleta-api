/**
 * staff Routes — Extracted from server.js
 * Staff management & scheduling
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { sanitizeString, validateNumber, validateId, validateHora } = require('../utils/validators');
const { validarDia, comprobarDescansoEntreJornadas } = require('../utils/jornada');
const { logChange } = require('../utils/auditLog');

const HORA_ENTRADA_DEFECTO = '10:00';

/** 'HH:MM:SS' de Postgres → 'HH:MM'; null si no hay valor. */
function horaCorta(valor) {
    if (valor == null || valor === '') return null;
    const chk = validateHora(valor);
    return chk.valid ? chk.value : null;
}

/**
 * Normaliza el empleado para el frontend: Postgres devuelve TIME como
 * 'HH:MM:SS' y el <input type="time"> necesita 'HH:MM'.
 */
function normalizarEmpleado(row) {
    if (!row) return row;
    return {
        ...row,
        hora_entrada: horaCorta(row.hora_entrada) || HORA_ENTRADA_DEFECTO,
        jornada_tipo: row.jornada_tipo === 'partido' ? 'partido' : 'seguido',
        tramo1_inicio: horaCorta(row.tramo1_inicio) || horaCorta(row.hora_entrada) || HORA_ENTRADA_DEFECTO,
        tramo1_fin: horaCorta(row.tramo1_fin),
        tramo2_inicio: horaCorta(row.tramo2_inicio),
        tramo2_fin: horaCorta(row.tramo2_fin)
    };
}

/** Normaliza un turno (fila de `horarios`) para el frontend. */
function normalizarHorario(row) {
    if (!row) return row;
    return {
        ...row,
        tramo: row.tramo != null ? Number(row.tramo) : 1,
        hora_inicio: horaCorta(row.hora_inicio),
        hora_fin: horaCorta(row.hora_fin)
    };
}

/**
 * Lee y valida la plantilla de jornada del body de un empleado.
 *
 * Acepta `hora_entrada` como alias de `tramo1_inicio` (compatibilidad con el
 * frontend anterior al turno partido). En jornada partida exige la hora de
 * inicio del segundo tramo y que los dos tramos no se solapen.
 *
 * @returns {{jornada_tipo, tramo1_inicio, tramo1_fin, tramo2_inicio, tramo2_fin}|{error: string}}
 */
function leerPlantillaJornada(body) {
    const partido = body.jornada_tipo === 'partido';

    const hora = (valor, campo, defecto = null) => {
        if (valor == null || valor === '') return defecto;
        const chk = validateHora(valor);
        if (!chk.valid) throw new Error(`${campo}: ${chk.error}`);
        return chk.value;
    };

    try {
        const t1i = hora(body.tramo1_inicio ?? body.hora_entrada, 'tramo1_inicio', HORA_ENTRADA_DEFECTO);
        const t1f = hora(body.tramo1_fin, 'tramo1_fin');
        const t2i = hora(body.tramo2_inicio, 'tramo2_inicio');
        const t2f = hora(body.tramo2_fin, 'tramo2_fin');

        if (partido && !t2i) {
            return { error: 'En jornada partida hace falta la hora de inicio del segundo tramo' };
        }

        if (partido && t1f && t2f) {
            const check = validarDia([
                { hora_inicio: t1i, hora_fin: t1f },
                { hora_inicio: t2i, hora_fin: t2f }
            ]);
            if (!check.valid) return { error: check.error };
        }

        return {
            jornada_tipo: partido ? 'partido' : 'seguido',
            tramo1_inicio: t1i,
            tramo1_fin: t1f,
            tramo2_inicio: partido ? t2i : null,
            tramo2_fin: partido ? t2f : null
        };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Avisos de descanso legal (12h) alrededor de una fecha: compara el día con el
 * anterior y con el siguiente. No bloquea nada — es información para el chef.
 * @returns {Promise<string[]>}
 */
async function avisosDescanso(pool, restauranteId, empleadoId, fecha) {
    try {
        const { rows } = await pool.query(
            `SELECT fecha::text AS fecha,
                    to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
                    to_char(hora_fin, 'HH24:MI') AS hora_fin
             FROM horarios
             WHERE empleado_id = $1 AND restaurante_id = $2
               AND fecha BETWEEN $3::date - 1 AND $3::date + 1`,
            [empleadoId, restauranteId, fecha]
        );

        const porDia = new Map();
        for (const r of rows) {
            const dia = r.fecha.slice(0, 10);
            if (!porDia.has(dia)) porDia.set(dia, []);
            porDia.get(dia).push(r);
        }

        const base = new Date(`${fecha}T00:00:00Z`);
        const iso = (offsetDias) => {
            const d = new Date(base);
            d.setUTCDate(d.getUTCDate() + offsetDias);
            return d.toISOString().slice(0, 10);
        };

        const avisos = [];
        for (const [desde, hasta] of [[iso(-1), iso(0)], [iso(0), iso(1)]]) {
            const r = comprobarDescansoEntreJornadas(porDia.get(desde), porDia.get(hasta));
            if (!r.cumple) avisos.push(`${desde} → ${hasta}: ${r.mensaje}`);
        }
        return avisos;
    } catch (e) {
        // Un aviso nunca debe tumbar el guardado del turno.
        log('warn', 'No se pudieron calcular avisos de descanso', { error: e.message });
        return [];
    }
}

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== EMPLEADOS (Staff Management) ==========

    // GET all empleados
    router.get('/empleados', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT * FROM empleados WHERE activo = true AND restaurante_id = $1 ORDER BY nombre',
                [req.restauranteId]
            );
            res.json(result.rows.map(normalizarEmpleado));
        } catch (err) {
            log('error', 'Error obteniendo empleados', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST crear empleado
    router.post('/empleados', authMiddleware, async (req, res) => {
        try {
            const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

            if (!nombre) {
                return res.status(400).json({ error: 'nombre es requerido' });
            }

            const plantilla = leerPlantillaJornada(req.body);
            if (plantilla.error) return res.status(400).json({ error: plantilla.error });

            const result = await pool.query(
                `INSERT INTO empleados (nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto,
                                        hora_entrada, jornada_tipo, tramo1_inicio, tramo1_fin, tramo2_inicio, tramo2_fin, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
                [sanitizeString(nombre), (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : '#3B82F6', validateNumber(horas_contrato, 40, 0, 168), validateNumber(coste_hora, 10, 0, 999), sanitizeString(dias_libres_fijos) || '', sanitizeString(puesto) || 'Camarero',
                    plantilla.tramo1_inicio, plantilla.jornada_tipo, plantilla.tramo1_inicio, plantilla.tramo1_fin, plantilla.tramo2_inicio, plantilla.tramo2_fin, req.restauranteId]
            );

            log('info', 'Empleado creado', { nombre });

            logChange(pool, {
                req, tabla: 'empleados', operacion: 'INSERT',
                registroId: result.rows[0].id,
                datosAntes: null,
                datosDespues: result.rows[0],
            });

            res.status(201).json(normalizarEmpleado(result.rows[0]));
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

            // La plantilla sólo se toca si el body trae algún campo de jornada;
            // si no, `undefined` deja que COALESCE conserve lo que hubiera.
            const tocaJornada = ['jornada_tipo', 'tramo1_inicio', 'tramo1_fin', 'tramo2_inicio', 'tramo2_fin', 'hora_entrada']
                .some(k => req.body[k] !== undefined);

            let p = {};
            if (tocaJornada) {
                p = leerPlantillaJornada(req.body);
                if (p.error) return res.status(400).json({ error: p.error });
            }

            const result = await pool.query(
                `UPDATE empleados SET nombre = COALESCE($1, nombre), color = COALESCE($2, color),
             horas_contrato = COALESCE($3, horas_contrato), coste_hora = COALESCE($4, coste_hora),
             dias_libres_fijos = COALESCE($5, dias_libres_fijos), puesto = COALESCE($6, puesto),
             hora_entrada = COALESCE($7::time, hora_entrada),
             jornada_tipo = COALESCE($8, jornada_tipo),
             tramo1_inicio = COALESCE($9::time, tramo1_inicio),
             -- En 'seguido' los campos del 2º tramo se limpian a propósito.
             tramo1_fin = CASE WHEN $12::boolean THEN $10::time ELSE tramo1_fin END,
             tramo2_inicio = CASE WHEN $12::boolean THEN $11::time ELSE tramo2_inicio END,
             tramo2_fin = CASE WHEN $12::boolean THEN $13::time ELSE tramo2_fin END
             WHERE id = $14 AND restaurante_id = $15 RETURNING *`,
                [sanitizeString(nombre), (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : undefined, horas_contrato != null ? validateNumber(horas_contrato, undefined, 0, 168) : undefined, coste_hora != null ? validateNumber(coste_hora, undefined, 0, 999) : undefined, sanitizeString(dias_libres_fijos), sanitizeString(puesto),
                    p.tramo1_inicio, p.jornada_tipo, p.tramo1_inicio, p.tramo1_fin, p.tramo2_inicio, tocaJornada, p.tramo2_fin, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Empleado no encontrado' });
            }

            logChange(pool, {
                req, tabla: 'empleados', operacion: 'UPDATE',
                registroId: id,
                datosAntes: null,
                datosDespues: result.rows[0],
            });

            res.json(normalizarEmpleado(result.rows[0]));
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

            logChange(pool, {
                req, tabla: 'empleados', operacion: 'DELETE',
                registroId: id,
                datosAntes: { activo: true },
                datosDespues: { activo: false },
            });

            res.json({ success: true });
        } catch (err) {
            log('error', 'Error eliminando empleado', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== HORARIOS (Staff Scheduling) ==========

    // GET horarios por rango de fechas
    router.get('/horarios', authMiddleware, async (req, res) => {
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
             ORDER BY h.fecha, e.nombre, h.tramo`,
                [desde, hasta, req.restauranteId]
            );
            res.json(result.rows.map(normalizarHorario));
        } catch (err) {
            log('error', 'Error obteniendo horarios', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST asignar turno (un tramo del día)
    //
    // Turno partido: se llama dos veces, con tramo 1 y tramo 2. El día completo
    // se valida en conjunto (solapamiento y tope de horas) leyendo el otro
    // tramo que ya haya guardado.
    router.post('/horarios', authMiddleware, async (req, res) => {
        try {
            const { empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas } = req.body;
            const tramo = req.body.tramo != null ? Number(req.body.tramo) : 1;

            if (!empleado_id || !fecha) {
                return res.status(400).json({ error: 'empleado_id y fecha son requeridos' });
            }
            if (tramo !== 1 && tramo !== 2) {
                return res.status(400).json({ error: 'tramo debe ser 1 o 2' });
            }

            // 🔒 Validación cross-tenant (auditoría 2026-05-20):
            // El empleado_id viene del body y debe pertenecer al tenant del request.
            // Sin esta validación, un token de tenant A podría asignar turnos a
            // empleados de tenant B (modificación cross-tenant via ON CONFLICT).
            const empCheck = await pool.query(
                'SELECT id FROM empleados WHERE id = $1 AND restaurante_id = $2',
                [empleado_id, req.restauranteId]
            );
            if (empCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Empleado no encontrado' });
            }

            // Normalizar horas (acepta 'HH:MM' y el 'HH:MM:SS' de Postgres)
            let horaInicio = null, horaFin = null;
            if (hora_inicio != null && hora_inicio !== '') {
                const chk = validateHora(hora_inicio);
                if (!chk.valid) return res.status(400).json({ error: `hora_inicio: ${chk.error}` });
                horaInicio = chk.value;
            }
            if (hora_fin != null && hora_fin !== '') {
                const chk = validateHora(hora_fin);
                if (!chk.valid) return res.status(400).json({ error: `hora_fin: ${chk.error}` });
                horaFin = chk.value;
            }

            // Validar el DÍA completo: este tramo + el otro que ya exista.
            const otros = await pool.query(
                `SELECT tramo, to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
                        to_char(hora_fin, 'HH24:MI') AS hora_fin
                 FROM horarios
                 WHERE empleado_id = $1 AND fecha = $2 AND tramo <> $3 AND restaurante_id = $4`,
                [empleado_id, fecha, tramo, req.restauranteId]
            );
            const dia = [...otros.rows, { tramo, hora_inicio: horaInicio, hora_fin: horaFin }];
            const check = validarDia(dia);
            if (!check.valid) {
                return res.status(400).json({ error: check.error });
            }

            const result = await pool.query(
                `INSERT INTO horarios (empleado_id, fecha, tramo, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (empleado_id, fecha, tramo) DO UPDATE SET
                turno = EXCLUDED.turno, hora_inicio = EXCLUDED.hora_inicio,
                hora_fin = EXCLUDED.hora_fin, es_extra = EXCLUDED.es_extra, notas = EXCLUDED.notas
             RETURNING *`,
                [empleado_id, fecha, tramo, turno || 'completo', horaInicio, horaFin, es_extra || false, notas, req.restauranteId]
            );

            // Aviso (no bloquea): descanso legal contra el día anterior y el siguiente.
            const avisos = await avisosDescanso(pool, req.restauranteId, empleado_id, fecha);

            res.status(201).json({ ...normalizarHorario(result.rows[0]), avisos });
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
    //
    // Sin `?tramo=` borra el día entero (los dos tramos del partido), que es lo
    // que espera el toggle de la rejilla. Con `?tramo=2` borra sólo esa mitad,
    // p.ej. al pasar un día de partido a seguido.
    router.delete('/horarios/empleado/:empleadoId/fecha/:fecha', authMiddleware, async (req, res) => {
        try {
            const { empleadoId, fecha } = req.params;
            const tramo = req.query.tramo != null ? Number(req.query.tramo) : null;

            if (tramo !== null && tramo !== 1 && tramo !== 2) {
                return res.status(400).json({ error: 'tramo debe ser 1 o 2' });
            }

            const result = tramo === null
                ? await pool.query(
                    'DELETE FROM horarios WHERE empleado_id = $1 AND fecha = $2 AND restaurante_id = $3',
                    [empleadoId, fecha, req.restauranteId]
                )
                : await pool.query(
                    'DELETE FROM horarios WHERE empleado_id = $1 AND fecha = $2 AND tramo = $3 AND restaurante_id = $4',
                    [empleadoId, fecha, tramo, req.restauranteId]
                );

            res.json({ success: true, deleted: result.rowCount });
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

            // Audit log: borrado MASIVO de horarios (acción destructiva)
            logChange(pool, {
                req, tabla: 'horarios', operacion: 'DELETE',
                registroId: 0,
                datosAntes: { count: result.rowCount },
                datosDespues: { motivo: 'borrado masivo manual' },
            });

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

            // Obtener horarios de la semana origen (todos los tramos)
            const horariosOrigen = await pool.query(
                `SELECT empleado_id, tramo, turno, hora_inicio, hora_fin, es_extra, notas,
                    fecha - $1::date as dia_offset
             FROM horarios
             WHERE fecha BETWEEN $1 AND ($1::date + 6) AND restaurante_id = $2
             ORDER BY dia_offset, empleado_id, tramo`,
                [semana_origen, req.restauranteId]
            );

            // Insertar en semana destino (el partido copia sus 2 tramos)
            let insertados = 0;
            for (const h of horariosOrigen.rows) {
                const nuevaFecha = new Date(semana_destino);
                nuevaFecha.setDate(nuevaFecha.getDate() + h.dia_offset);

                const insertResult = await pool.query(
                    `INSERT INTO horarios (empleado_id, fecha, tramo, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (empleado_id, fecha, tramo) DO NOTHING
                 RETURNING id`,
                    [h.empleado_id, nuevaFecha.toISOString().split('T')[0], h.tramo || 1, h.turno, h.hora_inicio, h.hora_fin, h.es_extra, h.notas, req.restauranteId]
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
