/**
 * onboarding Routes — devuelve el estado del checklist de onboarding
 * para el tenant del token. El frontend lo consume en el dashboard para
 * mostrar el widget "N/4 pasos completados".
 *
 * El marcado de los pasos NO vive aquí — vive como hook dentro de los
 * POST que crean el recurso correspondiente (ver onboardingService.markStep).
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const onboardingService = require('../services/onboardingService');

module.exports = function (pool) {
    const router = Router();

    router.get('/onboarding/status', authMiddleware, async (req, res) => {
        try {
            const status = await onboardingService.getStatus(pool, req.restauranteId);
            res.json(status);
        } catch (err) {
            log('error', 'Error obteniendo estado de onboarding', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
