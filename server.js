/**
 * ═══════════════════════════════════════════════════════
 * server.js — MindLoop CostOS API (Monolito)
 * ═══════════════════════════════════════════════════════
 * Mapa de Secciones (~4400 líneas):
 *
 * L1-30:       Imports y dependencias
 * L31-75:      Configuración (email, CORS origins)
 * L76-150:     Middlewares globales (CORS, JSON, cookies)
 * L150-170:    Pool de base de datos (PostgreSQL)
 * L170-615:    CREATE TABLEs + migraciones idempotentes
 * L619-670:    Rate limiting (per-user)
 * L672-720:    Endpoints públicos (health, verify, login)
 * L724-970:    Autenticación (register, login, profile)
 * L970-1035:   Gestión de equipo (multi-cuenta, invitaciones)
 * L1037-1300:  Ingredientes CRUD + búsqueda + alias
 * L1304-1520:  Ingredientes-Proveedores (múltiples proveedores)
 * L1522-1640:  Variantes de receta (botella/copa)
 * L1644-1840:  Inventario avanzado (stock, consolidación)
 * L1841-1945:  Análisis avanzado (BCG Matrix, food cost)
 * L1947-2005:  Recetas CRUD
 * L2006-2015:  Proveedores (→ SupplierController)
 * L2016-2285:  Pedidos (orders) — ⚡ BUG DELETE FIJADO (Stabilization v1)
 * L2287-2520:  Ventas (sales) + stock deduction
 * L2522-2630:  Parse PDF con Claude AI
 * L2630-2895:  Sales bulk + ventas_diarias_resumen
 * L2899-2975:  Empleados (staff)
 * L2978-3115:  Horarios (scheduling)
 * L3116-3195:  Gastos fijos (fixed expenses)
 * L3198-3305:  Balance y estadísticas
 * L3308-3655:  Tracking diario (compras/ventas diarias)
 * L3657-3985:  Inteligencia (frescura, compras, sobrestock)
 * L3989-4235:  Mermas (waste tracking)
 * L4239-4330:  Health check + heartbeat
 * L4332-4404:  Error handlers + iniciar servidor
 *
 * @version Stabilization v1
 * @date 2026-02-08
 * ═══════════════════════════════════════════════════════
 */
// IMPORTANT: Sentry instrument must be loaded FIRST
require('./instrument.js');

require('dotenv').config();
const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { Resend } = require('resend');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// ========== ARQUITECTURA LIMPIA V2 ==========
const { setupEventHandlers } = require('./src/application/bootstrap');
const recipeRoutesV2 = require('./src/interfaces/http/routes/recipe.routes.v2');
const alertRoutes = require('./src/interfaces/http/routes/alert.routes');
const kpiRoutes = require('./src/interfaces/http/routes/kpi.routes');
const SupplierController = require('./src/interfaces/http/controllers/SupplierController');
// NOTA: PurchaseController, RecipeController, SaleController, StockMovementController,
// IngredientController fueron eliminados — sus rutas están inline en este archivo.

// Middleware modularizado
const { authMiddleware, requireAdmin, tokenBlacklist } = require('./src/middleware/auth');
const { globalLimiter, authLimiter, costlyApiLimiter } = require('./src/middleware/rateLimit');
const { log } = require('./src/utils/logger');
const { validateNumber, validatePrecio, validateCantidad } = require('./src/utils/validators');
const { calcularPrecioUnitario, upsertCompraDiaria, buildIngredientPriceMap } = require('./src/utils/businessHelpers');

// ========== RESEND (Email) ==========
// 🔒 FIX SEGURIDAD: API key SOLO desde variable de entorno, sin fallback hardcodeado
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
    console.warn('⚠️ RESEND_API_KEY no configurado - funcionalidad de email deshabilitada');
}
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ========== CONFIGURACIÓN ==========
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ FATAL ERROR: JWT_SECRET no configurado');
    process.exit(1);
}
const PORT = process.env.PORT || 3000;

// CORS: Orígenes permitidos (Combinar entorno + defaults)
const DEFAULT_ORIGINS = [
    'https://klaker79.github.io',
    'https://app.mindloop.cloud',
    'https://admin.mindloop.cloud',
    'http://localhost:5173',    // Vite dev
    'http://localhost:5174',    // Admin panel dev
    'http://localhost:5500',    // Live Server
    'http://127.0.0.1:5500'
];
const ENV_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [];
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS])];

const app = express();

// Make pool accessible to middleware (planGate)
app.locals.pool = null; // Set after pool is created

// Trust proxy for express-rate-limit behind Traefik
app.set('trust proxy', 1);

