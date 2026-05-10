/**
 * Webhooks routes — entrada de eventos firmados por proveedores externos.
 *
 * POST /webhooks/polar
 *   Body crudo (raw). El parser global de express.json se salta esta ruta
 *   en server.js — sin eso la firma no validaría.
 *
 *   Eventos manejados (suscripción al add-on Chat IA):
 *     - subscription.created  → primer alta, normalmente status="active"
 *     - subscription.active   → activación efectiva
 *     - subscription.updated  → cambios de plan/precio (no aplica aún)
 *     - subscription.canceled → cancelación a fin de ciclo
 *     - subscription.revoked  → cancelación inmediata (chargeback, fraude)
 *
 *   Solo abrimos el flag chat_addon=true cuando status="active". Para
 *   canceled / revoked → chat_addon=false.
 *
 *   Idempotencia: la tabla chat_addon_subscriptions tiene UNIQUE en
 *   polar_subscription_id. Si Polar reintenta el mismo evento, el ON
 *   CONFLICT lo absorbe sin efectos duplicados.
 */

const { Router } = require('express');
const express = require('express');
const { log } = require('../utils/logger');
const polarService = require('../services/polarService');

module.exports = function (pool) {
    const router = Router();

    // express.raw para preservar el body byte-a-byte (necesario para validar
    // firma HMAC). Solo aplicado a esta ruta.
    router.post('/webhooks/polar',
        express.raw({ type: 'application/json' }),
        async (req, res) => {
            // 1. Validar firma. Si falla → 401 para que Polar no reintente
            // indefinidamente con un secret roto.
            let event;
            try {
                event = polarService.verifyWebhook(req.body, req.headers);
            } catch (err) {
                log('warn', 'Polar webhook signature inválida', { error: err.message });
                return res.status(401).json({ error: 'invalid signature' });
            }

            const eventType = event.type;
            const data = event.data || {};

            log('info', 'Polar webhook recibido', {
                type: eventType,
                subscriptionId: data.id,
                status: data.status
            });

            // Solo tratamos subscription.* — el resto los OK-amos para que
            // Polar no reintente, pero no hacen nada.
            if (!eventType?.startsWith('subscription.')) {
                return res.status(200).json({ received: true, ignored: true });
            }

            // Extraer restauranteId del metadata. Si no viene, no podemos
            // procesar — es un evento huérfano (no creado por nuestra app).
            const restauranteId = parseInt(
                data.metadata?.restaurante_id || data.metadata?.restauranteId,
                10
            );
            if (!restauranteId) {
                log('warn', 'Polar event sin restaurante_id en metadata', {
                    subscriptionId: data.id,
                    metadata: data.metadata
                });
                return res.status(200).json({ received: true, no_restaurante: true });
            }

            // Solo nos interesan subs del producto chat_ia. Si Polar manda
            // de otro producto (p.ej. el plan base cuando lo enchufemos),
            // lo ignoramos aquí — habrá un handler distinto.
            const addonType = data.metadata?.addon_type;
            if (addonType && addonType !== 'chat_ia') {
                return res.status(200).json({ received: true, other_product: true });
            }

            const status = data.status; // 'active' | 'canceled' | 'revoked' | ...
            const polarSubId = data.id;
            const polarCustomerId = data.customer?.id || data.customerId || null;
            const periodEnd = data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : null;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Auditoría: insertar o actualizar el registro de la sub.
                await client.query(
                    `INSERT INTO chat_addon_subscriptions
                       (restaurante_id, polar_subscription_id, polar_customer_id,
                        status, current_period_end, raw_event)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (polar_subscription_id) DO UPDATE SET
                       status = EXCLUDED.status,
                       current_period_end = EXCLUDED.current_period_end,
                       raw_event = EXCLUDED.raw_event,
                       updated_at = NOW()`,
                    [restauranteId, polarSubId, polarCustomerId, status, periodEnd, data]
                );

                // Aplicar el efecto al flag chat_addon según el status.
                // active → true. canceled/revoked/incomplete → false.
                const shouldEnable = status === 'active';
                if (shouldEnable) {
                    // Si venía de false, reseteamos contador y reset_at (nuevo ciclo).
                    await client.query(
                        `UPDATE restaurantes
                         SET chat_addon = true,
                             chat_consultas_mes = CASE
                                 WHEN chat_addon = false THEN 0
                                 ELSE chat_consultas_mes
                             END,
                             chat_consultas_reset_at = CASE
                                 WHEN chat_addon = false THEN NOW()
                                 ELSE chat_consultas_reset_at
                             END
                         WHERE id = $1`,
                        [restauranteId]
                    );
                } else if (['canceled', 'revoked', 'past_due', 'unpaid', 'incomplete_expired'].includes(status)) {
                    await client.query(
                        `UPDATE restaurantes SET chat_addon = false WHERE id = $1`,
                        [restauranteId]
                    );
                }

                await client.query('COMMIT');
                log('info', 'Polar webhook procesado', {
                    eventType,
                    restauranteId,
                    status,
                    chatAddonEnabled: shouldEnable
                });
                res.status(200).json({ received: true });
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                log('error', 'Polar webhook DB error', {
                    eventType,
                    restauranteId,
                    error: err.message
                });
                // 500 para que Polar reintente
                res.status(500).json({ error: 'webhook processing failed' });
            } finally {
                client.release();
            }
        }
    );

    return router;
};
