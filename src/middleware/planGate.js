/**
 * planGate.js — Middleware to restrict access based on restaurant plan
 * 
 * Usage:
 *   router.get('/intelligence/freshness', authMiddleware, requirePlan('profesional'), handler)
 *   router.post('/chat/ask', authMiddleware, requirePlan('premium'), handler)
 * 
 * Plan hierarchy: trial < starter < profesional < premium
 * Trial has same access as profesional (14-day full experience)
 */
const { log } = require('../utils/logger');

const PLAN_LEVELS = {
    starter: 1,
    trial: 2,       // Trial = profesional access (so they experience the full product)
    profesional: 2,
    premium: 3
};

/**
 * Returns middleware that checks if the restaurant's plan meets the minimum required
 * @param {string} minimumPlan - 'starter', 'profesional', or 'premium'
 */
function requirePlan(minimumPlan) {
    const minimumLevel = PLAN_LEVELS[minimumPlan] || 0;

    return async (req, res, next) => {
        try {
            // req.restauranteId is set by authMiddleware
            const pool = req.app.locals.pool;
            if (!pool) {
                log('error', 'planGate: pool no disponible en app.locals');
                return next(); // Fail open if pool not available (shouldn't happen)
            }

            const result = await pool.query(
                'SELECT plan, plan_status, trial_ends_at FROM restaurantes WHERE id = $1',
                [req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            const { plan, plan_status, trial_ends_at } = result.rows[0];

            // Allow active or trialing subscriptions
            if (plan_status !== 'active' && plan_status !== 'trialing') {
                return res.status(403).json({
                    error: 'Suscripción no activa',
                    plan_status,
                    upgrade_url: '/planes'
                });
            }

            // Check if trial has expired
            if (plan === 'trial' && trial_ends_at && new Date(trial_ends_at) < new Date()) {
                return res.status(403).json({
                    error: 'Tu periodo de prueba ha expirado',
                    trial_expired: true,
                    upgrade_url: '/planes'
                });
            }

            // Check plan level
            const userLevel = PLAN_LEVELS[plan] || 0;
            if (userLevel < minimumLevel) {
                return res.status(403).json({
                    error: `Esta función requiere el plan ${minimumPlan}`,
                    current_plan: plan,
                    required_plan: minimumPlan,
                    upgrade_url: '/planes'
                });
            }

            // Plan check passed — attach plan info to request
            req.plan = plan;
            req.planStatus = plan_status;
            next();
        } catch (err) {
            log('error', 'Error en planGate', { error: err.message });
            next(); // Fail open on error to not break existing functionality
        }
    };
}

module.exports = { requirePlan, PLAN_LEVELS };
