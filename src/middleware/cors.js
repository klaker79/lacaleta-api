/**
 * ============================================
 * middleware/cors.js - Middleware CORS
 * ============================================
 *
 * Configuración CORS con orígenes permitidos
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const { log } = require('../utils/logger');

// Orígenes permitidos
const DEFAULT_ORIGINS = [
    'https://klaker79.github.io',
    'https://app.mindloop.cloud',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    'http://localhost:3004',
    'http://localhost:3005',
    'http://localhost:8080'
];

const ENV_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [];

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS])];

// Rutas públicas (sin origin requerido)
const PUBLIC_PATHS = ['/', '/health', '/api/health', '/api', '/favicon.ico'];

/**
 * Middleware CORS
 */
function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    if (!origin || origin === '') {
        // Permitir rutas públicas sin origin
        if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) {
            res.header('Access-Control-Allow-Origin', '*');
        } else {
            log('warn', 'CORS: Request sin origin', { path: req.path, ip: req.ip });
            return res.status(403).json({ error: 'Origin requerido' });
        }
    } else if (ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
    } else {
        log('warn', 'CORS: Origen rechazado', { origin, path: req.path });
        return res.status(403).json({ error: 'Origen no autorizado' });
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-API-Key');
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
}

module.exports = { corsMiddleware, ALLOWED_ORIGINS };
