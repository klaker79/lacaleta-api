/**
 * ============================================
 * server.modular.js - Servidor API Modular
 * ============================================
 *
 * Punto de entrada modular que carga rutas desde src/routes/
 * Usa: npm start (o node server.modular.js)
 *
 * @author MindLoopIA
 * @version 2.5.0
 */

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// ========== IMPORTAR MÓDULOS ==========
const { pool, testConnection } = require('./src/config/database');
const { log } = require('./src/utils/logger');
const { corsMiddleware } = require('./src/middleware/cors');
const routes = require('./src/routes');

// ========== CONFIGURACIÓN ==========
const PORT = process.env.PORT || 3000;

// Validar configuración crítica
if (!process.env.JWT_SECRET) {
    console.error('❌ FATAL: JWT_SECRET no configurado');
    process.exit(1);
}

const app = express();

// Trust proxy (para rate-limit detrás de proxy)
app.set('trust proxy', 1);

// ========== MIDDLEWARES GLOBALES ==========

// CORS
app.use(corsMiddleware);

// Parser JSON (hasta 10MB para PDFs)
app.use(express.json({ limit: '10mb' }));

// Cookies (auth)
app.use(cookieParser());

// Rate Limiting global
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 1000,
    message: { error: 'Demasiadas peticiones' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', globalLimiter);

// ========== MONTAR RUTAS ==========
app.use('/api', routes);

// Health check raíz
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        api: '/api',
        health: '/api/health',
        version: '2.5.0-modular'
    });
});

// ========== ERROR HANDLERS ==========

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado', path: req.path });
});

// Error global
app.use((err, req, res, next) => {
    log('error', 'Error no capturado', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor' });
});

// ========== INICIAR SERVIDOR ==========
async function startServer() {
    try {
        // Verificar conexión a DB
        await testConnection();
        log('info', '✅ Conexión a PostgreSQL OK');

        app.listen(PORT, () => {
            log('info', `🚀 Servidor modular corriendo en puerto ${PORT}`);
            console.log(`
╔════════════════════════════════════════════╗
║  🍽️  MindLoop CostOS API v2.5 (Modular)   ║
╠════════════════════════════════════════════╣
║  Puerto: ${PORT}                              ║
║  Módulos: 12                               ║
║  Endpoints: 71                             ║
║  Arquitectura: routes/index.js             ║
╚════════════════════════════════════════════╝
            `);
        });
    } catch (err) {
        console.error('❌ Error iniciando servidor:', err.message);
        process.exit(1);
    }
}

startServer();
