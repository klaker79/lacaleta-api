/**
 * ============================================
 * server.modular.js - Servidor Express Modular
 * ============================================
 *
 * Arquitectura modular para MindLoop CostOS API.
 * Este archivo reemplazará al monolítico server.js de 4000+ líneas.
 *
 * GRADUAL MIGRATION:
 * 1. Primero: Ejecutar ambos en paralelo (modular en puerto diferente)
 * 2. Después: Migrar rutas una a una
 * 3. Final: Renombrar este a server.js
 *
 * @author MindLoopIA
 * @version 2.5.0
 * @date 2026-01-28
 */

// ========== IMPORTS ==========
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// Config
const config = require('./src/config');
const { pool, testConnection } = require('./src/config/database');
const { log } = require('./src/utils/logger');

// Routes
const routes = require('./src/routes');

const app = express();

// ========== MIDDLEWARE ==========

// Trust proxy (Traefik, nginx, etc.)
app.set('trust proxy', 1);

// CORS
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const publicPaths = ['/', '/health', '/api/health'];

    if (!origin) {
        if (publicPaths.includes(req.path)) {
            res.header('Access-Control-Allow-Origin', '*');
        } else {
            return res.status(403).json({ error: 'CORS: Header Origin requerido' });
        }
    } else if (config.cors.allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
    } else {
        return res.status(403).json({ error: 'CORS: Origen no autorizado' });
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers',
        'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-API-Key');
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// JSON Parser
app.use(express.json({ limit: '10mb' }));

// Cookie Parser
app.use(cookieParser());

// Rate Limiting
const globalLimiter = rateLimit({
    windowMs: config.rateLimit.global.windowMs,
    max: config.rateLimit.global.max,
    message: { error: 'Demasiadas peticiones, intenta más tarde' }
});
app.use(globalLimiter);

// ========== ROUTES ==========
app.use('/api', routes);

// Root redirect
app.get('/', (req, res) => {
    res.json({
        message: '🍽️ MindLoop CostOS API (Modular)',
        version: '2.5.0',
        docs: '/api'
    });
});

// ========== ERROR HANDLERS ==========
process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled Promise Rejection', { reason: String(reason) });
});

process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception', { error: error.message });
});

process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down');
    process.exit(0);
});

// ========== START SERVER ==========
const PORT = config.server.port;

const start = async () => {
    await testConnection();

    app.listen(PORT, () => {
        log('info', `🚀 MindLoop CostOS API (Modular) running on port ${PORT}`);
        console.log(`\n✅ Server running at http://localhost:${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/api/health\n`);
    });
};

start();

module.exports = app;
