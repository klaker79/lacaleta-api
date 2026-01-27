/**
 * ============================================
 * auth.js - Middleware de Autenticación
 * ============================================
 * 
 * Middleware para verificar JWT tokens.
 * 
 * @author MindLoopIA
 * @version 1.0.0
 */

const jwt = require('jsonwebtoken');
const { log } = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware de autenticación JWT
 * Lee token de cookie httpOnly o header Authorization
 */
function authMiddleware(req, res, next) {
    // 1. Intentar leer token de httpOnly cookie
    let token = req.cookies?.auth_token;

    // 2. Fallback a Authorization header
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }

    if (!token) {
        log('warn', 'Auth fallido: Token no proporcionado', {
            url: req.originalUrl,
            origin: req.headers.origin || 'sin-origin'
        });
        return res.status(401).json({
            error: 'Token no proporcionado',
            code: 'NO_TOKEN',
            hint: 'Incluye header: Authorization: Bearer <tu_token> o inicia sesión'
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        req.restauranteId = decoded.restauranteId;
        next();
    } catch (error) {
        log('warn', 'Auth fallido: Token inválido', {
            error: error.message,
            url: req.originalUrl
        });

        let errorMsg = 'Token inválido';
        let code = 'INVALID_TOKEN';

        if (error.name === 'TokenExpiredError') {
            errorMsg = 'Token expirado. Por favor, vuelve a iniciar sesión.';
            code = 'TOKEN_EXPIRED';
            res.clearCookie('auth_token');
        }

        return res.status(401).json({
            error: errorMsg,
            code: code,
            expiredAt: error.expiredAt || null
        });
    }
}

/**
 * Middleware que requiere rol admin
 */
function requireAdmin(req, res, next) {
    if (!req.user || (req.user.rol !== 'admin' && req.user.rol !== 'api')) {
        log('warn', 'Acceso denegado a ruta protegida', {
            user: req.user ? req.user.email : 'anon',
            url: req.originalUrl
        });
        return res.status(403).json({ error: 'Acceso denegado: Requiere rol de Administrador' });
    }
    next();
}

module.exports = { authMiddleware, requireAdmin };
