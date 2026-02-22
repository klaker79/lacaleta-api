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

            const token = jwt.sign(
                { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol, isSuperAdmin: user.is_superadmin || false },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            log('info', 'Login exitoso', { userId: user.id, email });

            const isProduction = process.env.NODE_ENV === 'production';
            res.cookie('auth_token', token, {
                httpOnly: true,
                secure: isProduction,
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000,
                path: '/'
            });

            res.json({
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    nombre: user.nombre,
                    rol: user.rol,
                    restaurante: user.restaurante_nombre,
                    restauranteId: user.restaurante_id,
                    isSuperAdmin: user.is_superadmin || false
                }
            });
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
    router.post('/auth/register', async (req, res) => {
        const client = await pool.connect();
        try {
            const { nombre, email, password } = req.body;

            if (!nombre || !email || !password) {
                return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
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
            const restauranteResult = await client.query(
                `INSERT INTO restaurantes (nombre, email, plan, plan_status, trial_ends_at, max_users) 
                 VALUES ($1, $2, 'trial', 'trialing', $3, 5) RETURNING id`,
                [sanitizeString(nombre), email, trialEndsAt]
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

            if (newPassword.length < 6) {
                return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
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
            const result = await pool.query(
                'SELECT id, nombre, email, rol, created_at FROM usuarios WHERE restaurante_id = $1 ORDER BY created_at DESC',
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

            const check = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
            if (check.rows.length > 0) {
                return res.status(400).json({ error: 'Este email ya está registrado' });
            }

            const passwordHash = await bcrypt.hash(password, 10);
            const nuevoRol = rol || 'usuario';
            const result = await pool.query(
                'INSERT INTO usuarios (restaurante_id, nombre, email, password_hash, rol, email_verified) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, nombre, email, rol',
                [req.restauranteId, sanitizeString(nombre), email, passwordHash, nuevoRol]
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

            const result = await pool.query(
                'DELETE FROM usuarios WHERE id = $1 AND restaurante_id = $2 RETURNING id',
                [userIdToDelete, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Usuario no encontrado en tu equipo' });
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
