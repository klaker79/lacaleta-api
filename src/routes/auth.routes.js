/**
 * Auth Routes — Extraído de server.js
 * Login, Register, Verify email, Forgot/Reset password, Logout, API tokens, Team
 */
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authMiddleware, requireAdmin, tokenBlacklist } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { log } = require('../utils/logger');
const { sanitizeString } = require('../utils/validators');
// URLs parametrizadas (env vars con fallback para backwards-compat)
const APP_URL = process.env.APP_URL || 'https://app.mindloop.cloud';
const API_URL = process.env.API_URL || 'https://lacaleta-api.mindloop.cloud';

// Helper: Escape HTML to prevent XSS
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper: HTML page for email verification result
function verifyPageHTML(title, message, success) {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const color = success ? '#10b981' : '#ef4444';
    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} — MindLoop CostOS</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border-radius:16px;padding:40px;max-width:420px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.icon{font-size:48px;margin-bottom:16px}.title{font-size:22px;font-weight:700;margin-bottom:12px;color:${color}}
.msg{color:#94a3b8;font-size:15px;line-height:1.6;margin-bottom:28px}
.btn{display:inline-block;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;transition:transform .2s}
.btn:hover{transform:translateY(-2px)}</style></head>
<body><div class="card">
<div class="icon">${success ? '🎉' : '⚠️'}</div>
<h1 class="title">${safeTitle}</h1>
<p class="msg">${safeMessage}</p>
<a href="${APP_URL}" class="btn">Ir a MindLoop CostOS</a>
</div></body></html>`;
}

module.exports = function (pool, { resend, JWT_SECRET, INVITATION_CODE }) {
    const router = Router();

    // ========== LOGIN ==========
    router.post('/auth/login', authLimiter, async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ error: 'Email y contraseña requeridos' });
            }

            const result = await pool.query(
                'SELECT u.*, r.nombre as restaurante_nombre FROM usuarios u JOIN restaurantes r ON u.restaurante_id = r.id WHERE u.email = $1',
                [email]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }

            const user = result.rows[0];
            const validPassword = await bcrypt.compare(password, user.password_hash);

            if (!validPassword) {
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }

            // Email verification check
            if (user.email_verified === false) {
                return res.status(403).json({ error: 'Tu cuenta no está verificada. Revisa tu email.', needsVerification: true, email: user.email });
            }

            // Multi-restaurant: check all restaurants this user has access to
            // Exclude pending_payment (not yet paid) and suspended
            const restResult = await pool.query(
                `SELECT ur.restaurante_id, ur.rol, r.nombre, r.plan_status, r.trial_ends_at, r.moneda
                 FROM usuario_restaurantes ur
                 JOIN restaurantes r ON ur.restaurante_id = r.id
                 WHERE ur.usuario_id = $1
                   AND r.plan_status NOT IN ('pending_payment', 'suspended')
                   AND NOT (r.plan_status = 'trialing' AND r.trial_ends_at < NOW())
                 ORDER BY ur.created_at ASC`,
                [user.id]
            );

            // Fallback for users not yet in junction table (pre-migration)
            let restaurants = restResult.rows;
            if (restaurants.length === 0 && user.restaurante_id) {
                // Check if fallback restaurant is valid (not expired trial / not suspended)
                const fallbackCheck = await pool.query(
                    `SELECT plan_status, trial_ends_at FROM restaurantes WHERE id = $1`,
                    [user.restaurante_id]
                );
                const fb = fallbackCheck.rows[0];
                if (fb && !['pending_payment', 'suspended'].includes(fb.plan_status) &&
                    !(fb.plan_status === 'trialing' && fb.trial_ends_at && new Date(fb.trial_ends_at) < new Date())) {
                    restaurants = [{ restaurante_id: user.restaurante_id, rol: user.rol, nombre: user.restaurante_nombre }];
                }
            }

            if (restaurants.length === 0) {
                return res.status(403).json({ error: 'Tu periodo de prueba ha expirado o tu cuenta está suspendida. Contacta con soporte o mejora tu plan.' });
            }

            const isProduction = process.env.NODE_ENV === 'production';

            if (restaurants.length === 1) {
                // Single restaurant: auto-select (backward-compatible)
                const rest = restaurants[0];
                const token = jwt.sign(
                    { userId: user.id, restauranteId: rest.restaurante_id, email: user.email, rol: rest.rol, isSuperAdmin: user.is_superadmin || false },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );

                log('info', 'Login exitoso', { userId: user.id, email, restauranteId: rest.restaurante_id });

                res.cookie('auth_token', token, {
                    httpOnly: true, secure: isProduction, sameSite: 'lax',
                    maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
                });

                res.json({
                    token,
                    user: {
                        id: user.id, email: user.email, nombre: user.nombre,
                        rol: rest.rol, restaurante: rest.nombre,
                        restauranteId: rest.restaurante_id,
                        isSuperAdmin: user.is_superadmin || false,
                        moneda: rest.moneda || '€'
                    },
                    restaurants
                });
            } else {
                // Multiple restaurants: require selection
                const selectionToken = jwt.sign(
                    { userId: user.id, email: user.email, type: 'restaurant_selection', isSuperAdmin: user.is_superadmin || false },
                    JWT_SECRET,
                    { expiresIn: '5m' }
                );

                log('info', 'Login multi-restaurante: selección requerida', { userId: user.id, email, count: restaurants.length });

                res.json({
                    needsSelection: true,
                    selectionToken,
                    restaurants,
                    user: { id: user.id, nombre: user.nombre, email: user.email }
                });
            }
        } catch (err) {
            log('error', 'Error login', { error: err.message });
            res.status(500).json({ error: 'Error en el servidor' });
        }
    });

    // ========== VERIFY TOKEN ==========
    router.get('/auth/verify', authMiddleware, (req, res) => {
        res.json({
            valid: true,
            user: {
                id: req.user.userId,
                email: req.user.email,
                rol: req.user.rol,
                restauranteId: req.restauranteId,
                isSuperAdmin: req.user.isSuperAdmin || false
            },
            tokenInfo: {
                issuedAt: new Date(req.user.iat * 1000).toISOString(),
                expiresAt: new Date(req.user.exp * 1000).toISOString()
            }
        });
    });

    // ========== SELECT RESTAURANT (after multi-restaurant login) ==========
    router.post('/auth/select-restaurant', authLimiter, async (req, res) => {
        try {
            const { selectionToken, restauranteId } = req.body;
            if (!selectionToken || !restauranteId) {
                return res.status(400).json({ error: 'selectionToken y restauranteId requeridos' });
            }

            const decoded = jwt.verify(selectionToken, JWT_SECRET);
            if (decoded.type !== 'restaurant_selection') {
                return res.status(401).json({ error: 'Token de selección inválido' });
            }

            // Verify user has access to this restaurant
            const access = await pool.query(
                'SELECT rol FROM usuario_restaurantes WHERE usuario_id = $1 AND restaurante_id = $2',
                [decoded.userId, restauranteId]
            );
            if (access.rows.length === 0) {
                return res.status(403).json({ error: 'Sin acceso a este restaurante' });
            }

            const rest = await pool.query('SELECT nombre, plan_status, moneda FROM restaurantes WHERE id = $1', [restauranteId]);
            if (rest.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }
            if (['pending_payment', 'suspended'].includes(rest.rows[0].plan_status)) {
                return res.status(403).json({ error: 'Este restaurante no está activo' });
            }

            const token = jwt.sign(
                { userId: decoded.userId, restauranteId: parseInt(restauranteId), email: decoded.email, rol: access.rows[0].rol, isSuperAdmin: decoded.isSuperAdmin || false },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            const isProduction = process.env.NODE_ENV === 'production';
            res.cookie('auth_token', token, {
                httpOnly: true, secure: isProduction, sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
            });

            log('info', 'Restaurante seleccionado', { userId: decoded.userId, restauranteId });

            res.json({
                token,
                user: {
                    id: decoded.userId, email: decoded.email,
                    restaurante: rest.rows[0].nombre, restauranteId: parseInt(restauranteId),
                    rol: access.rows[0].rol, isSuperAdmin: decoded.isSuperAdmin || false,
                    moneda: rest.rows[0].moneda || '€'
                }
            });
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token de selección expirado. Vuelve a iniciar sesión.' });
            }
            log('error', 'Error select-restaurant', { error: err.message });
            res.status(500).json({ error: 'Error en el servidor' });
        }
    });

    // ========== SWITCH RESTAURANT (when already logged in) ==========
    router.post('/auth/switch-restaurant', authMiddleware, async (req, res) => {
        try {
            const { restauranteId } = req.body;
            if (!restauranteId) {
                return res.status(400).json({ error: 'restauranteId requerido' });
            }

            const access = await pool.query(
                'SELECT rol FROM usuario_restaurantes WHERE usuario_id = $1 AND restaurante_id = $2',
                [req.user.userId, restauranteId]
            );
            if (access.rows.length === 0) {
                return res.status(403).json({ error: 'Sin acceso a este restaurante' });
            }

            const rest = await pool.query('SELECT nombre, plan_status, moneda FROM restaurantes WHERE id = $1', [restauranteId]);
            if (rest.rows.length > 0 && ['pending_payment', 'suspended'].includes(rest.rows[0].plan_status)) {
                return res.status(403).json({ error: 'Este restaurante no está activo' });
            }
            if (rest.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }

            const token = jwt.sign(
                { userId: req.user.userId, restauranteId: parseInt(restauranteId), email: req.user.email, rol: access.rows[0].rol, isSuperAdmin: req.user.isSuperAdmin || false },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            const isProduction = process.env.NODE_ENV === 'production';
            res.cookie('auth_token', token, {
                httpOnly: true, secure: isProduction, sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
            });

            log('info', 'Restaurante cambiado', { userId: req.user.userId, from: req.restauranteId, to: restauranteId });

            res.json({
                token,
                user: {
                    id: req.user.userId, email: req.user.email,
                    restaurante: rest.rows[0].nombre, restauranteId: parseInt(restauranteId),
                    rol: access.rows[0].rol, isSuperAdmin: req.user.isSuperAdmin || false,
                    moneda: rest.rows[0].moneda || '€'
                }
            });
        } catch (err) {
            log('error', 'Error switch-restaurant', { error: err.message });
            res.status(500).json({ error: 'Error en el servidor' });
        }
    });

    // ========== MY RESTAURANTS (list accessible restaurants) ==========
    router.get('/auth/my-restaurants', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT ur.restaurante_id as id, ur.rol, r.nombre, r.plan_status
                 FROM usuario_restaurantes ur
                 JOIN restaurantes r ON ur.restaurante_id = r.id
                 WHERE ur.usuario_id = $1
                   AND r.plan_status NOT IN ('pending_payment', 'suspended')
                 ORDER BY ur.created_at ASC`,
                [req.user.userId]
            );
            res.json({ restaurants: result.rows, current: req.restauranteId });
        } catch (err) {
            log('error', 'Error my-restaurants', { error: err.message });
            res.status(500).json({ error: 'Error obteniendo restaurantes' });
        }
    });

    // ========== CREATE ADDITIONAL RESTAURANT (for existing users) ==========
    // Creates restaurant + Stripe customer + Checkout session.
    // Restaurant starts as 'pending_payment'. Webhook activates it after payment.
    const PLAN_ORDER = { starter: 1, trial: 2, profesional: 2, premium: 3 };
    const PLAN_MAX_USERS = { starter: 2, profesional: 5, premium: 999 };

    // Cleanup orphaned pending_payment restaurants for a user
    router.delete('/auth/pending-restaurant/:id', authMiddleware, async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

            // Only delete if it's pending_payment AND belongs to this user
            const result = await pool.query(
                `DELETE FROM restaurantes
                 WHERE id = $1 AND plan_status = 'pending_payment'
                   AND id IN (SELECT restaurante_id FROM usuario_restaurantes WHERE usuario_id = $2)
                 RETURNING id`,
                [id, req.user.userId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'No encontrado o ya activado' });
            }
            // Junction table cleaned by ON DELETE CASCADE
            log('info', 'Restaurante pending_payment limpiado', { userId: req.user.userId, restauranteId: id });
            res.json({ success: true });
        } catch (err) {
            log('error', 'Error limpiando pending restaurant', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.post('/auth/create-restaurant', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { nombre, plan, billing, moneda } = req.body;
            if (!nombre || !nombre.trim()) {
                return res.status(400).json({ error: 'Nombre del restaurante requerido' });
            }
            const validPlans = ['starter', 'profesional', 'premium'];
            if (!plan || !validPlans.includes(plan)) {
                return res.status(400).json({ error: 'Plan requerido: starter, profesional, premium' });
            }
            if (!billing || !['monthly', 'annual'].includes(billing)) {
                return res.status(400).json({ error: 'Billing requerido: monthly, annual' });
            }

            // Each restaurant chooses its own plan independently

            // Stripe price ID from env
            const priceKey = `${plan}_${billing}`;
            const PRICE_MAP = {
                starter_monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
                starter_annual: process.env.STRIPE_PRICE_STARTER_ANNUAL,
                profesional_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
                profesional_annual: process.env.STRIPE_PRICE_PRO_ANNUAL,
                premium_monthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
                premium_annual: process.env.STRIPE_PRICE_PREMIUM_ANNUAL
            };
            const priceId = PRICE_MAP[priceKey];
            if (!priceId) {
                return res.status(400).json({ error: 'Precio no configurado para este plan' });
            }

            await client.query('BEGIN');

            // Cleanup any previous orphaned pending_payment restaurants from this user
            await client.query(
                `DELETE FROM restaurantes
                 WHERE plan_status = 'pending_payment'
                   AND id IN (SELECT restaurante_id FROM usuario_restaurantes WHERE usuario_id = $1)`,
                [req.user.userId]
            );

            // Create restaurant with pending_payment status
            const safeMoneda = moneda ? sanitizeString(String(moneda).slice(0, 10)) : '€';
            const restResult = await client.query(
                `INSERT INTO restaurantes (nombre, email, plan, plan_status, max_users, moneda)
                 VALUES ($1, $2, $3, 'pending_payment', $4, $5) RETURNING id`,
                [sanitizeString(nombre.trim()), req.user.email, plan, PLAN_MAX_USERS[plan] || 2, safeMoneda]
            );
            const restauranteId = restResult.rows[0].id;

            // Link current user as admin
            await client.query(
                'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3)',
                [req.user.userId, restauranteId, 'admin']
            );

            // Create Stripe customer + Checkout session
            const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
            let checkoutUrl = null;

            if (STRIPE_SECRET_KEY) {
                const stripe = require('stripe')(STRIPE_SECRET_KEY);
                const customer = await stripe.customers.create({
                    email: req.user.email,
                    name: sanitizeString(nombre.trim()),
                    metadata: { restaurante_id: String(restauranteId) }
                });

                await client.query(
                    'UPDATE restaurantes SET stripe_customer_id = $1 WHERE id = $2',
                    [customer.id, restauranteId]
                );

                const frontendUrl = process.env.FRONTEND_URL || 'https://app.mindloop.cloud';
                const session = await stripe.checkout.sessions.create({
                    customer: customer.id,
                    mode: 'subscription',
                    line_items: [{ price: priceId, quantity: 1 }],
                    success_url: `${frontendUrl}/index.html?checkout=success&plan=${plan}&new_restaurant=${restauranteId}`,
                    cancel_url: `${frontendUrl}/index.html?checkout=canceled&new_restaurant=${restauranteId}`,
                    metadata: { restaurante_id: String(restauranteId), plan },
                    subscription_data: {
                        metadata: { restaurante_id: String(restauranteId), plan }
                    }
                });
                checkoutUrl = session.url;
            }

            await client.query('COMMIT');

            log('info', 'Restaurante creado (pending_payment)', {
                userId: req.user.userId, restauranteId, plan, billing
            });

            res.status(201).json({ checkoutUrl, restauranteId, plan });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error creando restaurante adicional', { error: err.message });
            res.status(500).json({ error: 'Error creando restaurante' });
        } finally {
            client.release();
        }
    });

    // ========== LOGOUT ==========
    router.post('/auth/logout', (req, res) => {
        const token = req.cookies?.auth_token || req.headers.authorization?.split(' ')[1];
        if (token) {
            tokenBlacklist.add(token);
            log('info', 'Token añadido a blacklist', { blacklistSize: tokenBlacklist.size });
        }
        res.clearCookie('auth_token', { path: '/' });
        log('info', 'Logout exitoso');
        res.json({ success: true, message: 'Sesión cerrada correctamente' });
    });

    // ========== API TOKEN (n8n, Zapier) ==========
    router.post('/auth/api-token', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const { nombre, duracionDias } = req.body;
            const dias = duracionDias || 365;

            const token = jwt.sign(
                {
                    userId: req.user.userId,
                    restauranteId: req.restauranteId,
                    email: req.user.email,
                    rol: 'api',
                    tipo: 'api_token'
                },
                JWT_SECRET,
                { expiresIn: `${dias}d` }
            );

            const tokenHash = await bcrypt.hash(token.slice(-20), 5);
            await pool.query(
                'INSERT INTO api_tokens (restaurante_id, nombre, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
                [req.restauranteId, nombre || 'n8n Integration', tokenHash, new Date(Date.now() + dias * 24 * 60 * 60 * 1000)]
            );

            log('info', 'API Token generado', {
                user: req.user.email,
                nombre: nombre || 'n8n Integration',
                expiraDias: dias
            });

            res.json({
                success: true,
                apiToken: token,
                expiresAt: new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString(),
                instrucciones: {
                    n8n: 'En n8n, configura Header Auth con: Name="Authorization", Value="Bearer ' + token.slice(0, 20) + '..."',
                    curl: `curl -H "Authorization: Bearer ${token.slice(0, 20)}..." https://tu-api/api/ingredients`
                }
            });
        } catch (err) {
            log('error', 'Error generando API token', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== REGISTER ==========
    router.post('/auth/register', authLimiter, async (req, res) => {
        const client = await pool.connect();
        try {
            const { nombre, email, password, moneda } = req.body;

            if (!nombre || !email || !password) {
                return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ error: 'Formato de email inválido' });
            }

            if (password.length < 8) {
                return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
            }

            const existingUser = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
            if (existingUser.rows.length > 0) {
                return res.status(400).json({ error: 'El email ya está registrado' });
            }

            await client.query('BEGIN');

            // Create restaurant with 14-day trial
            const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
            const safeMoneda = moneda ? sanitizeString(String(moneda).slice(0, 10)) : '€';
            const restauranteResult = await client.query(
                `INSERT INTO restaurantes (nombre, email, plan, plan_status, trial_ends_at, max_users, moneda)
                 VALUES ($1, $2, 'trial', 'trialing', $3, 5, $4) RETURNING id`,
                [sanitizeString(nombre), email, trialEndsAt, safeMoneda]
            );
            const restauranteId = restauranteResult.rows[0].id;

            const passwordHash = await bcrypt.hash(password, 10);

            const canSendEmail = !!resend;
            const verificationToken = canSendEmail ? crypto.randomBytes(32).toString('hex') : null;
            const verificationExpires = canSendEmail ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

            const userResult = await client.query(
                `INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol, email_verified, verification_token, verification_expires) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [restauranteId, email, passwordHash, sanitizeString(nombre), 'admin', !canSendEmail, verificationToken, verificationExpires]
            );

            // Create Stripe customer if configured
            const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
            if (STRIPE_SECRET_KEY) {
                try {
                    const stripe = require('stripe')(STRIPE_SECRET_KEY);
                    const customer = await stripe.customers.create({
                        email,
                        name: sanitizeString(nombre),
                        metadata: { restaurante_id: String(restauranteId) }
                    });
                    await client.query(
                        'UPDATE restaurantes SET stripe_customer_id = $1 WHERE id = $2',
                        [customer.id, restauranteId]
                    );
                } catch (stripeErr) {
                    log('warn', 'Error creando Stripe customer (registro continúa)', { error: stripeErr.message });
                }
            }

            // Multi-restaurant: add to junction table
            await client.query(
                'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3)',
                [userResult.rows[0].id, restauranteId, 'admin']
            );

            await client.query('COMMIT');

            if (canSendEmail) {
                const verifyUrl = `${API_URL}/api/auth/verify-email?token=${verificationToken}`;
                try {
                    await resend.emails.send({
                        from: process.env.RESEND_FROM || 'MindLoop CostOS <onboarding@resend.dev>',
                        to: email,
                        subject: '✅ Verifica tu cuenta — MindLoop CostOS',
                        html: `
                            <div style="font-family: 'Inter', sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; background: #ffffff; border-radius: 12px;">
                                <div style="text-align: center; padding: 20px; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); border-radius: 12px; margin-bottom: 24px;">
                                    <h1 style="color: white; margin: 0; font-size: 22px;">🍽️ MindLoop CostOS</h1>
                                </div>
                                <p style="color: #374151; font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
                                <p style="color: #6b7280;">Gracias por registrarte. Verifica tu email para empezar:</p>
                                <div style="text-align: center; margin: 30px 0;">
                                    <a href="${verifyUrl}" style="background: linear-gradient(135deg, #6366f1, #a855f7); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Verificar mi cuenta</a>
                                </div>
                                <p style="color: #9ca3af; font-size: 13px;">Este enlace expira en 24 horas.</p>
                                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                                <p style="color: #9ca3af; font-size: 12px; text-align: center;">MindLoop CostOS — Restaurant Intelligence Platform</p>
                            </div>
                        `
                    });
                    log('info', 'Email de verificación enviado', { email });
                } catch (emailErr) {
                    log('warn', 'Error enviando email de verificación (usuario creado igualmente)', { email, error: emailErr.message });
                }

                res.status(201).json({
                    message: 'Cuenta creada. Revisa tu email para verificarla.',
                    needsVerification: true,
                    user: { email, nombre }
                });
            } else {
                const token = jwt.sign(
                    { userId: userResult.rows[0].id, restauranteId, email, rol: 'admin' },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );

                log('info', 'Registro exitoso (auto-verificado, Resend no configurado)', { email });

                res.status(201).json({
                    token,
                    user: {
                        id: userResult.rows[0].id,
                        email,
                        nombre,
                        rol: 'admin',
                        restaurante: nombre,
                        restauranteId
                    }
                });
            }
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error registro', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // ========== VERIFY EMAIL ==========
    router.get('/auth/verify-email', async (req, res) => {
        try {
            const { token } = req.query;
            if (!token) {
                return res.send(verifyPageHTML('❌ Error', 'Token de verificación no proporcionado.', false));
            }

            const result = await pool.query(
                `SELECT u.*, r.nombre as restaurante_nombre FROM usuarios u JOIN restaurantes r ON u.restaurante_id = r.id 
                 WHERE u.verification_token = $1 AND u.verification_expires > NOW()`, [token]
            );

            if (result.rows.length === 0) {
                return res.send(verifyPageHTML('❌ Token inválido', 'El enlace ha expirado o ya fue utilizado. Solicita uno nuevo desde la app.', false));
            }

            const user = result.rows[0];
            await pool.query(`UPDATE usuarios SET email_verified = TRUE, verification_token = NULL WHERE id = $1`, [user.id]);

            log('info', 'Email verificado', { email: user.email });

            res.send(verifyPageHTML('✅ ¡Cuenta verificada!', `Hola ${user.nombre}, tu cuenta ha sido verificada correctamente. Ya puedes iniciar sesión.`, true));
        } catch (err) {
            log('error', 'Error verificando email', { error: err.message });
            res.status(500).send(verifyPageHTML('❌ Error', 'Ocurrió un error interno. Inténtalo de nuevo más tarde.', false));
        }
    });

    // ========== FORGOT PASSWORD ==========
    router.post('/auth/forgot-password', authLimiter, async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({ error: 'Email requerido' });
            }

            const result = await pool.query('SELECT id, nombre FROM usuarios WHERE email = $1', [email]);

            if (result.rows.length > 0 && resend) {
                const user = result.rows[0];
                const resetToken = crypto.randomBytes(32).toString('hex');
                const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

                await pool.query(
                    'UPDATE usuarios SET reset_token = $1, reset_expires = $2 WHERE id = $3',
                    [resetToken, resetExpires, user.id]
                );

                const resetUrl = `${APP_URL}/#/reset-password?token=${resetToken}`;

                try {
                    await resend.emails.send({
                        from: process.env.RESEND_FROM || 'MindLoop CostOS <onboarding@resend.dev>',
                        to: email,
                        subject: '🔑 Recupera tu contraseña — MindLoop CostOS',
                        html: `
                            <div style="font-family: 'Inter', sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; background: #ffffff; border-radius: 12px;">
                                <div style="text-align: center; padding: 20px; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); border-radius: 12px; margin-bottom: 24px;">
                                    <h1 style="color: white; margin: 0; font-size: 22px;">🔑 Recuperar Contraseña</h1>
                                </div>
                                <p style="color: #374151; font-size: 16px;">Hola <strong>${user.nombre}</strong>,</p>
                                <p style="color: #6b7280;">Recibimos una solicitud para cambiar tu contraseña. Haz clic en el botón para continuar:</p>
                                <div style="text-align: center; margin: 30px 0;">
                                    <a href="${resetUrl}" style="background: linear-gradient(135deg, #6366f1, #a855f7); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Cambiar contraseña</a>
                                </div>
                                <p style="color: #9ca3af; font-size: 13px;">Este enlace expira en 1 hora. Si no solicitaste este cambio, ignora este email.</p>
                                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                                <p style="color: #9ca3af; font-size: 12px; text-align: center;">MindLoop CostOS — Restaurant Intelligence Platform</p>
                            </div>
                        `
                    });
                    log('info', 'Email de reset enviado', { email });
                } catch (emailErr) {
                    log('warn', 'Error enviando email de reset', { email, error: emailErr.message });
                }
            } else if (result.rows.length > 0 && !resend) {
                log('warn', 'Reset solicitado pero Resend no configurado', { email });
            }

            res.json({ message: 'Si el email existe, recibirás instrucciones para cambiar tu contraseña.' });
        } catch (err) {
            log('error', 'Error forgot-password', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== RESET PASSWORD ==========
    router.post('/auth/reset-password', authLimiter, async (req, res) => {
        try {
            const { token, newPassword } = req.body;

            if (!token || !newPassword) {
                return res.status(400).json({ error: 'Token y nueva contraseña requeridos' });
            }

            if (newPassword.length < 8) {
                return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
            }

            const result = await pool.query(
                'SELECT id, email FROM usuarios WHERE reset_token = $1 AND reset_expires > NOW()',
                [token]
            );

            if (result.rows.length === 0) {
                return res.status(400).json({ error: 'Token inválido o expirado. Solicita uno nuevo.' });
            }

            const user = result.rows[0];
            const passwordHash = await bcrypt.hash(newPassword, 10);

            await pool.query(
                'UPDATE usuarios SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
                [passwordHash, user.id]
            );

            log('info', 'Contraseña reseteada exitosamente', { email: user.email });

            res.json({ message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
        } catch (err) {
            log('error', 'Error reset-password', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== RESEND VERIFICATION ==========
    router.post('/auth/resend-verification', authLimiter, async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({ error: 'Email requerido' });
            }

            if (!resend) {
                return res.status(503).json({ error: 'Servicio de email no disponible. Contacta al administrador.' });
            }

            const result = await pool.query(
                'SELECT id, nombre, email_verified FROM usuarios WHERE email = $1',
                [email]
            );

            if (result.rows.length === 0) {
                return res.json({ message: 'Si el email existe, recibirás un enlace de verificación.' });
            }

            const user = result.rows[0];

            if (user.email_verified) {
                return res.json({ message: 'Tu cuenta ya está verificada. Puedes iniciar sesión.' });
            }

            const verificationToken = crypto.randomBytes(32).toString('hex');
            const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

            await pool.query(
                'UPDATE usuarios SET verification_token = $1, verification_expires = $2 WHERE id = $3',
                [verificationToken, verificationExpires, user.id]
            );

            const verifyUrl = `${API_URL}/api/auth/verify-email?token=${verificationToken}`;

            await resend.emails.send({
                from: process.env.RESEND_FROM || 'MindLoop CostOS <onboarding@resend.dev>',
                to: email,
                subject: '✅ Verifica tu cuenta — MindLoop CostOS',
                html: `
                    <div style="font-family: 'Inter', sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; background: #ffffff; border-radius: 12px;">
                        <div style="text-align: center; padding: 20px; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); border-radius: 12px; margin-bottom: 24px;">
                            <h1 style="color: white; margin: 0; font-size: 22px;">🍽️ MindLoop CostOS</h1>
                        </div>
                        <p style="color: #374151; font-size: 16px;">Hola <strong>${user.nombre}</strong>,</p>
                        <p style="color: #6b7280;">Haz clic para verificar tu cuenta:</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${verifyUrl}" style="background: linear-gradient(135deg, #6366f1, #a855f7); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Verificar mi cuenta</a>
                        </div>
                        <p style="color: #9ca3af; font-size: 13px;">Este enlace expira en 24 horas.</p>
                        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                        <p style="color: #9ca3af; font-size: 12px; text-align: center;">MindLoop CostOS — Restaurant Intelligence Platform</p>
                    </div>
                `
            });

            log('info', 'Email de verificación reenviado', { email });
            res.json({ message: 'Email de verificación reenviado. Revisa tu bandeja de entrada.' });
        } catch (err) {
            log('error', 'Error resend-verification', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== TEAM MANAGEMENT ==========
    router.get('/team', authMiddleware, async (req, res) => {
        try {
            // Lee de la junction table (fuente de verdad) en vez de usuarios.restaurante_id
            // (legacy). Así aparecen TODOS los usuarios vinculados, incluidos los que
            // fueron añadidos a este restaurante como segundo/tercer restaurante.
            const result = await pool.query(
                `SELECT u.id, u.nombre, u.email, ur.rol, ur.created_at
                 FROM usuario_restaurantes ur
                 JOIN usuarios u ON u.id = ur.usuario_id
                 WHERE ur.restaurante_id = $1
                 ORDER BY ur.created_at DESC`,
                [req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error listando equipo', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.post('/team/invite', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const { nombre, email, password, rol } = req.body;

            if (!nombre || !email || !password) {
                return res.status(400).json({ error: 'Faltan datos requeridos (nombre, email, password)' });
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ error: 'Formato de email inválido' });
            }

            // Check plan status and user limits
            const restInfo = await pool.query(
                'SELECT plan_status, max_users FROM restaurantes WHERE id = $1',
                [req.restauranteId]
            );
            if (restInfo.rows.length === 0) {
                return res.status(404).json({ error: 'Restaurante no encontrado' });
            }
            const { plan_status, max_users } = restInfo.rows[0];

            if (['suspended', 'canceled', 'past_due'].includes(plan_status)) {
                return res.status(403).json({ error: 'Tu suscripción no está activa. Renueva tu plan para añadir usuarios.' });
            }

            const userCount = await pool.query(
                'SELECT COUNT(*)::int AS total FROM usuario_restaurantes WHERE restaurante_id = $1',
                [req.restauranteId]
            );
            if (userCount.rows[0].total >= (max_users || 5)) {
                return res.status(403).json({ error: `Has alcanzado el límite de ${max_users || 5} usuarios para tu plan. Mejora tu plan para añadir más.` });
            }

            const allowedRoles = ['usuario', 'admin'];
            const nuevoRol = allowedRoles.includes(rol) ? rol : 'usuario';

            const check = await pool.query('SELECT id, nombre, email FROM usuarios WHERE email = $1', [email]);

            if (check.rows.length > 0) {
                // Usuario YA existe → vincularlo a este restaurante sin crear usuario nuevo.
                // Esto permite que un usuario pertenezca a múltiples restaurantes.
                const existingUser = check.rows[0];

                // Comprobar que no esté ya vinculado a este restaurante
                const yaVinculado = await pool.query(
                    'SELECT id FROM usuario_restaurantes WHERE usuario_id = $1 AND restaurante_id = $2',
                    [existingUser.id, req.restauranteId]
                );
                if (yaVinculado.rows.length > 0) {
                    return res.status(400).json({ error: 'Este usuario ya pertenece a este restaurante' });
                }

                await pool.query(
                    'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3)',
                    [existingUser.id, req.restauranteId, nuevoRol]
                );

                log('info', 'Usuario existente vinculado a restaurante', {
                    admin: req.user.email, linkedUser: email, restauranteId: req.restauranteId, rol: nuevoRol
                });
                return res.json({ id: existingUser.id, nombre: existingUser.nombre, email: existingUser.email, rol: nuevoRol, linked: true });
            }

            // Usuario NO existe → crear nuevo (flujo original)
            if (!password) {
                return res.status(400).json({ error: 'Password requerido para usuarios nuevos' });
            }
            const passwordHash = await bcrypt.hash(password, 10);
            const result = await pool.query(
                'INSERT INTO usuarios (restaurante_id, nombre, email, password_hash, rol, email_verified) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, nombre, email, rol',
                [req.restauranteId, sanitizeString(nombre), email, passwordHash, nuevoRol]
            );

            await pool.query(
                'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3)',
                [result.rows[0].id, req.restauranteId, nuevoRol]
            );

            log('info', 'Nuevo usuario de equipo creado', { admin: req.user.email, newUser: email });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando usuario equipo', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.delete('/team/:id', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const userIdToDelete = parseInt(req.params.id);

            if (userIdToDelete === req.user.userId) {
                return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
            }

            // Remove from junction table first
            await pool.query(
                'DELETE FROM usuario_restaurantes WHERE usuario_id = $1 AND restaurante_id = $2',
                [userIdToDelete, req.restauranteId]
            );

            // Check if user still belongs to other restaurants
            const otherRest = await pool.query(
                'SELECT COUNT(*)::int AS total FROM usuario_restaurantes WHERE usuario_id = $1',
                [userIdToDelete]
            );

            if (otherRest.rows[0].total === 0) {
                // No other restaurants — delete user entirely (por id, sin depender de
                // usuarios.restaurante_id que puede apuntar a otro restaurante)
                await pool.query('DELETE FROM usuarios WHERE id = $1', [userIdToDelete]);
            }

            log('info', 'Usuario eliminado del equipo', { admin: req.user.email, deletedId: userIdToDelete });
            res.json({ success: true, message: 'Usuario eliminado' });
        } catch (err) {
            log('error', 'Error eliminando usuario', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