// ========== MIDDLEWARE CORS MEJORADO ==========
app.use((req, res, next) => {
    const origin = req.headers.origin;

    // 🔒 FIX SEGURIDAD: Solo permitir * para health checks, no para toda la API
    if (!origin || origin === '') {
        // Rutas permitidas sin origin (health checks, métricas, Uptime Kuma)
        const publicPaths = ['/', '/health', '/api/health', '/favicon.ico', '/api/metrics', '/api/heartbeat', '/api/auth/verify-email', '/api/auth/reset-password'];
        const isPublicPath = publicPaths.some(p => req.path === p || (p !== '/' && req.path.startsWith(p)));

        if (isPublicPath) {
            res.header('Access-Control-Allow-Origin', '*');
        } else {
            // Rechazar API requests sin origin (previene CSRF y uso no autorizado)
            log('warn', 'CORS: Request sin origin bloqueado', { path: req.path, ip: req.ip, method: req.method });
            return res.status(403).json({ error: 'CORS: Header Origin requerido' });
        }
    } else if (ALLOWED_ORIGINS.includes(origin) || /https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1]))/.test(origin)) {
        // Permitir explícitamente orígenes de red local (LAN)
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
    } else {
        // RECHAZAR orígenes no autorizados
        log('warn', 'CORS: Origen rechazado', { origin, url: req.originalUrl, ip: req.ip });
        return res.status(403).json({ error: 'CORS: Origen no autorizado' });
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-API-Key');
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

// Parser JSON (skip for Stripe webhook which needs raw body)
app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe/webhook') return next();
    express.json({ limit: '10mb' })(req, res, next);
});

// Parser de cookies para auth segura
app.use(cookieParser());

// ========== SECURITY HEADERS (Helmet) ==========
app.use(helmet({
    contentSecurityPolicy: false,           // API no sirve HTML
    crossOriginEmbedderPolicy: false,       // Permite cargas cross-origin
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
if (process.env.NODE_ENV === 'production') {
    app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true }));
}

app.use(globalLimiter);
// ========== GLOBAL ERROR HANDLERS ==========
// Catch unhandled promise rejections (async errors) - prevents server crash
process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled Promise Rejection', {
        reason: reason?.message || String(reason),
        stack: reason?.stack
    });
    // Don't exit - keep server running
});

// Catch uncaught exceptions (sync errors) - log and exit gracefully
// After uncaughtException the process is in an undefined state; Docker/PM2 will restart
process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception - restarting', {
        error: error.message,
        stack: error.stack
    });
    // Give logs time to flush (optional but good practice)
    setTimeout(() => {
        process.exit(1);
    }, 100);
});

// Graceful shutdown - stop accepting connections, then close pool
let server;
process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down gracefully');
    if (server) server.close();
    setTimeout(async () => {
        try { await pool.end(); } catch (e) { /* ignore */ }
        process.exit(0);
    }, 10000);
});

// ========== BASE DE DATOS ==========
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // Configuración optimizada para estabilidad
    max: 20,                          // Escalado para múltiples restaurantes concurrentes
    idleTimeoutMillis: 30000,         // Mantener conexiones 30s
    connectionTimeoutMillis: 10000,   // Timeout más generoso: 10s
    keepAlive: true,                  // Mantener conexiones vivas
    keepAliveInitialDelayMillis: 10000 // Enviar keepalive cada 10s
});

// Make pool available to middleware (planGate)
app.locals.pool = pool;

// Manejar errores del pool (evita crash por conexiones muertas)
pool.on('error', (err) => {
    log('error', 'Error inesperado en pool de BD', { error: err.message });
    // No hacer process.exit - el pool se recupera solo
});


// Test conexión e inicializar DB
const { initializeDatabase } = require('./src/db/init');

(async () => {
    try {
        await pool.query('SELECT NOW()');
        log('info', 'Conectado a PostgreSQL');
        await initializeDatabase(pool);
    } catch (err) {
        log('error', 'Error DB', { error: err.message });
    }
})();

// authMiddleware y requireAdmin importados de ./src/middleware/auth (línea 27)

// [CLEANUP] Rate limiter custom eliminado - express-rate-limit ya cubre esto (globalLimiter, línea ~159)

// Montar rutas de recetas v2 con autenticación
app.use('/api/v2/recipes', authMiddleware, recipeRoutesV2);
app.use('/api/v2/alerts', authMiddleware, alertRoutes);
app.use('/api/v2/kpis', authMiddleware, kpiRoutes);

// ========== ENDPOINTS PÚBLICOS ==========
app.get('/', (req, res) => {
    res.json({
        message: '🍽️ La Caleta 102 API',
        version: require('./package.json').version,
        status: 'running',
        docs: {
            health: '/api/health',
            login: 'POST /api/auth/login',
            register: 'POST /api/auth/register',
            dailyPurchases: 'GET/POST /api/daily/purchases',
            dailySales: 'GET /api/daily/sales',
            monthlySummary: 'GET /api/monthly/summary'
        }
    });
});

