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
    'http://localhost:5173',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    'http://localhost:3004',
    'http://localhost:3005',
    'http://localhost:3006',
    'http://localhost:3007',
    'http://localhost:8080'
];
const ENV_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [];
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS])];

const app = express();

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

// Parser JSON
app.use(express.json({ limit: '10mb' }));

// Parser de cookies para auth segura
app.use(cookieParser());

// ========== SECURITY HEADERS (C5) ==========
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

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

// Graceful shutdown - close pool before exit
process.on('SIGTERM', async () => {
    log('info', 'SIGTERM received, shutting down gracefully');
    try { await pool.end(); } catch (e) { /* ignore */ }
    process.exit(0);
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

// Manejar errores del pool (evita crash por conexiones muertas)
pool.on('error', (err) => {
    log('error', 'Error inesperado en pool de BD', { error: err.message });
    // No hacer process.exit - el pool se recupera solo
});

// Test conexión e inicializar DB
(async () => {
    try {
        await pool.query('SELECT NOW()');
        log('info', 'Conectado a PostgreSQL');

        // Crear tablas
        await pool.query(`
      CREATE TABLE IF NOT EXISTS restaurantes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nombre VARCHAR(255) NOT NULL,
        rol VARCHAR(50) DEFAULT 'usuario',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ingredientes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        proveedor_id INTEGER,
        precio DECIMAL(10, 2) DEFAULT 0,
        unidad VARCHAR(50) DEFAULT 'kg',
        stock_actual DECIMAL(10, 2) DEFAULT 0,
        stock_minimo DECIMAL(10, 2) DEFAULT 0,
        stock_real DECIMAL(10, 2),
        familia VARCHAR(50) DEFAULT 'alimento',
        ultima_actualizacion_stock TIMESTAMP,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

        // MIGRACIÓN: Añadir columna familia si no existe
        try {
            await pool.query(`
            DO $$ 
            BEGIN 
              IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'ingredientes' AND column_name = 'familia') THEN 
                ALTER TABLE ingredientes ADD COLUMN familia VARCHAR(50) DEFAULT 'alimento'; 
              END IF; 
            END $$;
        `);
        } catch (e) {
            log('warn', 'Error en migración de columna familia', { error: e.message });
        }

        // MIGRACIÓN: Añadir columna activo si no existe (para toggle activar/desactivar)
        try {
            await pool.query(`
            DO $$ 
            BEGIN 
              IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'ingredientes' AND column_name = 'activo') THEN 
                ALTER TABLE ingredientes ADD COLUMN activo BOOLEAN DEFAULT TRUE; 
              END IF; 
            END $$;
        `);
            log('info', 'Migración: columna activo verificada');
        } catch (e) {
            log('warn', 'Error en migración de columna activo', { error: e.message });
        }

        await pool.query(`
      CREATE TABLE IF NOT EXISTS recetas (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        categoria VARCHAR(100) DEFAULT 'principal',
        precio_venta DECIMAL(10, 2) DEFAULT 0,
        porciones INTEGER DEFAULT 1,
        ingredientes JSONB DEFAULT '[]',
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS proveedores (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        contacto VARCHAR(255) DEFAULT '',
        telefono VARCHAR(50) DEFAULT '',
        email VARCHAR(255) DEFAULT '',
        direccion TEXT DEFAULT '',
        notas TEXT DEFAULT '',
        ingredientes INTEGER[] DEFAULT '{}',
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Tabla de relación muchos a muchos: ingredientes-proveedores
      CREATE TABLE IF NOT EXISTS ingredientes_proveedores (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER NOT NULL REFERENCES ingredientes(id) ON DELETE CASCADE,
        proveedor_id INTEGER NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
        precio DECIMAL(10, 2) NOT NULL,
        es_proveedor_principal BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ingrediente_id, proveedor_id)
      );
      -- Tabla de variantes de receta (ej: vino por botella o por copa)
      CREATE TABLE IF NOT EXISTS recetas_variantes (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
        nombre VARCHAR(100) NOT NULL,
        factor DECIMAL(5, 3) NOT NULL DEFAULT 1,
        precio_venta DECIMAL(10, 2) NOT NULL,
        codigo VARCHAR(20),
        activo BOOLEAN DEFAULT TRUE,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(receta_id, nombre)
      );
      -- Tabla de empleados para gestión de horarios
      CREATE TABLE IF NOT EXISTS empleados (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        color VARCHAR(7) DEFAULT '#3B82F6',
        horas_contrato INTEGER DEFAULT 40,
        coste_hora DECIMAL(10, 2) DEFAULT 10.00,
        dias_libres_fijos TEXT DEFAULT '',
        puesto VARCHAR(50) DEFAULT 'Camarero',
        activo BOOLEAN DEFAULT TRUE,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Tabla de horarios/turnos del personal
      CREATE TABLE IF NOT EXISTS horarios (
        id SERIAL PRIMARY KEY,
        empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        turno VARCHAR(20) DEFAULT 'completo',
        hora_inicio TIME,
        hora_fin TIME,
        es_extra BOOLEAN DEFAULT FALSE,
        notas TEXT,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(empleado_id, fecha)
      );
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        proveedor_id INTEGER,
        fecha DATE NOT NULL,
        ingredientes JSONB NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        estado VARCHAR(50) DEFAULT 'pendiente',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_recepcion TIMESTAMP,
        total_recibido DECIMAL(10, 2),
        restaurante_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ventas (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER REFERENCES recetas(id) ON DELETE CASCADE,
        cantidad INTEGER NOT NULL,
        precio_unitario DECIMAL(10, 2) NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurante_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_adjustments_v2 (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        cantidad DECIMAL(10, 2) NOT NULL,
        motivo VARCHAR(100) NOT NULL,
        notas TEXT,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        usuario_id INTEGER, 
        restaurante_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_snapshots_v2 (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        stock_virtual DECIMAL(10, 2) NOT NULL,
        stock_real DECIMAL(10, 2) NOT NULL,
        diferencia DECIMAL(10, 2) NOT NULL,
        restaurante_id INTEGER NOT NULL
      );
      /* =========================================
         TABLAS QUE FALTABAN (Añadidas por auditoría)
         ========================================= */
      
      -- Tabla de perdidas_stock
      CREATE TABLE IF NOT EXISTS perdidas_stock (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        ingrediente_id INTEGER REFERENCES ingredientes(id),
        cantidad NUMERIC(10,2) NOT NULL,
        motivo TEXT,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabla ingredientes_alias
      CREATE TABLE IF NOT EXISTS ingredientes_alias (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        alias VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_alias_restaurante UNIQUE (alias, restaurante_id)
      );

      -- Tabla gastos_fijos
      CREATE TABLE IF NOT EXISTS gastos_fijos (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        concepto VARCHAR(255) NOT NULL,
        monto_mensual NUMERIC(10, 2) NOT NULL DEFAULT 0,
        activo BOOLEAN DEFAULT true,
        dia_pago INTEGER DEFAULT 1,
        categoria VARCHAR(50),
        observaciones TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabla para registro de mermas/pérdidas
      CREATE TABLE IF NOT EXISTS mermas (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        ingrediente_nombre VARCHAR(255),
        cantidad DECIMAL(10, 3) NOT NULL,
        unidad VARCHAR(20),
        valor_perdida DECIMAL(10, 2) NOT NULL,
        motivo VARCHAR(50) NOT NULL,
        nota TEXT,
        responsable_id INTEGER,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurante_id INTEGER NOT NULL
      );
      -- Tabla para tokens de API (n8n, integraciones)
      CREATE TABLE IF NOT EXISTS api_tokens (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        nombre VARCHAR(255) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        ultimo_uso TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
      -- NUEVAS TABLAS: Tracking Diario de Costes y Ventas
      CREATE TABLE IF NOT EXISTS precios_compra_diarios (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        precio_unitario DECIMAL(10, 2) NOT NULL,
        cantidad_comprada DECIMAL(10, 2) NOT NULL,
        total_compra DECIMAL(10, 2) NOT NULL,
        proveedor_id INTEGER,
        notas TEXT,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ingrediente_id, fecha, restaurante_id)
      );
      CREATE TABLE IF NOT EXISTS ventas_diarias_resumen (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER REFERENCES recetas(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        cantidad_vendida INTEGER NOT NULL,
        precio_venta_unitario DECIMAL(10, 2) NOT NULL,
        coste_ingredientes DECIMAL(10, 2) NOT NULL,
        total_ingresos DECIMAL(10, 2) NOT NULL,
        beneficio_bruto DECIMAL(10, 2) NOT NULL,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(receta_id, fecha, restaurante_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
      CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
      CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante ON ingredientes(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_precios_compra_fecha ON precios_compra_diarios(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_diarias_fecha ON ventas_diarias_resumen(fecha);
      -- Cola de revisión: compras importadas por n8n que requieren aprobación
      CREATE TABLE IF NOT EXISTS compras_pendientes (
        id SERIAL PRIMARY KEY,
        batch_id UUID NOT NULL,
        ingrediente_nombre TEXT NOT NULL,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE SET NULL,
        precio DECIMAL(10,2) NOT NULL,
        cantidad DECIMAL(10,2) NOT NULL,
        fecha DATE NOT NULL,
        estado VARCHAR(20) DEFAULT 'pendiente',
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        aprobado_at TIMESTAMP,
        notas TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_compras_pendientes_estado ON compras_pendientes(estado, restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_compras_pendientes_batch ON compras_pendientes(batch_id);

      -- Performance indexes (added from analysis report)
      CREATE INDEX IF NOT EXISTS idx_mermas_rest_fecha ON mermas(restaurante_id, fecha);
      CREATE INDEX IF NOT EXISTS idx_mermas_deleted ON mermas(deleted_at) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_ingredientes_rest_active ON ingredientes(restaurante_id, deleted_at) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_ventas_rest_fecha ON ventas(restaurante_id, fecha) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_pedidos_rest_deleted ON pedidos(restaurante_id, deleted_at) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_recetas_rest_deleted ON recetas(restaurante_id, deleted_at) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_precios_compra_rest_fecha ON precios_compra_diarios(restaurante_id, fecha);
    `);

        // ========== MIGRACIONES DE COLUMNAS ESTÁNDAR ==========
        log('info', 'Ejecutando migraciones de columnas estándar...');

        // Añadir columna 'codigo' a ingredientes
        try {
            await pool.query(`
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS codigo VARCHAR(20);
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            `);
        } catch (e) { log('warn', 'Migración ingredientes.codigo', { error: e.message }); }

        // ⚡ FIX: Columnas faltantes detectadas en auditoría
        try {
            await pool.query(`
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS rendimiento NUMERIC(5,2) DEFAULT 100;
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS formato_compra VARCHAR(50);
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS cantidad_por_formato NUMERIC(10,3);
                
                ALTER TABLE mermas ADD COLUMN IF NOT EXISTS periodo_id INTEGER;
                ALTER TABLE mermas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                
                ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'warning';
            `);
            log('info', 'Migración columnas auditoría completada');
        } catch (e) { log('warn', 'Migración columnas auditoría', { error: e.message }); }

        // Añadir columna 'codigo' a recetas
        try {
            await pool.query(`
                ALTER TABLE recetas ADD COLUMN IF NOT EXISTS codigo VARCHAR(20);
                ALTER TABLE recetas ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            `);
        } catch (e) { log('warn', 'Migración recetas.codigo', { error: e.message }); }

        // Añadir columnas a proveedores
        try {
            await pool.query(`
                ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS codigo VARCHAR(20);
                ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS cif VARCHAR(20);
                ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            `);
        } catch (e) { log('warn', 'Migración proveedores.codigo', { error: e.message }); }

        // Añadir columnas para verificación de email
        try {
            await pool.query(`
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verification_token VARCHAR(64);
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP;
            `);
            // Marcar usuarios existentes como verificados (para tu cuenta)
            await pool.query(`UPDATE usuarios SET email_verified = TRUE WHERE email_verified IS NULL`);
            log('info', 'Migración email_verified completada');
        } catch (e) { log('warn', 'Migración usuarios.email_verified', { error: e.message }); }

        // Añadir columnas para reset de contraseña
        try {
            await pool.query(`
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64);
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMP;
            `);
            log('info', 'Migración reset_token completada');
        } catch (e) { log('warn', 'Migración usuarios.reset_token', { error: e.message }); }

        // ========== MIGRACIONES SOFT DELETE ==========
        log('info', 'Ejecutando migraciones de soft delete...');
        try {
            await pool.query(`
                ALTER TABLE ventas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE recetas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
            `);
            log('info', 'Migraciones soft delete completadas');
        } catch (e) { log('warn', 'Migración soft delete', { error: e.message }); }

        // ========== MIGRACIÓN VARIANTES EN VENTAS ==========
        log('info', 'Ejecutando migración de variantes en ventas...');
        try {
            await pool.query(`
                ALTER TABLE ventas_diarias_resumen ADD COLUMN IF NOT EXISTS variante_id INTEGER REFERENCES recetas_variantes(id) ON DELETE SET NULL;
                ALTER TABLE ventas_diarias_resumen ADD COLUMN IF NOT EXISTS factor_aplicado DECIMAL(5, 3) DEFAULT 1;
            `);
            log('info', 'Migración variantes en ventas completada');
        } catch (e) { log('warn', 'Migración variante_id', { error: e.message }); }

        // ========== MIGRACIÓN: Tablas faltantes ==========
        log('info', 'Verificando tablas faltantes...');

        // Tabla ingredientes_alias (requerida por match y delete de ingredientes)
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS ingredientes_alias (
                    id SERIAL PRIMARY KEY,
                    ingrediente_id INTEGER NOT NULL REFERENCES ingredientes(id) ON DELETE CASCADE,
                    alias VARCHAR(255) NOT NULL,
                    restaurante_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(alias, restaurante_id)
                );
            `);
            log('info', 'Tabla ingredientes_alias verificada');
        } catch (e) { log('warn', 'Migración ingredientes_alias', { error: e.message }); }

        // Tabla gastos_fijos (requerida por expense routes)
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS gastos_fijos (
                    id SERIAL PRIMARY KEY,
                    concepto VARCHAR(255) NOT NULL,
                    monto_mensual DECIMAL(10, 2) DEFAULT 0,
                    activo BOOLEAN DEFAULT TRUE,
                    restaurante_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            log('info', 'Tabla gastos_fijos verificada');
        } catch (e) { log('warn', 'Migración gastos_fijos', { error: e.message }); }

        // Columnas faltantes en ingredientes
        try {
            await pool.query(`
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS formato_compra VARCHAR(50);
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS cantidad_por_formato DECIMAL(10, 3);
                ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS rendimiento INTEGER DEFAULT 100;
            `);
            log('info', 'Columnas formato_compra/cantidad_por_formato/rendimiento verificadas');
        } catch (e) { log('warn', 'Migración columnas ingredientes', { error: e.message }); }

        // Columna pedido_id en precios_compra_diarios + migración UNIQUE constraint
        // ⚡ FIX Stabilization v1: Permitir múltiples filas por ingrediente/fecha si vienen de pedidos distintos
        try {
            await pool.query(`
                ALTER TABLE precios_compra_diarios ADD COLUMN IF NOT EXISTS pedido_id INTEGER;
            `);
            // Migrar constraint: de UNIQUE(ingrediente_id, fecha, restaurante_id) 
            // a UNIQUE INDEX que incluye pedido_id (COALESCE para NULLs)
            await pool.query(`
                ALTER TABLE precios_compra_diarios 
                    DROP CONSTRAINT IF EXISTS precios_compra_diarios_ingrediente_id_fecha_restaurante_id_key;
            `);
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_pcd_ing_fecha_rest_pedido
                    ON precios_compra_diarios (ingrediente_id, fecha, restaurante_id, (COALESCE(pedido_id, 0)));
            `);
            log('info', 'Migración UNIQUE constraint precios_compra_diarios completada (ahora incluye pedido_id)');
        } catch (e) { log('warn', 'Migración pedido_id / UNIQUE constraint', { error: e.message }); }

        // Columna periodo_id en mermas
        try {
            await pool.query(`
                ALTER TABLE mermas ADD COLUMN IF NOT EXISTS periodo_id INTEGER;
            `);
            log('info', 'Columna periodo_id en mermas verificada');
        } catch (e) { log('warn', 'Migración periodo_id mermas', { error: e.message }); }

        // ========== LIMPIEZA DE TABLAS OBSOLETAS ==========
        log('info', 'Limpiando tablas obsoletas...');

        try {
            await pool.query(`
                DROP TABLE IF EXISTS daily_records CASCADE;
                DROP TABLE IF EXISTS lanave_ventas_tpv CASCADE;
                DROP TABLE IF EXISTS producto_id_tpv CASCADE;
                DROP TABLE IF EXISTS snapshots_diarios CASCADE;
                DROP TABLE IF EXISTS inventory_counts CASCADE;
            `);
            log('info', 'Tablas obsoletas eliminadas');
        } catch (e) { log('warn', 'Error eliminando tablas obsoletas', { error: e.message }); }

        log('info', 'Tablas y migraciones completadas');
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
mountRoutes(app, pool, { resend });

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

app.listen(PORT, '0.0.0.0', () => {
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
