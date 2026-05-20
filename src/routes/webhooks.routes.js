/**
 * Webhooks routes — entrada de eventos firmados por proveedores externos.
 *
 * POST /webhooks/polar
 *   Body crudo (raw). El parser global de express.json se salta esta ruta
 *   en server.js — sin eso la firma no validaría.
 *
 *   Productos manejados (ramificados por metadata.addon_type):
 *     - addon_type='chat_ia' → flag chat_addon en restaurantes +
 *       tabla chat_addon_subscriptions
 *     - addon_type='base'    → plan_status en restaurantes +
 *       tabla base_subscriptions
 *
 *   Eventos manejados:
 *     - subscription.created  → primer alta, normalmente status="active"
 *     - subscription.active   → activación efectiva
 *     - subscription.updated  → cambios de plan/precio
 *     - subscription.canceled → cancelación a fin de ciclo
 *     - subscription.revoked  → cancelación inmediata (chargeback, fraude)
 *
 *   Idempotencia: ambas tablas tienen UNIQUE en polar_subscription_id.
 *   Si Polar reintenta el mismo evento, el ON CONFLICT lo absorbe sin
 *   efectos duplicados.
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

            // Ramificación por tipo de producto (metadata.addon_type).
            //   'chat_ia' → flag chat_addon + tabla chat_addon_subscriptions
            //   'base'    → plan_status + tabla base_subscriptions
            //   otro/nulo → 200 OK con flag other_product (no procesar)
            const addonType = data.metadata?.addon_type;
            if (addonType !== 'chat_ia' && addonType !== 'base') {
                return res.status(200).json({ received: true, other_product: true });
            }

            const status = data.status; // 'active' | 'canceled' | 'revoked' | ...
            const polarSubId = data.id;
            const polarCustomerId = data.customer?.id || data.customerId || null;
            const periodEnd = data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : null;
            const shouldEnable = status === 'active';
            const shouldDisable = ['canceled', 'revoked', 'past_due', 'unpaid', 'incomplete_expired'].includes(status);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                if (addonType === 'chat_ia') {
                    // ---- ADD-ON CHAT IA (30€/mes) ----
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
                    } else if (shouldDisable) {
                        await client.query(
                            `UPDATE restaurantes SET chat_addon = false WHERE id = $1`,
                            [restauranteId]
                        );
                    }
                } else {
                    // ---- PLAN BASE MINDLOOP COSTOS (95€/mes) ----
                    await client.query(
                        `INSERT INTO base_subscriptions
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

                    // Mapeamos status Polar a plan_status interno.
                    // active → 'active'. past_due → 'past_due'.
                    // canceled/revoked/unpaid → 'canceled'.
                    // El resto de estados intermedios (incomplete, trialing) los
                    // dejamos en 'pending_payment' para no abrir acceso prematuro.
                    let nextPlanStatus = null;
                    if (shouldEnable) nextPlanStatus = 'active';
                    else if (status === 'past_due') nextPlanStatus = 'past_due';
                    else if (shouldDisable) nextPlanStatus = 'canceled';

                    if (nextPlanStatus) {
                        await client.query(
                            `UPDATE restaurantes
                             SET plan_status = $1,
                                 plan = 'base'
                             WHERE id = $2`,
                            [nextPlanStatus, restauranteId]
                        );
                    }
                }

                await client.query('COMMIT');
                log('info', 'Polar webhook procesado', {
                    eventType,
                    addonType,
                    restauranteId,
                    status
                });
                res.status(200).json({ received: true });
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                log('error', 'Polar webhook DB error', {
                    eventType,
                    addonType,
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
