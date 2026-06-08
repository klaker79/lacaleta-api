/**
 * chatAddonGate — middleware para POST /chat (CUOTA mensual de consultas).
 *
 * IMPORTANTE (2026-06-08): este middleware YA NO chequea `chat_addon`. En el
 * modelo single-plan (Self/Pro), el chat IA viene INCLUIDO en cualquier plan
 * activo. La validación de "tiene derecho a usar la app" la hace ahora
 * `requireActiveSubscription` (que se aplica en chat.routes.js junto con este
 * middleware). Aquí solo gestionamos la CUOTA de 300 consultas/mes.
 *
 * El campo `chat_addon` se mantiene en BD por compatibilidad histórica con los
 * 12 tenants grandfathered (mayo 2026), pero ya no se lee como gate. Si en
 * el futuro se separa el chat como add-on de pago, vuelve el check.
 *
 * Comportamiento:
 *   1. Lee el contador del restaurante.
 *   2. Si el reset_at lleva > 30 días, lo resetea perezosamente.
 *   3. Si el contador llegaría al límite, rechaza con 429 (cuota agotada).
 *   4. Si todo OK → incrementa contador ATÓMICAMENTE (UPDATE ... RETURNING).
 *
 * Por qué ATOMIC: dos consultas concurrentes podrían leer 299, decidir que
 * ambas pasan y dejar el contador en 301. El UPDATE ... RETURNING garantiza
 * exclusión mutua a nivel de fila.
 *
 * Por qué reset perezoso (no cron): al primer acceso post-reset_at+30d el
 * middleware detecta y resetea. Sin dependencias adicionales.
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
                `SELECT chat_consultas_mes,
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
            const { chat_consultas_mes, next_reset } = lockResult.rows[0];

            // (2026-06-08) check de chat_addon eliminado — single-plan model:
            // el chat IA viene incluido en cualquier plan activo. requireActiveSubscription
            // ya rechaza si no hay plan vigente, así que aquí solo gestionamos cuota.

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
