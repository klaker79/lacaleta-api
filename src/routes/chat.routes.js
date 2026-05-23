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
const { generarInformeMensual } = require('../services/informeMensualService');
const { generarInformeHtml } = require('../services/informeMensualHtml');
const coachReportService = require('../services/coachReportService');

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
                origin,
                addonType: 'chat_ia'
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

    // GET /chat/informe-mensual?mes=YYYY-MM — devuelve JSON con los datos
    // del mes para componer el informe ejecutivo. Solo lectura, sin coste
    // de tokens (NO pasa por chatAddonGate porque no consume cuota Claude).
    // Verifica chat_addon=true manualmente sin incrementar contador.
    router.get('/chat/informe-mensual', authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        const mes = req.query.mes; // 'YYYY-MM' opcional
        try {
            const addonCheck = await pool.query(
                'SELECT chat_addon FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            if (!addonCheck.rows[0]?.chat_addon) {
                return res.status(403).json({ error: 'CHAT_NOT_ACTIVATED' });
            }
            const informe = await generarInformeMensual(pool, restauranteId, mes);
            res.json(informe);
        } catch (err) {
            log('error', '/chat/informe-mensual failed', {
                restauranteId, mes, error: err.message
            });
            res.status(500).json({ error: 'Error generando datos del informe' });
        }
    });

    // GET /chat/informe-mensual/html?mes=YYYY-MM — informe completo en HTML
    // listo para imprimir/guardar como PDF desde el navegador. Hace una
    // llamada Claude (sin tools, single-shot) para el análisis narrativo
    // y el resto se renderiza en backend. No incrementa el contador del
    // chat — los informes no son consultas conversacionales.
    router.get('/chat/informe-mensual/html', costlyApiLimiter, authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        const mes = req.query.mes;
        const lang = req.query.lang === 'en' ? 'en' : 'es';
        try {
            const r = await pool.query(
                'SELECT chat_addon, nombre, moneda FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            const row = r.rows[0];
            if (!row?.chat_addon) {
                return res.status(403).json({ error: 'CHAT_NOT_ACTIVATED' });
            }
            const datos = await generarInformeMensual(pool, restauranteId, mes);
            const { html, usage } = await generarInformeHtml({
                datos,
                restauranteNombre: row.nombre || '',
                moneda: row.moneda || '€',
                lang
            });
            log('info', 'Informe mensual HTML generado', {
                restauranteId, mes: datos.periodo.mes,
                tokensInput: usage.input, tokensOutput: usage.output
            });
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        } catch (err) {
            log('error', '/chat/informe-mensual/html failed', {
                restauranteId, mes, error: err.message, stack: err.stack
            });
            res.status(500).json({ error: 'Error generando informe HTML' });
        }
    });

    // ========== HEALTH CHECK COACH (2026-05-23) ==========
    // POST /chat/health-check — Genera o devuelve el report semanal del Coach.
    // Si ya existe report de la semana ISO actual → lo devuelve cacheado.
    // Si no → invoca Claude con tools y persiste el report.
    // Gating: chat_addon=true (igual que el chat normal). NO incrementa el
    // contador de consultas — es bajo demanda, máximo 1 generación por semana.
    router.post('/chat/health-check', costlyApiLimiter, authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        try {
            const addonCheck = await pool.query(
                'SELECT chat_addon, nombre, moneda FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            const row = addonCheck.rows[0];
            if (!row?.chat_addon) {
                return res.status(403).json({ error: 'CHAT_NOT_ACTIVATED' });
            }
            const report = await coachReportService.getOrCreateWeeklyReport(
                pool,
                restauranteId,
                row.nombre || '',
                row.moneda || '€'
            );
            log('info', 'Health check generado/leído', {
                restauranteId, semana: report.semana_iso
            });
            res.json(report);
        } catch (err) {
            log('error', '/chat/health-check failed', {
                restauranteId, error: err.message
            });
            res.status(500).json({ error: 'Error generando health check' });
        }
    });

    // GET /chat/health-check/status — devuelve si hay report nuevo no leído.
    // Endpoint barato (solo lectura BD), sin Claude. Frontend lo llama al
    // cargar el chat para decidir si pinta el badge "nuevo".
    router.get('/chat/health-check/status', authMiddleware, async (req, res) => {
        const restauranteId = req.restauranteId;
        if (!restauranteId) {
            return res.status(401).json({ error: 'No restaurante asociado al usuario' });
        }
        try {
            const addonCheck = await pool.query(
                'SELECT chat_addon FROM restaurantes WHERE id = $1',
                [restauranteId]
            );
            if (!addonCheck.rows[0]?.chat_addon) {
                return res.json({ has_new: false, addon_enabled: false });
            }
            const status = await coachReportService.getReportStatus(pool, restauranteId);
            res.json({ ...status, addon_enabled: true });
        } catch (err) {
            log('error', '/chat/health-check/status failed', {
                restauranteId, error: err.message
            });
            res.status(500).json({ error: 'Error obteniendo estado del health check' });
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
