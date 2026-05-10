/**
 * Chat Routes — Claude API backend replacement for n8n chat webhook
 *
 * POST /api/chat
 *   - Requires JWT auth (extracts restauranteId)
 *   - Rate limited (costlyApiLimiter: 30 req/15min per IP)
 *   - Body: { message, sessionId?, lang? }
 *   - Response: text/plain with the assistant's reply
 *
 * Response contract is plain text (same as n8n webhook) so the existing
 * chat-widget.js can read it via response.text() without changes.
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
const { chatAddonGate, CHAT_MONTHLY_LIMIT, RESET_INTERVAL_DAYS } = require('../middleware/chatAddonGate');
const { log } = require('../utils/logger');
const { processChat } = require('../services/chatService');
const polarService = require('../services/polarService');

module.exports = function (pool) {
    const router = Router();

    // GET /chat-status — el frontend llama aquí para saber si el widget se
    // muestra y cuántas consultas le quedan. Si addon=false el cliente verá
    // un CTA "Activar Asistente IA"; si está activado verá el chat con
    // contador "X/300 este mes".
    router.get('/chat-status', authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        try {
            const result = await pool.query(
                `SELECT chat_addon,
                        chat_consultas_mes,
                        chat_consultas_reset_at,
                        chat_consultas_reset_at + INTERVAL '${RESET_INTERVAL_DAYS} days' AS next_reset
                 FROM restaurantes
                 WHERE id = $1`,
                [restauranteId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }
            const row = result.rows[0];
            res.json({
                enabled: row.chat_addon,
                used: row.chat_consultas_mes,
                limit: CHAT_MONTHLY_LIMIT,
                resets_at: row.next_reset
            });
        } catch (err) {
            log('error', '/chat-status failed', { restauranteId, error: err.message });
            res.status(500).json({ error: 'Error obteniendo estado del chat' });
        }
    });

    // Activación del add-on: NO toca chat_addon directamente. Crea checkout
    // session en Polar y devuelve URL — el cliente paga ahí, Polar manda
    // webhook subscription.active y el handler en webhooks.routes.js
    // pone chat_addon=true.
    //
    // Diseño: el flag SOLO lo cambia el webhook firmado. El cliente nunca
    // puede activar el add-on sin pagar — un click en "Activar" solo crea
    // un checkout, no escribe en BBDD.
    router.post('/chat-addon/checkout-session', authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        const productId = process.env.POLAR_PRODUCT_ID_CHAT_ADDON;
        if (!productId) {
            log('error', 'POLAR_PRODUCT_ID_CHAT_ADDON no configurada');
            return res.status(500).json({ error: 'Polar product no configurado' });
        }
        // origin del cliente para volver tras pagar. Validamos contra ALLOWED_ORIGINS
        // (ya hardcodeados en server.js) implícitamente: solo aceptamos el header Origin.
        const origin = req.headers.origin;
        if (!origin) {
            return res.status(400).json({ error: 'Origin header requerido' });
        }
        try {
            const session = await polarService.createCheckoutSession({
                restauranteId,
                productId,
                origin
            });
            log('info', 'Polar checkout session creada', {
                restauranteId,
                checkoutId: session.id
            });
            res.json({ url: session.url });
        } catch (err) {
            log('error', '/chat-addon/checkout-session failed', {
                restauranteId,
                error: err.message
            });
            res.status(502).json({ error: 'Error creando sesión de pago' });
        }
    });

    // Portal del cliente para cancelar/gestionar la sub. Polar emite un token
    // temporal y el cliente accede sin login adicional.
    router.post('/chat-addon/customer-portal', authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        try {
            const session = await polarService.createCustomerPortalSession({ restauranteId });
            res.json({ url: session.url });
        } catch (err) {
            log('error', '/chat-addon/customer-portal failed', {
                restauranteId,
                error: err.message
            });
            // Si el cliente nunca pasó por checkout, Polar no tiene customer
            // todavía → 404 esperable. Lo manejamos con 400 informativo.
            res.status(400).json({
                error: 'No se pudo abrir el portal. ¿Tienes una suscripción activa?'
            });
        }
    });

    // Validación de body antes del addon gate. Razón: body inválido o vacío
    // no debe consumir la cuota mensual del cliente. Tests `400` esperan
    // que la validación corra antes que el gate (preserva contrato anterior).
    function validateChatBody(req, res, next) {
        const { message } = req.body || {};
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'message is required' });
        }
        if (message.length > 4000) {
            return res.status(400).json({ error: 'message too long (max 4000 chars)' });
        }
        next();
    }

    router.post('/chat', costlyApiLimiter, authMiddleware, validateChatBody, chatAddonGate(pool), async (req, res) => {
        const { message, lang } = req.body || {};
        const restauranteId = req.restauranteId;

        try {
            const restResult = await pool.query(
                'SELECT nombre, moneda FROM restaurantes WHERE id = $1 LIMIT 1',
                [restauranteId]
            );
            const restauranteNombre = restResult.rows[0]?.nombre || '';
            // Fallback order: restaurantes.moneda → JWT moneda → €
            const moneda = restResult.rows[0]?.moneda || req.user?.moneda || '€';

            const { text, usage } = await processChat({
                message: message.trim(),
                pool,
                restauranteId,
                lang: lang === 'en' ? 'en' : 'es',
                restauranteNombre,
                moneda
            });

            // Preserve n8n contract: plain text response
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(text);

            // Observability (non-blocking)
            log('info', 'Chat response sent', {
                restauranteId,
                messageLength: message.length,
                responseLength: text.length,
                tokensInput: usage.input,
                tokensOutput: usage.output,
                tokensCacheRead: usage.cache_read,
                tokensCacheCreation: usage.cache_creation
            });
        } catch (err) {
            log('error', 'Chat endpoint failed', {
                restauranteId,
                error: err.message,
                stack: err.stack
            });
            // Return a soft-fail plain text so the UI shows something useful
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.status(502).send(
                lang === 'en'
                    ? '⚠️ The assistant is temporarily unavailable. Please try again in a moment.'
                    : '⚠️ El asistente no está disponible temporalmente. Inténtalo en un momento.'
            );
        }
    });

    return router;
};
