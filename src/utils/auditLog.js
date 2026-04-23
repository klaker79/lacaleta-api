/**
 * auditLog.js — Helper "fire-and-forget" para registrar cambios sensibles
 *
 * Objetivo: trazabilidad de quién modificó qué (tabla, registro, datos
 * antes/después) sin bloquear ni ralentizar la operación principal.
 *
 * Semántica:
 *   - logChange() NO hace `await` internamente. Devuelve una Promise que el
 *     caller puede ignorar (fire-and-forget). Si el INSERT en audit_log falla,
 *     solo emite un log('warn', ...) — la operación original ya ha completado.
 *   - Si el caller quiere garantías más fuertes (p.ej. en tests), puede hacer
 *     `await logChange(...)` y capturar errores.
 *
 * Patrón en un endpoint típico:
 *
 *     // ... lógica del UPDATE/DELETE real ...
 *     await client.query('COMMIT');
 *
 *     // Después del COMMIT, registrar cambio (no bloquea la respuesta)
 *     logChange(pool, {
 *         req,
 *         tabla: 'recetas',
 *         operacion: 'UPDATE',
 *         registroId: id,
 *         datosAntes: recetaVieja,   // row completa antes del UPDATE
 *         datosDespues: recetaNueva, // row completa tras el UPDATE
 *     });
 *
 *     res.json(...);
 *
 * Diseño:
 *   - `datos_antes` y `datos_despues` son JSONB → flexibles sin migraciones
 *     cuando se añaden columnas a tablas auditadas.
 *   - `user_id` / `user_email` denormalizados: facilitar consultas en
 *     superadmin panel sin JOIN.
 *   - `restaurante_id` obligatorio — la UI de superadmin filtra siempre por
 *     tenant. Sin el tenant, no podemos aislar auditorías cross-customer.
 */

const { log } = require('./logger');

/**
 * Registra un cambio en audit_log.
 *
 * @param {import('pg').Pool} pool - Pool de Postgres.
 * @param {object} params
 * @param {object} params.req         - Objeto Express request (extrae user + ip + ua).
 * @param {string} params.tabla       - Tabla afectada (ej. 'recetas', 'ingredientes').
 * @param {string} params.operacion   - 'INSERT' | 'UPDATE' | 'DELETE'.
 * @param {number} params.registroId  - id del registro afectado en esa tabla.
 * @param {object|null} [params.datosAntes]   - Fila completa antes (null en INSERT).
 * @param {object|null} [params.datosDespues] - Fila completa después (null en DELETE).
 * @returns {Promise<void>}
 */
async function logChange(pool, params) {
    const {
        req,
        tabla,
        operacion,
        registroId,
        datosAntes = null,
        datosDespues = null,
    } = params || {};

    if (!req || !tabla || !operacion || registroId == null) {
        // No registramos entradas incompletas — silencioso, la operación
        // principal no se ve afectada.
        return;
    }

    const restauranteId = req.restauranteId ?? null;
    const userId = req.user?.userId ?? null;
    const userEmail = req.user?.email ?? null;
    const ipAddress = req.ip || req.headers?.['x-forwarded-for'] || null;
    const userAgent = req.headers?.['user-agent']?.slice(0, 500) || null;

    try {
        await pool.query(
            `INSERT INTO audit_log
                (user_id, user_email, restaurante_id, tabla, operacion,
                 registro_id, datos_antes, datos_despues, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                userId,
                userEmail,
                restauranteId,
                tabla,
                operacion,
                registroId,
                datosAntes ? JSON.stringify(datosAntes) : null,
                datosDespues ? JSON.stringify(datosDespues) : null,
                ipAddress,
                userAgent,
            ]
        );
    } catch (err) {
        // Fire-and-forget: un fallo en audit_log NO rompe la operación
        // original. Emitimos 'error' (no 'warn') para que suba a Sentry y
        // nos enteremos si el audit se rompe — si no, la pérdida es silenciosa.
        log('error', 'auditLog: INSERT fallido', {
            error: err.message,
            tabla,
            operacion,
            registroId,
            restauranteId,
        });
    }
}

module.exports = { logChange };
