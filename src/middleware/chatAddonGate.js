/**
 * chatAddonGate — middleware para POST /chat.
 *
 * Comportamiento:
 *   1. Lee el estado del add-on y contador del restaurante actual.
 *   2. Si el contador se incrementaría a más del límite tras consumir
 *      esta consulta, rechaza con 429 (cuota agotada).
 *   3. Si el reset_at lleva > 30 días, lo resetea perezosamente.
 *   4. Si chat_addon === false → 403 (CHAT_NOT_ACTIVATED).
 *   5. Si todo OK → incrementa contador en BBDD ATÓMICAMENTE
 *      (UPDATE ... RETURNING) y deja pasar al handler.
 *
 * Por qué ATOMIC: dos consultas concurrentes podrían leer 299, decidir que
 * ambas pasan y dejar el contador en 301. El UPDATE ... RETURNING garantiza
 * exclusión mutua a nivel de fila.
 *
 * Por qué reset perezoso (no cron): no necesitamos un cron — al primer
 * acceso post-reset_at+30d el middleware detecta y resetea. Más simple,
 * sin dependencias adicionales.
 */

const { log } = require('../utils/logger');

const CHAT_MONTHLY_LIMIT = 300;
const RESET_INTERVAL_DAYS = 30;

function chatAddonGate(pool) {
    return async function (req, res, next) {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const lockResult = await client.query(
                `SELECT chat_addon,
                        chat_consultas_mes,
                        chat_consultas_reset_at,
                        chat_consultas_reset_at + INTERVAL '${RESET_INTERVAL_DAYS} days' AS next_reset
                 FROM restaurantes
                 WHERE id = $1
                 FOR UPDATE`,
                [restauranteId]
            );
            if (lockResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }
            const { chat_addon, chat_consultas_mes, next_reset } = lockResult.rows[0];

            if (!chat_addon) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    error: 'CHAT_NOT_ACTIVATED',
                    message: 'El add-on Chat IA no está activado para este restaurante.'
                });
            }

            // Reset perezoso: si el ciclo mensual ha caducado, ponemos contador a 0
            // y avanzamos reset_at en bloques de 30 días hasta colocarnos en el futuro.
            const now = new Date();
            let consumed = chat_consultas_mes;
            if (now >= new Date(next_reset)) {
                await client.query(
                    `UPDATE restaurantes
                     SET chat_consultas_mes = 0,
                         chat_consultas_reset_at = NOW()
                     WHERE id = $1`,
                    [restauranteId]
                );
                consumed = 0;
            }

            if (consumed >= CHAT_MONTHLY_LIMIT) {
                await client.query('ROLLBACK');
                // Devolvemos cuándo vuelve a estar disponible para que el frontend
                // lo muestre en el chat con un mensaje claro.
                return res.status(429).json({
                    error: 'CHAT_QUOTA_EXCEEDED',
                    message: 'Cuota mensual de consultas alcanzada.',
                    used: consumed,
                    limit: CHAT_MONTHLY_LIMIT,
                    resets_at: next_reset
                });
            }

            // Incrementar atómicamente y comitear. Si processChat falla luego
            // (timeout Anthropic, etc.) NO descontamos — preferimos que el cliente
            // reintente sin gastarle 2 consultas en una.
            const incResult = await client.query(
                `UPDATE restaurantes
                 SET chat_consultas_mes = chat_consultas_mes + 1
                 WHERE id = $1
                 RETURNING chat_consultas_mes`,
                [restauranteId]
            );
            await client.query('COMMIT');

            req.chatQuota = {
                used: incResult.rows[0].chat_consultas_mes,
                limit: CHAT_MONTHLY_LIMIT
            };
            next();
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { /* swallow */ });
            log('error', 'chatAddonGate failed', {
                restauranteId,
                error: err.message
            });
            res.status(500).json({ error: 'Error verificando cuota del chat' });
        } finally {
            client.release();
        }
    };
}

module.exports = { chatAddonGate, CHAT_MONTHLY_LIMIT, RESET_INTERVAL_DAYS };
