/**
 * ============================================
 * routes/auth.routes.js - Rutas de Autenticación
 * ============================================
 *
 * Endpoints: login, logout, register, verify, api-token
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { pool } = require('../config/database');
const config = require('../config');
const { log } = require('../utils/logger');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

// Rate limiter para auth
const authLimiter = rateLimit({
    windowMs: config.rateLimit.auth.windowMs,
    max: config.rateLimit.auth.max,
    message: { error: 'Demasiados intentos de login, espera 15 minutos' }
});

/**
 * POST /api/auth/login
 * Autenticación de usuario
 */
router.post('/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña requeridos' });
        }

        const result = await pool.query(
            `SELECT u.*, r.nombre as restaurante_nombre 
             FROM usuarios u 
             JOIN restaurantes r ON u.restaurante_id = r.id 
             WHERE u.email = $1`,
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

        const token = jwt.sign(
            {
                userId: user.id,
                restauranteId: user.restaurante_id,
                email: user.email,
                rol: user.rol
            },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        log('info', 'Login exitoso', { userId: user.id, email });

        // Cookie segura
        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: config.server.isProduction,
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
                restauranteId: user.restaurante_id
            }
        });
    } catch (err) {
        log('error', 'Error login', { error: err.message });
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

/**
 * POST /api/auth/logout
 * Cerrar sesión
 */
router.post('/logout', (req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    log('info', 'Logout exitoso');
    res.json({ success: true, message: 'Sesión cerrada correctamente' });
});

/**
 * GET /api/auth/verify
 * Verificar token actual
 */
router.get('/verify', authMiddleware, (req, res) => {
    res.json({
        valid: true,
        user: {
            id: req.user.userId,
            email: req.user.email,
            rol: req.user.rol,
            restauranteId: req.restauranteId
        },
        tokenInfo: {
            issuedAt: new Date(req.user.iat * 1000).toISOString(),
            expiresAt: new Date(req.user.exp * 1000).toISOString()
        }
    });
});

/**
 * POST /api/auth/register
 * Registro de nuevo restaurante
 */
router.post('/register', async (req, res) => {
    const client = await pool.connect();
    try {
        const { nombre, email, password, codigoInvitacion } = req.body;

        if (!nombre || !email || !password) {
            return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
        }

        if (!codigoInvitacion || codigoInvitacion !== config.invitationCode) {
            return res.status(403).json({ error: 'Código de invitación inválido' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const existingUser = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'El email ya está registrado' });
        }

        await client.query('BEGIN');

        const restauranteResult = await client.query(
            'INSERT INTO restaurantes (nombre, email) VALUES ($1, $2) RETURNING id',
            [nombre, email]
        );
        const restauranteId = restauranteResult.rows[0].id;

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await client.query(
            `INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol, email_verified) 
             VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
            [restauranteId, email, passwordHash, nombre, 'admin']
        );

        await client.query('COMMIT');

        const token = jwt.sign(
            { userId: userResult.rows[0].id, restauranteId, email, rol: 'admin' },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        log('info', 'Registro exitoso', { email });

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
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error registro', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/auth/api-token
 * Generar token de API de larga duración
 */
router.post('/api-token', authMiddleware, requireAdmin, async (req, res) => {
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
            config.jwt.secret,
            { expiresIn: `${dias}d` }
        );

        const tokenHash = await bcrypt.hash(token.slice(-20), 5);
        await pool.query(
            'INSERT INTO api_tokens (restaurante_id, nombre, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
            [req.restauranteId, nombre || 'API Integration', tokenHash, new Date(Date.now() + dias * 24 * 60 * 60 * 1000)]
        );

        log('info', 'API Token generado', { user: req.user.email, expiraDias: dias });

        res.json({
            success: true,
            apiToken: token,
            expiresAt: new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString()
        });
    } catch (err) {
        log('error', 'Error generando API token', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/auth/verify-email
 * Verificar email con token
 */
router.get('/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ error: 'Token requerido' });

        const result = await pool.query(
            `SELECT u.*, r.nombre as restaurante_nombre 
             FROM usuarios u 
             JOIN restaurantes r ON u.restaurante_id = r.id 
             WHERE u.verification_token = $1 AND u.verification_expires > NOW()`,
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Token inválido o expirado' });
        }

        const user = result.rows[0];
        await pool.query(
            'UPDATE usuarios SET email_verified = TRUE, verification_token = NULL WHERE id = $1',
            [user.id]
        );

        const jwtToken = jwt.sign(
            { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        log('info', 'Email verificado', { email: user.email });

        res.json({
            message: '¡Cuenta verificada!',
            token: jwtToken,
            user: {
                id: user.id,
                email: user.email,
                nombre: user.nombre,
                rol: user.rol,
                restaurante: user.restaurante_nombre,
                restauranteId: user.restaurante_id
            }
        });
    } catch (err) {
        log('error', 'Error verificando email', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
