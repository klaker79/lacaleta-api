/**
 * requireActiveSubscription.js — middleware genérico para rutas que requieren
 * que el restaurante tenga una suscripción ACTIVA o esté en trial NO caducado.
 *
 * Decisión de producto (Iker, 2026-06-08, single-plan model):
 *  - Ya NO hay niveles (starter/profesional/premium). Self y Pro dan la MISMA
 *    funcionalidad en la app — la diferencia es servicio humano que da Iker
 *    aparte (onboarding del Pro). Por tanto basta con saber si el tenant
 *    "tiene derecho a usar la app" o no.
 *  - Al expirar el trial sin pagar → TODO se apaga. Solo siguen accesibles las
 *    rutas exentas (login, status, webhooks Polar, etc.) para que pueda pagar.
 *
 * Reglas que aplica este middleware (responde 403 si NO se cumple ninguna):
 *  1. plan_status === 'active'  → OK (suscripción de pago vigente)
 *  2. plan === 'trial' Y trial_ends_at > now()  → OK (trial vigente)
 *  3. cualquier otro caso → 403 SUBSCRIPTION_REQUIRED
 *
 * El body del 403 incluye:
 *   - error: 'SUBSCRIPTION_REQUIRED'
 *   - reason: 'trial_expired' | 'no_subscription' | 'cancelled'
 *   - trial_ended_at: ISO string si reason === 'trial_expired'
 *
 * Frontend lo intercepta globalmente y muestra modal overlay con CTA Polar.
 *
 * NO usar este middleware en rutas que el usuario NECESITA para pagar:
 *   - /auth/login, /auth/logout
 *   - /chat-status, /plans, /polar/webhook, /polar/checkout
 *   - /config (lectura del usuario para mostrar email/teléfono)
 */
const { log } = require('../utils/logger');

function requireActiveSubscription(pool) {
    return async (req, res, next) => {
        try {
            const restauranteId = req.restauranteId;
            if (!restauranteId) {
                return res.status(401).json({ error: 'NO_TENANT', message: 'No restaurante asociado al usuario' });
            }
            const { rows } = await pool.query(
                'SELECT plan, plan_status, trial_ends_at FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            if (rows.length === 0) {
                return res.status(404).json({ error: 'TENANT_NOT_FOUND' });
            }
            const { plan, plan_status, trial_ends_at } = rows[0];

            // Regla 1: suscripción de pago activa
            if (plan_status === 'active') {
                req.subscription = { active: true, plan, plan_status };
                return next();
            }

            // Regla 2: trial vigente
            if (plan === 'trial' && trial_ends_at && new Date(trial_ends_at) > new Date()) {
                req.subscription = { active: true, plan: 'trial', plan_status, trial_ends_at };
                return next();
            }

            // Bloqueo: trial caducado o sin suscripción
            const reason = (plan === 'trial' && trial_ends_at && new Date(trial_ends_at) <= new Date())
                ? 'trial_expired'
                : (plan_status === 'cancelled' || plan_status === 'past_due')
                    ? 'cancelled'
                    : 'no_subscription';

            return res.status(403).json({
                error: 'SUBSCRIPTION_REQUIRED',
                reason,
                trial_ended_at: reason === 'trial_expired' ? trial_ends_at : undefined,
                plan,
                plan_status
            });
        } catch (err) {
            log('error', 'requireActiveSubscription failed', { error: err.message });
            return res.status(503).json({ error: 'Servicio temporalmente no disponible' });
        }
    };
}

module.exports = { requireActiveSubscription };
