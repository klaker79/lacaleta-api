/**
 * stripe.routes.js — endpoint de lectura del plan (LEGACY PATH)
 *
 * Histórico: este archivo contenía la integración completa con Stripe
 * (checkout, webhook, customer portal, choose-starter). Tras el cambio
 * de pricing del 2026-05-10 a single-plan (95€/mes) + add-on Chat IA
 * (30€/mes vía Polar), Stripe se eliminó por completo.
 *
 * Solo queda el endpoint de lectura `GET /stripe/subscription-status`
 * porque el frontend lo consume desde varios sitios (subscription.js,
 * authStore.js, api/client.js). Se mantiene el path por compatibilidad
 * hasta que el PR de Polar plan base lo renombre a /subscription/status.
 *
 * NO requiere `stripe` SDK ni env vars STRIPE_*. Solo lee de la BD.
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');

module.exports = function (pool) {
    const router = Router();

    router.get('/stripe/subscription-status', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT plan, plan_status, trial_ends_at, max_users, stripe_subscription_id
                 FROM restaurantes WHERE id = $1`,
                [req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            const row = result.rows[0];
            const trialExpired = row.plan === 'trial' && row.trial_ends_at && new Date(row.trial_ends_at) < new Date();
            const daysLeft = row.trial_ends_at
                ? Math.max(0, Math.ceil((new Date(row.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
                : null;

            res.json({
                plan: row.plan,
                plan_status: trialExpired ? 'expired' : row.plan_status,
                trial_ends_at: row.trial_ends_at,
                trial_days_left: daysLeft,
                max_users: row.max_users,
                has_subscription: !!row.stripe_subscription_id
            });
        } catch (err) {
            log('error', 'Error obteniendo estado de suscripción', { error: err.message });
            res.status(500).json({ error: 'Error al obtener estado de suscripción' });
        }
    });

    return router;
};
