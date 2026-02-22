/**
 * stripe.routes.js — Stripe Checkout, Webhooks, Customer Portal
 * 
 * Endpoints:
 *   POST /stripe/create-checkout-session  — Create Stripe Checkout for subscription
 *   POST /stripe/webhook                  — Handle Stripe webhook events (raw body)
 *   POST /stripe/customer-portal          — Create Stripe billing portal session
 *   GET  /stripe/subscription-status      — Get current plan info
 */
const express = require('express');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');

module.exports = function stripeRoutes(pool) {
    const router = express.Router();

    // Initialize Stripe
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
        log('warn', 'STRIPE_SECRET_KEY no configurado — rutas de Stripe deshabilitadas');
        return router; // Return empty router
    }
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

    // Price IDs from environment
    const PRICE_IDS = {
        starter_monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
        starter_annual: process.env.STRIPE_PRICE_STARTER_ANNUAL,
        profesional_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
        profesional_annual: process.env.STRIPE_PRICE_PRO_ANNUAL,
        premium_monthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
        premium_annual: process.env.STRIPE_PRICE_PREMIUM_ANNUAL
    };

    const PLAN_MAX_USERS = {
        starter: 2,
        profesional: 5,
        premium: 999
    };

    // ========== CREATE CHECKOUT SESSION ==========
    router.post('/stripe/create-checkout-session', authMiddleware, async (req, res) => {
        try {
            const { priceKey } = req.body; // e.g., 'profesional_monthly', 'premium_annual'

            if (!priceKey || !PRICE_IDS[priceKey]) {
                return res.status(400).json({
                    error: 'Plan no válido',
                    valid_keys: Object.keys(PRICE_IDS).filter(k => PRICE_IDS[k])
                });
            }

            const priceId = PRICE_IDS[priceKey];
            const restauranteId = req.restauranteId;

            // Get or create Stripe customer
            const restResult = await pool.query(
                'SELECT stripe_customer_id, plan FROM restaurantes WHERE id = $1',
                [restauranteId]
            );

            if (restResult.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            let customerId = restResult.rows[0].stripe_customer_id;

            if (!customerId) {
                // Create Stripe customer
                const userResult = await pool.query(
                    'SELECT email, nombre FROM usuarios WHERE restaurante_id = $1 AND rol = $2 LIMIT 1',
                    [restauranteId, 'admin']
                );
                const user = userResult.rows[0];

                const customer = await stripe.customers.create({
                    email: user?.email,
                    name: user?.nombre,
                    metadata: { restaurante_id: String(restauranteId) }
                });

                customerId = customer.id;
                await pool.query(
                    'UPDATE restaurantes SET stripe_customer_id = $1 WHERE id = $2',
                    [customerId, restauranteId]
                );
            }

            // Determine plan from priceKey
            const plan = priceKey.split('_')[0]; // 'profesional_monthly' → 'profesional'

            // Create checkout session
            const frontendUrl = process.env.FRONTEND_URL || 'https://app.mindloop.cloud';
            const session = await stripe.checkout.sessions.create({
                customer: customerId,
                mode: 'subscription',
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${frontendUrl}/index.html?checkout=success&plan=${plan}`,
                cancel_url: `${frontendUrl}/index.html?checkout=canceled`,
                metadata: {
                    restaurante_id: String(restauranteId),
                    plan
                },
                subscription_data: {
                    metadata: {
                        restaurante_id: String(restauranteId),
                        plan
                    }
                }
            });

            log('info', 'Stripe checkout session creada', { restauranteId, plan, priceKey });
            res.json({ url: session.url });
        } catch (err) {
            log('error', 'Error creando checkout session', { error: err.message });
            res.status(500).json({ error: 'Error al crear sesión de pago' });
        }
    });

    // ========== WEBHOOK ==========
    // Note: This route needs raw body for signature verification.
    // The raw body middleware is applied in server.js BEFORE json parser.
    router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        let event;

        try {
            if (STRIPE_WEBHOOK_SECRET) {
                const sig = req.headers['stripe-signature'];
                event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
            } else {
                // Dev mode: no signature verification
                event = JSON.parse(req.body.toString());
                log('warn', 'Stripe webhook sin verificación de firma (dev mode)');
            }
        } catch (err) {
            log('error', 'Webhook signature verification failed', { error: err.message });
            return res.status(400).json({ error: 'Webhook signature invalid' });
        }

        try {
            switch (event.type) {
                case 'checkout.session.completed': {
                    const session = event.data.object;
                    const restauranteId = parseInt(session.metadata?.restaurante_id);
                    const plan = session.metadata?.plan;
                    const subscriptionId = session.subscription;
                    const customerId = session.customer;

                    if (restauranteId && plan) {
                        await pool.query(
                            `UPDATE restaurantes 
                             SET plan = $1, plan_status = 'active', 
                                 stripe_customer_id = $2, stripe_subscription_id = $3,
                                 max_users = $4, trial_ends_at = NULL
                             WHERE id = $5`,
                            [plan, customerId, subscriptionId, PLAN_MAX_USERS[plan] || 2, restauranteId]
                        );
                        log('info', 'Suscripción activada', { restauranteId, plan });
                    }
                    break;
                }

                case 'customer.subscription.updated': {
                    const subscription = event.data.object;
                    const restauranteId = parseInt(subscription.metadata?.restaurante_id);
                    const status = subscription.status; // 'active', 'past_due', 'canceled', etc.

                    if (restauranteId) {
                        // Map Stripe status to our status
                        const planStatus = ['active', 'trialing'].includes(status) ? status :
                            status === 'past_due' ? 'past_due' : 'canceled';

                        await pool.query(
                            'UPDATE restaurantes SET plan_status = $1, stripe_subscription_id = $2 WHERE id = $3',
                            [planStatus, subscription.id, restauranteId]
                        );
                        log('info', 'Suscripción actualizada', { restauranteId, status: planStatus });
                    }
                    break;
                }

                case 'customer.subscription.deleted': {
                    const subscription = event.data.object;
                    const restauranteId = parseInt(subscription.metadata?.restaurante_id);

                    if (restauranteId) {
                        await pool.query(
                            `UPDATE restaurantes 
                             SET plan_status = 'canceled', stripe_subscription_id = NULL 
                             WHERE id = $1`,
                            [restauranteId]
                        );
                        log('info', 'Suscripción cancelada', { restauranteId });
                    }
                    break;
                }

                case 'invoice.payment_failed': {
                    const invoice = event.data.object;
                    const customerId = invoice.customer;

                    const result = await pool.query(
                        'SELECT id FROM restaurantes WHERE stripe_customer_id = $1',
                        [customerId]
                    );
                    if (result.rows.length > 0) {
                        await pool.query(
                            'UPDATE restaurantes SET plan_status = $1 WHERE stripe_customer_id = $2',
                            ['past_due', customerId]
                        );
                        log('warn', 'Pago fallido', { restauranteId: result.rows[0].id, customerId });
                    }
                    break;
                }

                default:
                    log('debug', `Stripe webhook ignorado: ${event.type}`);
            }

            res.json({ received: true });
        } catch (err) {
            log('error', 'Error procesando webhook', { error: err.message, eventType: event.type });
            res.status(500).json({ error: 'Error procesando webhook' });
        }
    });

    // ========== CUSTOMER PORTAL ==========
    router.post('/stripe/customer-portal', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT stripe_customer_id FROM restaurantes WHERE id = $1',
                [req.restauranteId]
            );

            const customerId = result.rows[0]?.stripe_customer_id;
            if (!customerId) {
                return res.status(400).json({ error: 'No hay suscripción activa' });
            }

            const frontendUrl = process.env.FRONTEND_URL || 'https://app.mindloop.cloud';
            const session = await stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: `${frontendUrl}/index.html`
            });

            res.json({ url: session.url });
        } catch (err) {
            log('error', 'Error creando portal session', { error: err.message });
            res.status(500).json({ error: 'Error al acceder al portal de facturación' });
        }
    });

    // ========== SUBSCRIPTION STATUS ==========
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
