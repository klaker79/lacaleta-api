/**
 * Auth Routes — Extraído de server.js
 * Login, Register, Verify email, Forgot/Reset password, Logout, API tokens, Team
 */
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authMiddleware, requireAdmin, tokenBlacklist } = require('../middleware/auth');
const { authLimiter, globalLimiter } = require('../middleware/rateLimit');
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
            // 2026-05-21: aceptar `identifier` (username o email) además de `email`
            // por compat con frontends antiguos. Si el campo `identifier` no
            // viene, caemos a `email` — mismo comportamiento que antes.
            const { email, identifier, password } = req.body;
            const loginIdentifier = identifier || email;

            if (!loginIdentifier || !password) {
                return res.status(400).json({ error: 'Usuario o email y contraseña requeridos' });
            }

            // Lookup por email O por username. El UNIQUE garantiza que solo
            // hay un match posible para cada valor.
            const result = await pool.query(
                `SELECT u.*, r.nombre as restaurante_nombre
                 FROM usuarios u
                 JOIN restaurantes r ON u.restaurante_id = r.id
                 WHERE u.email = $1 OR u.username = $1`,
                [loginIdentifier]
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
                    { userId: user.id, restauranteId: rest.restaurante_id, email: user.email, username: user.username || null, rol: rest.rol, isSuperAdmin: user.is_superadmin || false },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );

                log('info', 'Login exitoso', { userId: user.id, email: user.email, username: user.username, restauranteId: rest.restaurante_id });

                res.cookie('auth_token', token, {
                    httpOnly: true, secure: isProduction, sameSite: 'lax',
                    maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
                });

                res.json({
                    token,
                    user: {
                        id: user.id, email: user.email, username: user.username || null, nombre: user.nombre,
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
                    { userId: user.id, email: user.email, username: user.username || null, type: 'restaurant_selection', isSuperAdmin: user.is_superadmin || false },
                    JWT_SECRET,
                    { expiresIn: '5m' }
                );

                log('info', 'Login multi-restaurante: selección requerida', { userId: user.id, email: user.email, username: user.username, count: restaurants.length });

                res.json({
                    needsSelection: true,
                    selectionToken,
                    restaurants,
                    user: { id: user.id, nombre: user.nombre, email: user.email, username: user.username || null }
                });
            }
        } catch (err) {
            log('error', 'Error login', { error: err.message });
            res.status(500).json({ error: 'Error en el servidor' });
        }
    });

    // ========== VERIFY TOKEN ==========
    router.get('/auth/verify', authMiddleware, async (req, res) => {
        // Refresh restaurant-scoped data (moneda, nombre) from DB on every verify
        // so the frontend always has fresh currency after reload, even if
        // localStorage is stale from a pre-migration login.
        let moneda = '€';
        let restaurante = null;
        try {
            const r = await pool.query(
                'SELECT nombre, moneda FROM restaurantes WHERE id = $1',
                [req.restauranteId]
            );
            if (r.rows.length > 0) {
                moneda = r.rows[0].moneda || '€';
                restaurante = r.rows[0].nombre;
            }
        } catch (_e) {
            // keep defaults; verify should never fail on ancillary data
        }

        res.json({
            valid: true,
            user: {
                id: req.user.userId,
                email: req.user.email,
                rol: req.user.rol,
                restauranteId: req.restauranteId,
                restaurante,
                moneda,
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
    // Crea restaurante en plan_status='pending_payment'. El cliente debe pasar
    // por el checkout de Polar (plan base 95€/mes) para que el webhook lo active.

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
            const { nombre, moneda } = req.body;
            if (!nombre || !nombre.trim()) {
                return res.status(400).json({ error: 'Nombre del restaurante requerido' });
            }

            // 2026-05-20: pricing es single-plan (95€/mes) + add-on Chat IA (30€/mes
            // vía Polar). Ya no hay starter/profesional/premium ni Stripe.
            // El plan base se cobra vía Polar en flujo separado (TODO: PR-2).
            // Por ahora el restaurante se crea en pending_payment y el checkout
            // Polar se enchufará desde una pantalla dedicada de Suscripción.

            await client.query('BEGIN');

            // Cleanup any previous orphaned pending_payment restaurants from this user
            await client.query(
                `DELETE FROM restaurantes
                 WHERE plan_status = 'pending_payment'
                   AND id IN (SELECT restaurante_id FROM usuario_restaurantes WHERE usuario_id = $1)`,
                [req.user.userId]
            );

            const safeMoneda = moneda ? sanitizeString(String(moneda).slice(0, 10)) : '€';
            const restResult = await client.query(
                `INSERT INTO restaurantes (nombre, email, plan, plan_status, max_users, moneda)
                 VALUES ($1, $2, 'base', 'pending_payment', 999, $3) RETURNING id`,
                [sanitizeString(nombre.trim()), req.user.email, safeMoneda]
            );
            const restauranteId = restResult.rows[0].id;

            // Link current user as admin
            await client.query(
                'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3)',
                [req.user.userId, restauranteId, 'admin']
            );

            await client.query('COMMIT');

            log('info', 'Restaurante creado (pending_payment)', {
                userId: req.user.userId, restauranteId
            });

            // checkoutUrl=null hasta que se integre Polar plan base (PR-2).
            // El frontend debe redirigir al flujo de pago de Polar tras la creación.
            res.status(201).json({ checkoutUrl: null, restauranteId, plan: 'base' });
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

            // Create restaurant with 10-day trial (Iker 2026-06-06: trial corto para forzar
            // decisión real del cliente y evitar "uso para siempre sin pagar" si no hay gate).
            const TRIAL_DAYS = 10;
            const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
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

            // 2026-05-21: autogenerar username desde la parte local del email
            // si no se ha pasado explícitamente (Deploy 1 backward-compat).
            // Maneja colisiones añadiendo sufijo numérico (1, 2, ..., 9, timestamp).
            // El backend SOLO usa este lookup auxiliar — no expone el username
            // generado al cliente todavía (eso es Deploy 2).
            const baseUsername = (email.split('@')[0] || 'user').toLowerCase().slice(0, 40);
            let username = baseUsername;
            for (let suffix = 0; suffix < 10; suffix++) {
                const candidate = suffix === 0 ? baseUsername : `${baseUsername}_${suffix}`;
                const check = await client.query('SELECT 1 FROM usuarios WHERE username = $1', [candidate]);
                if (check.rows.length === 0) { username = candidate; break; }
                if (suffix === 9) { username = `${baseUsername}_${Date.now()}`; }
            }

            const userResult = await client.query(
                `INSERT INTO usuarios (restaurante_id, email, username, password_hash, nombre, rol, email_verified, verification_token, verification_expires)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                [restauranteId, email, username, passwordHash, sanitizeString(nombre), 'admin', !canSendEmail, verificationToken, verificationExpires]
            );

            // 2026-05-20: pricing es single-plan vía Polar (no más Stripe).
            // Cliente Polar no se crea aquí — se crea automáticamente al
            // iniciar el primer checkout de plan base o add-on.

            // Multi-restaurant: add to junction table
            await client.query(
                'INSERT INTO usuario_restaurantes (usuario_id, restaurante_id, rol) VALUES ($1, $2, $3)',
                [userResult.rows[0].id, restauranteId, 'admin']
            );

            await client.query('COMMIT');

            if (canSendEmail) {
                const verifyUrl = `${API_URL}/api/auth/verify-email?token=${verificationToken}`;
                const trialEndsHuman = trialEndsAt.toLocaleDateString('es-ES', {
                    day: '2-digit', month: 'long', year: 'numeric'
                });
                try {
                    await resend.emails.send({
                        from: process.env.RESEND_FROM || 'MindLoop CostOS <onboarding@resend.dev>',
                        to: email,
                        subject: '🍽️ Bienvenido a MindLoop — tu prueba de 10 días empieza ahora',
                        html: `
                            <div style="font-family: 'Inter', sans-serif; max-width: 540px; margin: 0 auto; padding: 0; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
                                <div style="padding: 24px 32px; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); text-align: center;">
                                    <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 700;">🍽️ MindLoop CostOS</h1>
                                    <p style="color: rgba(255,255,255,0.92); margin: 6px 0 0; font-size: 13px;">Restaurant Intelligence Platform</p>
                                </div>
                                <div style="padding: 28px 32px 8px;">
                                    <p style="color: #111827; font-size: 17px; margin: 0 0 6px;">Hola <strong>${nombre}</strong>,</p>
                                    <p style="color: #374151; font-size: 15px; line-height: 1.55; margin: 0 0 18px;">
                                        Tu cuenta de MindLoop CostOS está lista. Acabas de empezar
                                        <strong>${TRIAL_DAYS} días de prueba gratuita con acceso completo</strong>
                                        — sin pedir tarjeta, sin compromiso.
                                    </p>
                                    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 14px; border-radius: 6px; margin-bottom: 22px;">
                                        <strong style="color: #92400e; font-size: 13px;">📅 Tu prueba termina el ${trialEndsHuman}</strong>
                                        <p style="color: #78350f; font-size: 13px; margin: 4px 0 0; line-height: 1.45;">
                                            Hasta ese día tienes la app completa. Después podrás suscribirte
                                            o exportar tus datos.
                                        </p>
                                    </div>
                                    <p style="color: #374151; font-size: 14px; margin: 0 0 8px;"><strong>Antes de nada, verifica tu email:</strong></p>
                                </div>
                                <div style="text-align: center; padding: 8px 32px 24px;">
                                    <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #a855f7); color: white; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Verificar mi cuenta</a>
                                    <p style="color: #9ca3af; font-size: 12px; margin: 12px 0 0;">Este enlace expira en 24 horas.</p>
                                </div>
                                <div style="background: #f9fafb; padding: 20px 32px; border-top: 1px solid #e5e7eb;">
                                    <h3 style="color: #111827; font-size: 14px; font-weight: 700; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.4px;">Qué hacer en tus primeros 30 minutos</h3>
                                    <ol style="color: #374151; font-size: 14px; line-height: 1.7; margin: 0; padding-left: 20px;">
                                        <li>Crea tus <strong>proveedores</strong> (o importa la plantilla Excel).</li>
                                        <li>Sube tus <strong>ingredientes</strong> con precio y formato.</li>
                                        <li>Monta 2-3 <strong>recetas</strong> y verás su food cost real.</li>
                                        <li>Mete tu primera <strong>compra</strong> y deja que el sistema haga el resto.</li>
                                    </ol>
                                    <p style="color: #6b7280; font-size: 12px; margin: 14px 0 0;">
                                        Al entrar te guiamos paso a paso desde el spotlight del dashboard.
                                    </p>
                                </div>
                                <div style="padding: 16px 32px; text-align: center; background: #ffffff;">
                                    <p style="color: #9ca3af; font-size: 11px; margin: 0;">¿Dudas? Responde a este email y te contestamos.</p>
                                    <p style="color: #9ca3af; font-size: 11px; margin: 6px 0 0;">MindLoop CostOS — Hecho con cariño desde Galicia 🇪🇸</p>
                                </div>
                            </div>
                        `
                    });
                    log('info', 'Email de bienvenida + verificación enviado', { email, trial_days: TRIAL_DAYS });
                } catch (emailErr) {
                    log('warn', 'Error enviando email de bienvenida (usuario creado igualmente)', { email, error: emailErr.message });
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

    // ========== OPT-IN COMIDA DE PERSONAL (por restaurante) ==========
    router.get('/restaurant/comida-personal', globalLimiter, authMiddleware, async (req, res) => {
        try {
            const r = await pool.query(
                'SELECT comida_personal_activa FROM restaurantes WHERE id = $1',
                [req.restauranteId]
            );
            res.json({ activa: r.rows[0]?.comida_personal_activa === true });
        } catch (err) {
            log('error', 'Error leyendo comida_personal_activa', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.put('/restaurant/comida-personal', authLimiter, authMiddleware, requireAdmin, async (req, res) => {
        try {
            const activa = req.body?.activa === true;
            await pool.query(
                'UPDATE restaurantes SET comida_personal_activa = $1 WHERE id = $2',
                [activa, req.restauranteId]
            );
            res.json({ activa });
        } catch (err) {
            log('error', 'Error guardando comida_personal_activa', { error: err.message });
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

            // 2026-05-21: autogenerar username desde la parte local del email
            // (mismo patrón que /auth/register). Maneja colisiones con sufijo.
            const baseUsername = (email.split('@')[0] || 'user').toLowerCase().slice(0, 40);
            let username = baseUsername;
            for (let suffix = 0; suffix < 10; suffix++) {
                const candidate = suffix === 0 ? baseUsername : `${baseUsername}_${suffix}`;
                const check = await pool.query('SELECT 1 FROM usuarios WHERE username = $1', [candidate]);
                if (check.rows.length === 0) { username = candidate; break; }
                if (suffix === 9) { username = `${baseUsername}_${Date.now()}`; }
            }

            const result = await pool.query(
                'INSERT INTO usuarios (restaurante_id, nombre, email, username, password_hash, rol, email_verified) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id, nombre, email, username, rol',
                [req.restauranteId, sanitizeString(nombre), email, username, passwordHash, nuevoRol]
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