// DEBUG: REMOVED - No exponer en producción
// app.get('/api/debug/suppliers-test', (req, res) => { ... });

// [SEC-02] debug-sentry endpoint eliminado por seguridad (era temporal para verificación)

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: require('./package.json').version
        });
    } catch (e) {
        res.status(503).json({
            status: 'unhealthy',
            error: e.message
        });
    }
});


// ========== MONTAR RUTAS (extraídas a src/routes/) ==========
const mountRoutes = require("./src/routes");
let routeMountErrors = [];
try {
    routeMountErrors = mountRoutes(app, pool, { resend }) || [];
} catch (err) {
    console.error('[FATAL] Route mounting failed:', err.message);
    console.error(err.stack);
    routeMountErrors.push({ module: 'FATAL', error: err.message });
}

// Debug endpoint — muestra qué rutas están montadas (solo admin)
app.get('/api/debug/routes', authMiddleware, requireAdmin, (req, res) => {
    const routes = [];
    app._router.stack.forEach(layer => {
        if (layer.route) {
            routes.push({ method: Object.keys(layer.route.methods).join(','), path: layer.route.path });
        } else if (layer.name === 'router' && layer.handle.stack) {
            layer.handle.stack.forEach(r => {
                if (r.route) {
                    const prefix = layer.regexp.toString().includes('api') ? '/api' : '';
                    routes.push({ method: Object.keys(r.route.methods).join(','), path: prefix + r.route.path });
                }
            });
        }
    });
    res.json({
        totalRoutes: routes.length,
        mountErrors: routeMountErrors,
        hasVariantsRoute: routes.some(r => r.path.includes('recipes-variants')),
        routes: routes.filter(r => r.path.includes('recipe'))
    });
});

// ========== 404 CATCH-ALL ==========
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ========== SENTRY ERROR HANDLER ==========
// Debe ir ANTES del error handler custom para capturar errores no manejados
Sentry.setupExpressErrorHandler(app);

// ========== ERROR HANDLER GLOBAL ==========
app.use((err, req, res, next) => {
    log('error', 'Error no manejado', {
        error: err.message,
        stack: err.stack,
        url: req.originalUrl
    });
    res.status(500).json({
        error: 'Error interno del servidor',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ========== INICIAR SERVIDOR ==========
// Inicializar event handlers antes de escuchar
setupEventHandlers();

// Exportar app para tests E2E
module.exports = app;

server = app.listen(PORT, '0.0.0.0', () => {
    log('info', 'Servidor iniciado', { port: PORT, version: require('./package.json').version, cors: ALLOWED_ORIGINS });
    console.log(`🚀 API corriendo en puerto ${PORT}`);
    console.log(`📍 La Caleta 102 Dashboard API v3.0-INTEL (con arquitectura limpia v2)`);
    console.log(`✅ CORS habilitado para: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`📦 Rutas v2 montadas: /api/v2/recipes`);

    // ========== UPTIME KUMA HEARTBEAT ==========
    // Heartbeat verifica BD antes de reportar healthy
    const UPTIME_KUMA_PUSH_URL = process.env.UPTIME_KUMA_PUSH_URL;

    if (!UPTIME_KUMA_PUSH_URL) {
        log('warn', 'UPTIME_KUMA_PUSH_URL no configurada, heartbeat desactivado');
    } else {
        const sendHeartbeat = async () => {
            const https = require('https');
            try {
                // Verificar que la BD responde antes de enviar heartbeat
                await pool.query('SELECT 1');

                const url = `${UPTIME_KUMA_PUSH_URL}?status=up&msg=OK&ping=1`;
                https.get(url, (res) => {
                    if (res.statusCode === 200) {
                        log('debug', 'Heartbeat enviado a Uptime Kuma');
                    }
                }).on('error', (err) => {
                    log('warn', 'Error enviando heartbeat', { error: err.message });
                });
            } catch (dbErr) {
                // Si la BD no responde, NO enviamos heartbeat
                // Uptime Kuma detectará la falta de heartbeat como problema
                log('error', 'Heartbeat omitido - BD no responde', { error: dbErr.message });
            }
        };

        // Enviar heartbeat cada 60 segundos
        sendHeartbeat(); // Primer envío inmediato
        setInterval(sendHeartbeat, 60000);
        console.log(`💓 Heartbeat configurado para Uptime Kuma (cada 60s)`);
    }
});
// rebuild Sun Jan  4 01:51:53 CET 2026
