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
const { log } = require('../utils/logger');
const { processChat } = require('../services/chatService');

module.exports = function (pool) {
    const router = Router();

    router.post('/chat', costlyApiLimiter, authMiddleware, async (req, res) => {
        const { message, lang } = req.body || {};
        const restauranteId = req.restauranteId;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'message is required' });
        }
        if (message.length > 4000) {
            return res.status(400).json({ error: 'message too long (max 4000 chars)' });
        }
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }

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
