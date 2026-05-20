/**
 * subscription.routes.js — checkout y portal del plan base MindLoop CostOS (95€/mes).
 *
 * Pricing tras 2026-05-10:
 *   - Plan base: 95€/mes (Polar, product POLAR_PRODUCT_ID_BASE)
 *   - Add-on Chat IA: +30€/mes (Polar, product POLAR_PRODUCT_ID_CHAT_ADDON,
 *     ver chat.routes.js)
 *
 * Endpoints:
 *   POST /subscription/checkout-base   → URL Polar para suscribirse al plan base
 *   POST /subscription/customer-portal → URL Polar Customer Portal (gestiona ambas
 *                                        suscripciones del mismo customer)
 *
 * Diseño: igual que chat.routes.js, el flag funcional (`restaurantes.plan_status`)
 * SOLO lo cambia el webhook firmado por Polar. El frontend nunca puede activar el
 * plan sin pagar — un click en "Suscribirse 95€" solo crea un checkout.
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const polarService = require('../services/polarService');

module.exports = function (pool) {
    const router = Router();

    // Rate-limited: cada llamada crea un checkout/session en Polar (API externa
    // con coste). Sin limit un actor autenticado podría generar miles de
    // sessions abandonadas y consumir cuota / saturar el portal.
    router.post('/subscription/checkout-base', costlyApiLimiter, authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }

        const productId = process.env.POLAR_PRODUCT_ID_BASE;
        if (!productId) {
            log('error', 'POLAR_PRODUCT_ID_BASE no configurada');
            return res.status(500).json({ error: 'Plan base no configurado' });
        }

        const origin = req.headers.origin;
        if (!origin) {
            return res.status(400).json({ error: 'Origin header requerido' });
        }

        try {
            const session = await polarService.createCheckoutSession({
                restauranteId,
                productId,
                origin,
                addonType: 'base'
            });
            log('info', 'Polar checkout session creada (plan base)', {
                restauranteId,
                checkoutId: session.id
            });
            res.json({ url: session.url });
        } catch (err) {
            log('error', '/subscription/checkout-base failed', {
                restauranteId,
                error: err.message
            });
            res.status(502).json({ error: 'Error creando sesión de pago' });
        }
    });

    // Portal Polar para gestionar la suscripción (cancelar, cambiar tarjeta,
    // descargar facturas). El mismo portal sirve para el plan base y el add-on,
    // porque ambos productos comparten customer en Polar.
    // Rate-limited: cada llamada crea un customer-session token en Polar.
    router.post('/subscription/customer-portal', costlyApiLimiter, authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        try {
            const session = await polarService.createCustomerPortalSession({ restauranteId });
            res.json({ url: session.url });
        } catch (err) {
            log('error', '/subscription/customer-portal failed', {
                restauranteId,
                error: err.message
            });
            res.status(400).json({
                error: 'No se pudo abrir el portal. ¿Tienes una suscripción activa?'
            });
        }
    });

    return router;
};
