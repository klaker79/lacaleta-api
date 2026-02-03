require('dotenv').config();
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
const PurchaseController = require('./src/interfaces/http/controllers/PurchaseController');
const RecipeController = require('./src/interfaces/http/controllers/RecipeController');
const SaleController = require('./src/interfaces/http/controllers/SaleController');
const StockMovementController = require('./src/interfaces/http/controllers/StockMovementController');
const IngredientController = require('./src/interfaces/http/controllers/IngredientController');

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
        const publicPaths = ['/', '/health', '/api/health', '/favicon.ico', '/api/metrics', '/api/heartbeat'];
        const isPublicPath = publicPaths.some(p => req.path === p || (p !== '/' && req.path.startsWith(p)));

        if (isPublicPath) {
            res.header('Access-Control-Allow-Origin', '*');
        } else {
            // Rechazar API requests sin origin (previene CSRF y uso no autorizado)
            log('warn', 'CORS: Request sin origin bloqueado', { path: req.path, ip: req.ip, method: req.method });
            return res.status(403).json({ error: 'CORS: Header Origin requerido' });
        }
    } else if (ALLOWED_ORIGINS.includes(origin)) {
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

// ========== RATE LIMITING ==========
// Protección contra DDoS y brute-force
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 1000, // 1000 requests por ventana
    message: { error: 'Demasiadas peticiones, intenta más tarde' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 50, // 50 intentos de login (aumentado para evitar bloqueos frecuentes)
    message: { error: 'Demasiados intentos de login, espera 15 minutos' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use(globalLimiter);

// Logging Persistente
const LOG_FILE = path.join(__dirname, 'server.log');
const log = (level, message, data = {}) => {
    const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data
    });
    console.log(logEntry);
    fs.appendFile(LOG_FILE, logEntry + '\n', (err) => {
        if (err) console.error('Error writing to log file:', err);
    });
};

// ========== VALIDACIÓN NUMÉRICA SEGURA ==========
// Helper para validar y sanitizar inputs numéricos (previene NaN, Infinity, negativos)
const validateNumber = (value, defaultVal = 0, min = 0, max = Infinity) => {
    const num = parseFloat(value);
    if (isNaN(num) || !isFinite(num)) return defaultVal;
    if (num < min) return min;
    if (num > max) return max;
    return num;
};

// Helper para validar precio (debe ser >= 0)
const validatePrecio = (value) => validateNumber(value, 0, 0, 999999);

// Helper para validar cantidad/stock (debe ser >= 0)
const validateCantidad = (value) => validateNumber(value, 0, 0, 999999);

// ========== GLOBAL ERROR HANDLERS ==========
// Catch unhandled promise rejections (async errors) - prevents server crash
process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled Promise Rejection', {
        reason: reason?.message || String(reason),
        stack: reason?.stack
    });
    // Don't exit - keep server running
});

// Catch uncaught exceptions (sync errors) - prevents server crash
process.on('uncaughtException', (error) => {
    log('error', 'Uncaught Exception', {
        error: error.message,
        stack: error.stack
    });
    // Don't exit - keep server running
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    log('info', 'SIGTERM received, shutting down gracefully');
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
    max: 10,                          // Aumentado para manejar más usuarios
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

        // ========== MIGRACIONES SOFT DELETE ==========
        log('info', 'Ejecutando migraciones de soft delete...');
        try {
            await pool.query(`
                ALTER TABLE ventas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE recetas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
                ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
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

// ========== MIDDLEWARE DE AUTENTICACIÓN ==========
const authMiddleware = (req, res, next) => {
    // 1. Intentar leer token de httpOnly cookie (navegador)
    // 2. Fallback a Authorization header (API/n8n/Postman)
    let token = req.cookies?.auth_token;

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
            // Limpiar cookie expirada
            res.clearCookie('auth_token');
        }

        return res.status(401).json({
            error: errorMsg,
            code: code,
            expiredAt: error.expiredAt || null
        });
    }
};

const requireAdmin = (req, res, next) => {
    if (!req.user || (req.user.rol !== 'admin' && req.user.rol !== 'api')) {
        log('warn', 'Acceso denegado a ruta protegida', {
            user: req.user ? req.user.email : 'anon',
            url: req.originalUrl
        });
        return res.status(403).json({ error: 'Acceso denegado: Requiere rol de Administrador' });
    }
    next();
};

// ========== RUTAS V2 (Arquitectura Limpia) ==========
// Montar rutas de recetas v2 con autenticación
app.use('/api/v2/recipes', authMiddleware, recipeRoutesV2);
app.use('/api/v2/alerts', authMiddleware, alertRoutes);
app.use('/api/v2/kpis', authMiddleware, kpiRoutes);

// ========== ENDPOINTS PÚBLICOS ==========
app.get('/', (req, res) => {
    res.json({
        message: '🍽️ La Caleta 102 API',
        version: '2.3.0',
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

// DEBUG: Test supplier routes
app.get('/api/debug/suppliers-test', (req, res) => {
    res.json({
        message: 'Supplier routes debug endpoint works',
        timestamp: new Date().toISOString(),
        routes: ['GET /api/ingredients/:id/suppliers', 'POST /api/ingredients/:id/suppliers']
    });
});

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.3.0',
            cors_origins: ALLOWED_ORIGINS
        });
    } catch (e) {
        res.status(503).json({
            status: 'unhealthy',
            error: e.message
        });
    }
});

// ========== AUTENTICACIÓN ==========
app.post('/api/auth/login', authLimiter, async (req, res) => {
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

        // Email verification check deshabilitado temporalmente
        // if (user.email_verified === false) {
        //     return res.status(403).json({ error: 'Tu cuenta no está verificada. Revisa tu email.', needsVerification: true });
        // }

        const token = jwt.sign(
            { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol },
            JWT_SECRET,
            { expiresIn: '7d' } // 7 días de sesión
        );

        log('info', 'Login exitoso', { userId: user.id, email });

        // Establecer token en httpOnly cookie (seguro para navegadores)
        const isProduction = process.env.NODE_ENV === 'production';
        res.cookie('auth_token', token, {
            httpOnly: true,           // No accesible desde JavaScript
            secure: isProduction,     // Solo HTTPS en producción
            sameSite: 'lax',          // Protección CSRF (lax permite navegación normal)
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
            path: '/'
        });

        // También enviar token en respuesta para compatibilidad con API clients (n8n, Postman)
        res.json({
            token,  // Mantener para backwards compatibility con API tokens
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

// Verificar token (útil para debugging y n8n)
app.get('/api/auth/verify', authMiddleware, (req, res) => {
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

// Logout - Limpiar cookie de autenticación
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    log('info', 'Logout exitoso');
    res.json({ success: true, message: 'Sesión cerrada correctamente' });
});

// Generar token de API de larga duración (para n8n, Zapier, etc.)
app.post('/api/auth/api-token', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { nombre, duracionDias } = req.body;
        const dias = duracionDias || 365; // Por defecto 1 año

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

        // Guardar hash del token para tracking (opcional)
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

// 🔒 FIX SEGURIDAD: Código de invitación SOLO desde variable de entorno
const INVITATION_CODE = process.env.INVITATION_CODE;
if (!INVITATION_CODE) {
    console.error('❌ FATAL ERROR: INVITATION_CODE no configurado - registro deshabilitado');
    // No hacemos process.exit() para no romper el servidor, pero el registro fallará
}

app.post('/api/auth/register', async (req, res) => {
    const client = await pool.connect();
    try {
        const { nombre, email, password, codigoInvitacion } = req.body;

        if (!nombre || !email || !password) {
            return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
        }

        if (!codigoInvitacion || codigoInvitacion !== INVITATION_CODE) {
            return res.status(403).json({ error: 'Código de invitación inválido' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const existingUser = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'El email ya está registrado' });
        }

        // Transacción para evitar restaurantes huérfanos si falla la creación del usuario
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
            JWT_SECRET,
            { expiresIn: '7d' } // 7 días de sesión
        );

        log('info', 'Registro exitoso con código de invitación', { email });

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

app.get('/api/auth/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ error: 'Token requerido' });

        const result = await pool.query(
            `SELECT u.*, r.nombre as restaurante_nombre FROM usuarios u JOIN restaurantes r ON u.restaurante_id = r.id 
             WHERE u.verification_token = $1 AND u.verification_expires > NOW()`, [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Token inválido o expirado' });
        }

        const user = result.rows[0];
        await pool.query(`UPDATE usuarios SET email_verified = TRUE, verification_token = NULL WHERE id = $1`, [user.id]);

        const jwtToken = jwt.sign(
            { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol },
            JWT_SECRET, { expiresIn: '7d' } // 7 días de sesión
        );

        log('info', 'Email verificado', { email: user.email });

        res.json({
            message: '¡Cuenta verificada!',
            token: jwtToken,
            user: { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol, restaurante: user.restaurante_nombre, restauranteId: user.restaurante_id }
        });
    } catch (err) {
        log('error', 'Error verificando email', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== GESTIÓN DE EQUIPO (MULTI-CUENTA) ==========
app.get('/api/team', authMiddleware, async (req, res) => {
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

app.post('/api/team/invite', authMiddleware, requireAdmin, async (req, res) => {
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
            'INSERT INTO usuarios (restaurante_id, nombre, email, password_hash, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id, nombre, email, rol',
            [req.restauranteId, nombre, email, passwordHash, nuevoRol]
        );

        log('info', 'Nuevo usuario de equipo creado', { admin: req.user.email, newUser: email });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando usuario equipo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/team/:id', authMiddleware, requireAdmin, async (req, res) => {
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

// ========== INGREDIENTES ==========
app.get('/api/ingredients', authMiddleware, async (req, res) => {
    try {
        const { include_inactive } = req.query;
        // Por defecto solo devuelve activos, a menos que se pida incluir inactivos
        let query = 'SELECT * FROM ingredientes WHERE restaurante_id = $1';
        if (include_inactive !== 'true') {
            query += ' AND (activo IS NULL OR activo = TRUE)';
        }
        query += ' ORDER BY activo DESC NULLS FIRST, id';

        const result = await pool.query(query, [req.restauranteId]);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo ingredientes', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// ============================================
// MATCH INGREDIENT BY NAME (with alias support)
// POST /api/ingredients/match
// Busca ingrediente por nombre exacto, luego por alias
// ============================================
app.post('/api/ingredients/match', authMiddleware, async (req, res) => {
    try {
        const { nombre } = req.body;

        if (!nombre || typeof nombre !== 'string') {
            return res.status(400).json({
                found: false,
                error: 'Se requiere el campo nombre'
            });
        }

        const nombreLimpio = nombre.trim();

        // 1. Buscar por nombre exacto (case insensitive)
        let result = await pool.query(`
            SELECT id, nombre, unidad, precio, cantidad_por_formato, formato_compra, stock_actual
            FROM ingredientes 
            WHERE restaurante_id = $1 
              AND LOWER(nombre) = LOWER($2)
              AND (activo IS NULL OR activo = TRUE)
            LIMIT 1
        `, [req.restauranteId, nombreLimpio]);

        if (result.rows.length > 0) {
            const ing = result.rows[0];
            return res.json({
                found: true,
                match_type: 'exact',
                ingrediente: {
                    id: ing.id,
                    nombre: ing.nombre,
                    unidad: ing.unidad,
                    precio: parseFloat(ing.precio) || 0,
                    cantidad_por_formato: parseFloat(ing.cantidad_por_formato) || null,
                    formato_compra: ing.formato_compra,
                    stock_actual: parseFloat(ing.stock_actual) || 0
                }
            });
        }

        // 2. Buscar en tabla de alias
        result = await pool.query(`
            SELECT i.id, i.nombre, i.unidad, i.precio, i.cantidad_por_formato, i.formato_compra, i.stock_actual, a.alias
            FROM ingredientes_alias a
            JOIN ingredientes i ON a.ingrediente_id = i.id
            WHERE a.restaurante_id = $1 
              AND LOWER(a.alias) = LOWER($2)
              AND (i.activo IS NULL OR i.activo = TRUE)
            LIMIT 1
        `, [req.restauranteId, nombreLimpio]);

        if (result.rows.length > 0) {
            const ing = result.rows[0];
            return res.json({
                found: true,
                match_type: 'alias',
                alias_used: ing.alias,
                ingrediente: {
                    id: ing.id,
                    nombre: ing.nombre,
                    unidad: ing.unidad,
                    precio: parseFloat(ing.precio) || 0,
                    cantidad_por_formato: parseFloat(ing.cantidad_por_formato) || null,
                    formato_compra: ing.formato_compra,
                    stock_actual: parseFloat(ing.stock_actual) || 0
                }
            });
        }

        // 3. Buscar por coincidencia parcial (LIKE)
        result = await pool.query(`
            SELECT id, nombre, unidad, precio, cantidad_por_formato, formato_compra, stock_actual
            FROM ingredientes 
            WHERE restaurante_id = $1 
              AND LOWER(nombre) LIKE LOWER($2)
              AND (activo IS NULL OR activo = TRUE)
            ORDER BY LENGTH(nombre) ASC
            LIMIT 1
        `, [req.restauranteId, `%${nombreLimpio}%`]);

        if (result.rows.length > 0) {
            const ing = result.rows[0];
            return res.json({
                found: true,
                match_type: 'partial',
                ingrediente: {
                    id: ing.id,
                    nombre: ing.nombre,
                    unidad: ing.unidad,
                    precio: parseFloat(ing.precio) || 0,
                    cantidad_por_formato: parseFloat(ing.cantidad_por_formato) || null,
                    formato_compra: ing.formato_compra,
                    stock_actual: parseFloat(ing.stock_actual) || 0
                }
            });
        }

        // No encontrado
        return res.json({
            found: false,
            searched_name: nombreLimpio,
            message: 'Ingrediente no encontrado. Considere añadirlo o crear un alias.'
        });

    } catch (err) {
        log('error', 'Error en match ingrediente', { error: err.message });
        res.status(500).json({ found: false, error: 'Error interno' });
    }
});

app.post('/api/ingredients', authMiddleware, async (req, res) => {
    try {
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia, formato_compra, cantidad_por_formato, rendimiento } = req.body;

        // Validación numérica segura (previene NaN, valores negativos)
        const finalPrecio = validatePrecio(precio);
        const finalStockActual = validateCantidad(stockActual ?? stock_actual);
        const finalStockMinimo = validateCantidad(stockMinimo ?? stock_minimo);
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const finalFamilia = familia || 'alimento';
        const finalFormatoCompra = formato_compra || null;
        const finalCantidadPorFormato = cantidad_por_formato ? validateCantidad(cantidad_por_formato) : null;
        const finalRendimiento = parseInt(rendimiento) || 100;

        const result = await pool.query(
            'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, familia, restaurante_id, formato_compra, cantidad_por_formato, rendimiento) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
            [nombre, finalProveedorId, finalPrecio, unidad || 'kg', finalStockActual, finalStockMinimo, finalFamilia, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato, finalRendimiento]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/ingredients/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body;

        // 🔒 FIX CRÍTICO: Primero obtener valores ACTUALES del ingrediente
        // Esto previene sobrescribir campos con valores por defecto cuando no vienen en el request
        const existingResult = await pool.query(
            'SELECT * FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );

        if (existingResult.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        const existing = existingResult.rows[0];

        // 🔒 Merge: Solo actualizar campos que vengan EXPLÍCITAMENTE en el request
        // Si un campo no viene o es undefined, mantener el valor existente
        const finalNombre = body.nombre !== undefined ? body.nombre : existing.nombre;
        const finalProveedorId = body.proveedorId !== undefined ? body.proveedorId :
            (body.proveedor_id !== undefined ? body.proveedor_id : existing.proveedor_id);
        const finalPrecio = body.precio !== undefined ? validatePrecio(body.precio) : parseFloat(existing.precio) || 0;
        const finalUnidad = body.unidad !== undefined ? body.unidad : existing.unidad;
        // 🔒 FIX CRÍTICO: Priorizar stock_actual (snake_case del backend) sobre stockActual (camelCase legacy)
        // Problema anterior: body.stockActual ?? body.stock_actual → si stockActual=0, usaba 0 aunque stock_actual=5
        const finalStockActual = (body.stock_actual !== undefined)
            ? validateCantidad(body.stock_actual)
            : (body.stockActual !== undefined)
                ? validateCantidad(body.stockActual)
                : parseFloat(existing.stock_actual) || 0;

        const finalStockMinimo = (body.stock_minimo !== undefined)
            ? validateCantidad(body.stock_minimo)
            : (body.stockMinimo !== undefined)
                ? validateCantidad(body.stockMinimo)
                : parseFloat(existing.stock_minimo) || 0;
        const finalFamilia = body.familia !== undefined ? body.familia : (existing.familia || 'alimento');
        const finalFormatoCompra = body.formato_compra !== undefined ? body.formato_compra : existing.formato_compra;
        const finalCantidadPorFormato = body.cantidad_por_formato !== undefined
            ? (body.cantidad_por_formato ? validateCantidad(body.cantidad_por_formato) : null)
            : existing.cantidad_por_formato;
        const finalRendimiento = body.rendimiento !== undefined
            ? (parseInt(body.rendimiento) || 100)
            : (existing.rendimiento || 100);

        // Log para debug (remover en producción)
        log('info', 'Actualizando ingrediente con preservación de datos', {
            id,
            cambios: Object.keys(body).filter(k => body[k] !== undefined),
            cantidadPorFormato: { antes: existing.cantidad_por_formato, despues: finalCantidadPorFormato }
        });

        const result = await pool.query(
            'UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, stock_actual=$5, stock_minimo=$6, familia=$7, formato_compra=$10, cantidad_por_formato=$11, rendimiento=$12 WHERE id=$8 AND restaurante_id=$9 RETURNING *',
            [finalNombre, finalProveedorId, finalPrecio, finalUnidad, finalStockActual, finalStockMinimo, finalFamilia, id, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato, finalRendimiento]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        log('error', 'Error actualizando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/ingredients/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Borrar asociaciones con proveedores (foreign key)
        await client.query('DELETE FROM ingredientes_proveedores WHERE ingrediente_id = $1', [req.params.id]);
        // Borrar alias (foreign key)
        await client.query('DELETE FROM ingredientes_alias WHERE ingrediente_id = $1', [req.params.id]);
        // Luego borrar el ingrediente
        await client.query('DELETE FROM ingredientes WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        await client.query('COMMIT');
        res.json({ message: 'Eliminado' });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// Toggle activo/inactivo ingrediente (en lugar de eliminar)
app.patch('/api/ingredients/:id/toggle-active', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { activo } = req.body;

        const result = await pool.query(
            'UPDATE ingredientes SET activo = $1 WHERE id = $2 AND restaurante_id = $3 RETURNING *',
            [activo, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        log('info', `Ingrediente ${activo ? 'activado' : 'desactivado'}`, { id, nombre: result.rows[0].nombre });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error toggle activo ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== INGREDIENTES - PROVEEDORES MÚLTIPLES ==========

// GET /api/ingredients-suppliers - Obtener TODOS los ingredientes_proveedores del restaurante
app.get('/api/ingredients-suppliers', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ip.id, ip.ingrediente_id, ip.proveedor_id, ip.precio, 
                   ip.es_proveedor_principal, ip.created_at,
                   p.nombre as proveedor_nombre
            FROM ingredientes_proveedores ip
            JOIN proveedores p ON ip.proveedor_id = p.id
            JOIN ingredientes i ON ip.ingrediente_id = i.id
            WHERE i.restaurante_id = $1
            ORDER BY ip.ingrediente_id, ip.es_proveedor_principal DESC
        `, [req.restauranteId]);

        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo ingredientes-proveedores', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// GET /api/ingredients/:id/suppliers - Obtener proveedores de un ingrediente
app.get('/api/ingredients/:id/suppliers', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar que el ingrediente pertenece al restaurante
        const checkIng = await pool.query(
            'SELECT id, nombre FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );

        if (checkIng.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        const result = await pool.query(`
            SELECT ip.id, ip.ingrediente_id, ip.proveedor_id, ip.precio, 
                   ip.es_proveedor_principal, ip.created_at,
                   p.nombre as proveedor_nombre, p.contacto, p.telefono, p.email
            FROM ingredientes_proveedores ip
            JOIN proveedores p ON ip.proveedor_id = p.id
            WHERE ip.ingrediente_id = $1
            ORDER BY ip.es_proveedor_principal DESC, p.nombre ASC
        `, [id]);

        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo proveedores de ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST /api/ingredients/:id/suppliers - Asociar proveedor a ingrediente
app.post('/api/ingredients/:id/suppliers', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { proveedor_id, precio, es_proveedor_principal } = req.body;

        if (!proveedor_id || precio === undefined) {
            return res.status(400).json({ error: 'proveedor_id y precio son requeridos' });
        }

        const precioNum = parseFloat(precio);
        if (isNaN(precioNum) || precioNum < 0) {
            return res.status(400).json({ error: 'Precio debe ser un número válido >= 0' });
        }

        // Verificar ingrediente
        const checkIng = await pool.query(
            'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );
        if (checkIng.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        // Verificar proveedor
        const checkProv = await pool.query(
            'SELECT id FROM proveedores WHERE id = $1 AND restaurante_id = $2',
            [proveedor_id, req.restauranteId]
        );
        if (checkProv.rows.length === 0) {
            return res.status(404).json({ error: 'Proveedor no encontrado' });
        }

        // Si es principal, desmarcar otros
        if (es_proveedor_principal) {
            await pool.query(
                'UPDATE ingredientes_proveedores SET es_proveedor_principal = FALSE WHERE ingrediente_id = $1',
                [id]
            );
            // Actualizar también en tabla ingredientes para compatibilidad
            // ⚠️ PROTECCIÓN: NO sobrescribir precio del ingrediente
            await pool.query(
                'UPDATE ingredientes SET proveedor_id = $1 WHERE id = $2',
                [proveedor_id, id]
            );
        }

        // UPSERT - insertar o actualizar si ya existe
        const result = await pool.query(`
            INSERT INTO ingredientes_proveedores (ingrediente_id, proveedor_id, precio, es_proveedor_principal)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (ingrediente_id, proveedor_id) 
            DO UPDATE SET precio = $3, es_proveedor_principal = $4
            RETURNING *
        `, [id, proveedor_id, precioNum, es_proveedor_principal || false]);

        log('info', 'Proveedor asociado a ingrediente', { ingrediente_id: id, proveedor_id, precio: precioNum });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error asociando proveedor a ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT /api/ingredients/:id/suppliers/:supplierId - Actualizar precio o principal
app.put('/api/ingredients/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
    try {
        const { id, supplierId } = req.params;
        const { precio, es_proveedor_principal } = req.body;

        // Verificar que la asociación existe
        const check = await pool.query(`
            SELECT ip.id FROM ingredientes_proveedores ip
            JOIN ingredientes i ON ip.ingrediente_id = i.id
            WHERE ip.ingrediente_id = $1 AND ip.proveedor_id = $2 AND i.restaurante_id = $3
        `, [id, supplierId, req.restauranteId]);

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Asociación no encontrada' });
        }

        // Si se marca como principal, desmarcar otros
        if (es_proveedor_principal) {
            await pool.query(
                'UPDATE ingredientes_proveedores SET es_proveedor_principal = FALSE WHERE ingrediente_id = $1',
                [id]
            );
            // Actualizar tabla ingredientes para compatibilidad
            // ⚠️ PROTECCIÓN: NO sobrescribir precio del ingrediente
            await pool.query(
                'UPDATE ingredientes SET proveedor_id = $1 WHERE id = $2',
                [supplierId, id]
            );
        }

        // Construir query dinámico
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (precio !== undefined) {
            const precioNum = parseFloat(precio);
            if (isNaN(precioNum) || precioNum < 0) {
                return res.status(400).json({ error: 'Precio debe ser un número válido >= 0' });
            }
            updates.push(`precio = $${paramCount++}`);
            values.push(precioNum);
        }

        if (es_proveedor_principal !== undefined) {
            updates.push(`es_proveedor_principal = $${paramCount++}`);
            values.push(es_proveedor_principal);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'Nada que actualizar' });
        }

        values.push(id, supplierId);
        const result = await pool.query(`
            UPDATE ingredientes_proveedores 
            SET ${updates.join(', ')}
            WHERE ingrediente_id = $${paramCount++} AND proveedor_id = $${paramCount}
            RETURNING *
        `, values);

        log('info', 'Actualizado proveedor de ingrediente', { ingrediente_id: id, proveedor_id: supplierId });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando proveedor de ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE /api/ingredients/:id/suppliers/:supplierId - Eliminar asociación
app.delete('/api/ingredients/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
    try {
        const { id, supplierId } = req.params;

        // Verificar que existe y pertenece al restaurante
        const check = await pool.query(`
            SELECT ip.id FROM ingredientes_proveedores ip
            JOIN ingredientes i ON ip.ingrediente_id = i.id
            WHERE ip.ingrediente_id = $1 AND ip.proveedor_id = $2 AND i.restaurante_id = $3
        `, [id, supplierId, req.restauranteId]);

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Asociación no encontrada' });
        }

        await pool.query(
            'DELETE FROM ingredientes_proveedores WHERE ingrediente_id = $1 AND proveedor_id = $2',
            [id, supplierId]
        );

        log('info', 'Eliminada asociación proveedor-ingrediente', { ingrediente_id: id, proveedor_id: supplierId });
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando proveedor de ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== VARIANTES DE RECETA (Botella/Copa) ==========

// GET /api/recipes-variants - Obtener TODAS las variantes del restaurante
app.get('/api/recipes-variants', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM recetas_variantes 
             WHERE restaurante_id = $1 
             ORDER BY receta_id, precio_venta DESC`,
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo todas las variantes', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// GET /api/recipes/:id/variants - Obtener variantes de una receta
app.get('/api/recipes/:id/variants', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT * FROM recetas_variantes 
             WHERE receta_id = $1 AND restaurante_id = $2 
             ORDER BY precio_venta DESC`,
            [id, req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo variantes', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST /api/recipes/:id/variants - Crear variante
app.post('/api/recipes/:id/variants', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, factor, precio_venta, codigo } = req.body;

        if (!nombre || precio_venta === undefined) {
            return res.status(400).json({ error: 'nombre y precio_venta son requeridos' });
        }

        // Verificar que la receta existe
        const checkReceta = await pool.query(
            'SELECT id FROM recetas WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );
        if (checkReceta.rows.length === 0) {
            return res.status(404).json({ error: 'Receta no encontrada' });
        }

        const result = await pool.query(
            `INSERT INTO recetas_variantes (receta_id, nombre, factor, precio_venta, codigo, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (receta_id, nombre) DO UPDATE SET factor = $3, precio_venta = $4, codigo = $5
             RETURNING *`,
            [id, nombre, factor || 1, parseFloat(precio_venta), codigo || null, req.restauranteId]
        );

        log('info', 'Variante creada', { receta_id: id, nombre, precio_venta });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando variante', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT /api/recipes/:id/variants/:variantId - Actualizar variante
app.put('/api/recipes/:id/variants/:variantId', authMiddleware, async (req, res) => {
    try {
        const { id, variantId } = req.params;
        const { nombre, factor, precio_venta, codigo, activo } = req.body;

        const result = await pool.query(
            `UPDATE recetas_variantes 
             SET nombre = COALESCE($1, nombre),
                 factor = COALESCE($2, factor),
                 precio_venta = COALESCE($3, precio_venta),
                 codigo = COALESCE($4, codigo),
                 activo = COALESCE($5, activo)
             WHERE id = $6 AND receta_id = $7 AND restaurante_id = $8
             RETURNING *`,
            [nombre, factor, precio_venta, codigo, activo, variantId, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Variante no encontrada' });
        }

        log('info', 'Variante actualizada', { variant_id: variantId });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando variante', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE /api/recipes/:id/variants/:variantId - Eliminar variante
app.delete('/api/recipes/:id/variants/:variantId', authMiddleware, async (req, res) => {
    try {
        const { id, variantId } = req.params;

        const result = await pool.query(
            'DELETE FROM recetas_variantes WHERE id = $1 AND receta_id = $2 AND restaurante_id = $3 RETURNING id',
            [variantId, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Variante no encontrada' });
        }

        log('info', 'Variante eliminada', { variant_id: variantId });
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando variante', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== INVENTARIO AVANZADO ==========
app.get('/api/inventory/complete', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
      SELECT 
        i.id,
        i.nombre,
        i.unidad,
        i.stock_actual as stock_virtual,
        i.stock_real,
        i.stock_minimo,
        i.proveedor_id,
        i.ultima_actualizacion_stock,
        i.formato_compra,
        i.cantidad_por_formato,
        CASE 
            WHEN i.stock_real IS NULL THEN NULL 
            ELSE (i.stock_real - i.stock_actual) 
        END as diferencia,
        -- Precio unitario: SIEMPRE dividir precio por cantidad_por_formato
        -- (La subquery de pedidos se elimina porque los pedidos históricos tienen precios por formato sin dividir)
        CASE 
          WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0 
          THEN i.precio / i.cantidad_por_formato
          ELSE i.precio 
        END as precio_medio,
        -- Valor stock = stock_actual × precio_unitario
        (i.stock_actual * CASE 
          WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0 
          THEN i.precio / i.cantidad_por_formato
          ELSE i.precio 
        END) as valor_stock
      FROM ingredientes i
      WHERE i.restaurante_id = $1
      ORDER BY i.id
    `, [req.restauranteId]);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error inventario completo', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

app.put('/api/inventory/:id/stock-real', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { stock_real } = req.body;

        const stockValidado = validateNumber(stock_real, 0, 0);
        if (stockValidado === null || stockValidado < 0) {
            return res.status(400).json({ error: 'Stock debe ser un número no negativo' });
        }

        const result = await pool.query(
            `UPDATE ingredientes 
       SET stock_real = $1, 
           ultima_actualizacion_stock = CURRENT_TIMESTAMP 
       WHERE id = $2 AND restaurante_id = $3 
       RETURNING *`,
            [stockValidado, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando stock real', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/inventory/bulk-update-stock', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { stocks } = req.body;
        await client.query('BEGIN');

        const updated = [];
        for (const item of stocks) {
            const result = await client.query(
                `UPDATE ingredientes 
         SET stock_real = $1, 
             ultima_actualizacion_stock = CURRENT_TIMESTAMP 
         WHERE id = $2 AND restaurante_id = $3 
         RETURNING *`,
                [item.stock_real, item.id, req.restauranteId]
            );
            if (result.rows.length > 0) {
                updated.push(result.rows[0]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, updated: updated.length, items: updated });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error bulk update stock', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// Endpoint para consolidar stock con lógica de Ajustes (ERP)
app.post('/api/inventory/consolidate', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { adjustments, snapshots, finalStock } = req.body;

        if (!req.restauranteId) {
            return res.status(401).json({ error: 'No autorizado: Restaurante ID nulo' });
        }

        await client.query('BEGIN');

        // 1. Guardar Snapshots
        if (snapshots && Array.isArray(snapshots)) {
            for (const snap of snapshots) {
                const ingId = parseInt(snap.id, 10);
                const real = parseFloat(snap.stock_real);
                const virtual = parseFloat(snap.stock_virtual);

                if (isNaN(ingId)) continue;

                const safeReal = isNaN(real) ? 0 : real;
                const safeVirtual = isNaN(virtual) ? 0 : virtual;
                const diff = safeReal - safeVirtual;

                await client.query(
                    `INSERT INTO inventory_snapshots_v2 
                     (ingrediente_id, stock_virtual, stock_real, diferencia, restaurante_id) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [ingId, safeVirtual.toFixed(2), safeReal.toFixed(2), diff.toFixed(2), req.restauranteId]
                );
            }
        }

        // 2. Guardar Ajustes
        if (adjustments && Array.isArray(adjustments)) {
            for (const adj of adjustments) {
                const ingId = parseInt(adj.ingrediente_id, 10);
                const cantidad = parseFloat(adj.cantidad);
                const motivo = adj.motivo ? String(adj.motivo).substring(0, 100) : 'Ajuste';
                const notas = adj.notas ? String(adj.notas) : '';

                if (isNaN(ingId)) continue;

                const safeCant = isNaN(cantidad) ? 0 : cantidad;

                await client.query(
                    `INSERT INTO inventory_adjustments_v2 
                     (ingrediente_id, cantidad, motivo, notas, restaurante_id) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [ingId, safeCant.toFixed(2), motivo, notas, req.restauranteId]
                );
            }
        }

        // 3. Actualizar Stock Maestro
        const updated = [];
        if (finalStock && Array.isArray(finalStock)) {
            for (const item of finalStock) {
                const ingId = parseInt(item.id, 10);
                const real = parseFloat(item.stock_real);

                if (isNaN(ingId)) continue;

                const safeReal = isNaN(real) ? 0 : real;

                const result = await client.query(
                    `UPDATE ingredientes
                     SET stock_actual = $1,
                         stock_real = NULL,
                         ultima_actualizacion_stock = CURRENT_TIMESTAMP
                     WHERE id = $2 AND restaurante_id = $3
                     RETURNING *`,
                    [safeReal.toFixed(2), ingId, req.restauranteId]
                );

                if (result.rows.length > 0) {
                    updated.push(result.rows[0]);
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, updated: updated.length, items: updated });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error en consolidación', { error: err.message });
        res.status(500).json({ error: 'Error interno: ' + err.message });
    } finally {
        client.release();
    }
});

// ========== ANÁLISIS AVANZADO ==========
app.get('/api/analysis/menu-engineering', authMiddleware, async (req, res) => {
    try {
        // Query 1: Ventas agrupadas por receta
        const ventas = await pool.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes,
                    SUM(v.cantidad) as cantidad_vendida,
                    SUM(v.total) as total_ventas
             FROM ventas v
             JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
             GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes`,
            [req.restauranteId]
        );

        if (ventas.rows.length === 0) {
            return res.json([]);
        }

        // Query 2: Todos los precios de ingredientes en UNA query
        // 🔧 FIX: Incluir cantidad_por_formato para calcular precio UNITARIO
        const ingredientesResult = await pool.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const preciosMap = new Map();
        ingredientesResult.rows.forEach(ing => {
            // ✅ Precio unitario = precio del formato / cantidad en el formato
            const precioFormato = parseFloat(ing.precio) || 0;
            const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
            const precioUnitario = precioFormato / cantidadPorFormato;
            preciosMap.set(ing.id, precioUnitario);
        });

        const analisis = [];
        const totalVentasRestaurante = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
        const promedioPopularidad = ventas.rows.length > 0 ? totalVentasRestaurante / ventas.rows.length : 0;
        let sumaMargenes = 0;

        // Calcular costes usando el Map (sin queries adicionales)
        for (const plato of ventas.rows) {
            const ingredientes = plato.ingredientes || [];
            let costePlato = 0;

            if (ingredientes && Array.isArray(ingredientes)) {
                for (const ing of ingredientes) {
                    const precioIng = preciosMap.get(ing.ingredienteId) || 0;
                    costePlato += precioIng * (ing.cantidad || 0);
                }
            }

            const margenContribucion = parseFloat(plato.precio_venta) - costePlato;
            sumaMargenes += margenContribucion * parseFloat(plato.cantidad_vendida);

            analisis.push({
                id: plato.id,
                nombre: plato.nombre,
                categoria: plato.categoria,
                precio_venta: plato.precio_venta,
                cantidad_vendida: plato.cantidad_vendida,
                total_ventas: plato.total_ventas,
                coste: costePlato,
                margen: margenContribucion,
                foodCost: parseFloat(plato.precio_venta) > 0
                    ? (costePlato / parseFloat(plato.precio_venta)) * 100
                    : 0,
                popularidad: parseFloat(plato.cantidad_vendida)
            });
        }

        const promedioMargen = totalVentasRestaurante > 0 ? sumaMargenes / totalVentasRestaurante : 0;
        const promedioFoodCost = analisis.length > 0
            ? analisis.reduce((sum, p) => sum + p.foodCost, 0) / analisis.length
            : 0;

        const resultado = analisis.map(p => {
            const esPopular = p.popularidad >= (promedioPopularidad * 0.7);
            const esRentable = p.margen >= promedioMargen;
            const foodCostAlto = p.foodCost > 33; // Umbral industria

            let clasificacion = 'perro';
            if (esPopular && esRentable) clasificacion = 'estrella';
            else if (esPopular && !esRentable) clasificacion = 'caballo';
            else if (!esPopular && esRentable) clasificacion = 'puzzle';

            return {
                ...p,
                clasificacion,
                metricas: {
                    esPopular,
                    esRentable,
                    foodCostAlto,
                    promedioPopularidad,
                    promedioMargen,
                    promedioFoodCost
                }
            };
        });

        res.json(resultado);
    } catch (err) {
        log('error', 'Error análisis menú', { error: err.message });
        res.status(500).json({ error: 'Error analizando menú', data: [] });
    }
});

// ========== RECETAS ==========
// === MIGRADO A CONTROLLER (Fase 4C) - DESHABILITADO POR BUG EN PRODUCCIÓN ===
// TODO: El RecipeRepository.findActive() filtra por 'activo = true' pero 
// algunas recetas en producción pueden tener activo = null, causando 500
// app.get('/api/recipes', authMiddleware, RecipeController.list);
// app.get('/api/recipes/:id', authMiddleware, RecipeController.getById);
// app.post('/api/recipes', authMiddleware, RecipeController.create);
// app.put('/api/recipes/:id', authMiddleware, RecipeController.update);
// app.delete('/api/recipes/:id', authMiddleware, RecipeController.delete);


// --- LEGACY (RESTAURADO - El controller tiene bug con 'activo') ---
app.get('/api/recipes', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM recetas WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY id', [req.restauranteId]);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo recetas', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

app.post('/api/recipes', authMiddleware, async (req, res) => {
    try {
        const { nombre, categoria, precio_venta, porciones, ingredientes, codigo } = req.body;
        const result = await pool.query(
            'INSERT INTO recetas (nombre, categoria, precio_venta, porciones, ingredientes, codigo, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [nombre, categoria || 'principal', precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), codigo || null, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando receta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/recipes/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, categoria, precio_venta, porciones, ingredientes, codigo } = req.body;
        const result = await pool.query(
            'UPDATE recetas SET nombre=$1, categoria=$2, precio_venta=$3, porciones=$4, ingredientes=$5, codigo=$6 WHERE id=$7 AND restaurante_id=$8 RETURNING *',
            [nombre, categoria, precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), codigo || null, id, req.restauranteId]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        log('error', 'Error actualizando receta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/recipes/:id', authMiddleware, async (req, res) => {
    try {
        // SOFT DELETE: marca como eliminado sin borrar datos
        const result = await pool.query(
            'UPDATE recetas SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING *',
            [req.params.id, req.restauranteId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Receta no encontrada o ya eliminada' });
        }
        log('info', 'Receta soft deleted', { id: req.params.id });
        res.json({ message: 'Eliminado', id: result.rows[0].id });
    } catch (err) {
        log('error', 'Error eliminando receta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== PROVEEDORES ==========
// === MIGRADO A CONTROLLER (Fase 4B) ===
app.get('/api/suppliers', authMiddleware, SupplierController.list);
app.get('/api/suppliers/:id', authMiddleware, SupplierController.getById);
app.post('/api/suppliers', authMiddleware, SupplierController.create);
app.put('/api/suppliers/:id', authMiddleware, SupplierController.update);
app.delete('/api/suppliers/:id', authMiddleware, SupplierController.delete);

// --- LEGACY (no se ejecuta - Express usa la primera ruta que coincide) ---
app.get('/api/suppliers', authMiddleware, async (req, res) => {
    try {
        // Obtener proveedores base
        const result = await pool.query('SELECT * FROM proveedores WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY id', [req.restauranteId]);
        const proveedores = result.rows || [];

        // Obtener ingredientes de la tabla de relación (ingredientes secundarios)
        const relaciones = await pool.query(
            'SELECT proveedor_id, ingrediente_id FROM ingredientes_proveedores WHERE proveedor_id = ANY($1)',
            [proveedores.map(p => p.id)]
        );

        // Crear mapa de ingredientes por proveedor
        const ingPorProveedor = {};
        relaciones.rows.forEach(rel => {
            if (!ingPorProveedor[rel.proveedor_id]) {
                ingPorProveedor[rel.proveedor_id] = new Set();
            }
            ingPorProveedor[rel.proveedor_id].add(rel.ingrediente_id);
        });

        // Combinar ingredientes de columna y de tabla de relación
        proveedores.forEach(prov => {
            const ingColumna = Array.isArray(prov.ingredientes) ? prov.ingredientes : [];
            const ingRelacion = ingPorProveedor[prov.id] ? Array.from(ingPorProveedor[prov.id]) : [];

            // Combinar sin duplicados
            const todosIng = new Set([...ingColumna, ...ingRelacion]);
            prov.ingredientes = Array.from(todosIng);
        });

        res.json(proveedores);
    } catch (err) {
        log('error', 'Error obteniendo proveedores', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

app.post('/api/suppliers', authMiddleware, async (req, res) => {
    try {
        const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;
        const result = await pool.query(
            'INSERT INTO proveedores (nombre, contacto, telefono, email, direccion, notas, ingredientes, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [nombre, contacto || '', telefono || '', email || '', direccion || '', notas || '', ingredientes || [], req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/suppliers/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;
        const result = await pool.query(
            'UPDATE proveedores SET nombre=$1, contacto=$2, telefono=$3, email=$4, direccion=$5, notas=$6, ingredientes=$7 WHERE id=$8 AND restaurante_id=$9 RETURNING *',
            [nombre, contacto || '', telefono || '', email || '', direccion || '', notas || '', ingredientes || [], id, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/suppliers/:id', authMiddleware, async (req, res) => {
    try {
        // SOFT DELETE: marca como eliminado sin borrar datos
        const result = await pool.query(
            'UPDATE proveedores SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING *',
            [req.params.id, req.restauranteId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Proveedor no encontrado o ya eliminado' });
        }
        log('info', 'Proveedor soft deleted', { id: req.params.id });
        res.json({ message: 'Eliminado', id: result.rows[0].id });
    } catch (err) {
        log('error', 'Error eliminando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== PEDIDOS ==========
// 🔧 IMPORTANTE: Las rutas de orders ahora se manejan en src/routes/order.routes.js
// El PurchaseController.update tiene validación canBeModified() que bloquea la recepción de pedidos.
// Las rutas modularizadas tienen la lógica correcta para registrar precios_compra_diarios.
// --- DESHABILITADO: PurchaseController routes causan conflicto con order.routes.js ---
// app.get('/api/orders', authMiddleware, PurchaseController.list);
// app.get('/api/orders/:id', authMiddleware, PurchaseController.getById);
// app.post('/api/orders', authMiddleware, PurchaseController.create);
// app.put('/api/orders/:id', authMiddleware, PurchaseController.update);
// app.delete('/api/orders/:id', authMiddleware, PurchaseController.delete);

// --- LEGACY (no se ejecuta - Express usa la primera ruta que coincide) ---
app.get('/api/orders', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pedidos WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY fecha DESC', [req.restauranteId]);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo pedidos', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

app.post('/api/orders', authMiddleware, async (req, res) => {
    try {
        const { proveedorId, fecha, ingredientes, total, estado } = req.body;
        const result = await pool.query(
            'INSERT INTO pedidos (proveedor_id, fecha, ingredientes, total, estado, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [proveedorId, fecha, JSON.stringify(ingredientes), total, estado || 'pendiente', req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/orders/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { estado, ingredientes, totalRecibido, fechaRecepcion, fecha_recepcion, total_recibido } = req.body;
        const fechaRecepcionFinal = fecha_recepcion || fechaRecepcion;

        await client.query('BEGIN');

        const result = await client.query(
            'UPDATE pedidos SET estado=$1, ingredientes=$2, total_recibido=$3, fecha_recepcion=$4 WHERE id=$5 AND restaurante_id=$6 RETURNING *',
            [estado, JSON.stringify(ingredientes), total_recibido || totalRecibido, fechaRecepcionFinal || new Date(), id, req.restauranteId]
        );

        // Si el pedido se marca como recibido, registrar los precios de compra diarios
        if (estado === 'recibido' && ingredientes && Array.isArray(ingredientes)) {
            const fechaCompra = fechaRecepcionFinal ? new Date(fechaRecepcionFinal) : new Date();

            for (const item of ingredientes) {
                const precioReal = parseFloat(item.precioReal || item.precioUnitario || item.precio_unitario) || 0;
                const cantidad = parseFloat(item.cantidadRecibida || item.cantidad) || 0;
                const total = precioReal * cantidad;

                // Upsert: si ya existe para ese ingrediente/fecha, sumar cantidades
                await client.query(`
                    INSERT INTO precios_compra_diarios 
                    (ingrediente_id, fecha, precio_unitario, cantidad_comprada, total_compra, restaurante_id, proveedor_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (ingrediente_id, fecha, restaurante_id)
                    DO UPDATE SET 
                        precio_unitario = EXCLUDED.precio_unitario,
                        cantidad_comprada = precios_compra_diarios.cantidad_comprada + EXCLUDED.cantidad_comprada,
                        total_compra = precios_compra_diarios.total_compra + EXCLUDED.total_compra
                `, [item.ingredienteId, fechaCompra, precioReal, cantidad, total, req.restauranteId, result.rows[0]?.proveedor_id || null]);
            }

            log('info', 'Compras diarias registradas desde pedido', { pedidoId: id, items: ingredientes.length });
        }

        await client.query('COMMIT');
        res.json(result.rows[0] || {});
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error actualizando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener el pedido antes de borrarlo para saber qué borrar
        const pedidoResult = await client.query(
            'SELECT * FROM pedidos WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL',
            [req.params.id, req.restauranteId]
        );

        if (pedidoResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pedido no encontrado o ya eliminado' });
        }

        const pedido = pedidoResult.rows[0];

        // 2. Si el pedido estaba recibido, borrar las compras diarias asociadas
        if (pedido.estado === 'recibido' && pedido.ingredientes) {
            const ingredientes = typeof pedido.ingredientes === 'string'
                ? JSON.parse(pedido.ingredientes)
                : pedido.ingredientes;

            const fechaRecepcion = pedido.fecha_recepcion || pedido.fecha;

            for (const item of ingredientes) {
                const ingId = item.ingredienteId || item.ingrediente_id;
                const cantidadRecibida = parseFloat(item.cantidadRecibida || item.cantidad || 0);

                // Borrar de precios_compra_diarios
                await client.query(
                    `DELETE FROM precios_compra_diarios 
                     WHERE ingrediente_id = $1 
                     AND fecha::date = $2::date 
                     AND restaurante_id = $3`,
                    [ingId, fechaRecepcion, req.restauranteId]
                );

                // Revertir el stock del ingrediente
                if (cantidadRecibida > 0) {
                    await client.query(
                        `UPDATE ingredientes 
                         SET stock_actual = stock_actual - $1, 
                             ultima_actualizacion_stock = NOW() 
                         WHERE id = $2 AND restaurante_id = $3`,
                        [cantidadRecibida, ingId, req.restauranteId]
                    );
                }
            }

            log('info', 'Compras diarias y stock revertidos por borrado de pedido', {
                pedidoId: req.params.id,
                ingredientes: ingredientes.length
            });
        }

        // 3. SOFT DELETE del pedido
        await client.query(
            'UPDATE pedidos SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1',
            [req.params.id]
        );

        await client.query('COMMIT');
        log('info', 'Pedido eliminado con cascading delete', { id: req.params.id, estado: pedido.estado });
        res.json({ message: 'Eliminado', id: pedido.id });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// ========== VENTAS ==========
// === MIGRADO A CONTROLLER (Fase 4D) - DESHABILITADO ===
// TODO: SaleController.create no busca precio de receta ni descuenta inventario
// El código legacy SÍ lo hace. Restaurar legacy hasta migrar completamente.
// app.get('/api/sales', authMiddleware, SaleController.list);
// app.post('/api/sales', authMiddleware, SaleController.create);
// app.post('/api/sales/bulk', authMiddleware, SaleController.createBulk);
// app.delete('/api/sales/:id', authMiddleware, SaleController.delete);

// --- LEGACY (RESTAURADO - Busca precio y descuenta inventario) ---
app.get('/api/sales', authMiddleware, async (req, res) => {
    try {
        const { fecha } = req.query;
        let query = 'SELECT v.*, r.nombre as receta_nombre FROM ventas v LEFT JOIN recetas r ON v.receta_id = r.id WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL';
        let params = [req.restauranteId];

        if (fecha) {
            query += ' AND DATE(v.fecha) = $2';
            params.push(fecha);
        }

        query += ' ORDER BY v.fecha DESC';
        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo ventas', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

app.post('/api/sales', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        // ⚡ Soportar ambos formatos: recetaId (camelCase) y receta_id (snake_case)
        const { recetaId: recetaIdCamel, receta_id, cantidad, varianteId: varianteIdCamel, variante_id, precioVariante, precio_unitario, fecha } = req.body;
        const recetaId = recetaIdCamel || receta_id;
        const varianteId = varianteIdCamel || variante_id;

        // Validar cantidad
        const cantidadValidada = validateCantidad(cantidad);
        if (cantidadValidada === 0) {
            return res.status(400).json({ error: 'Cantidad debe ser un número positivo' });
        }

        await client.query('BEGIN');

        const recetaResult = await client.query('SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2', [recetaId, req.restauranteId]);
        if (recetaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Receta no encontrada' });
        }

        const receta = recetaResult.rows[0];

        // ⚡ NUEVO: Si hay variante, obtener su precio y factor
        let precioUnitario = parseFloat(receta.precio_venta);
        let factorVariante = 1;

        if (varianteId) {
            const varianteResult = await client.query(
                'SELECT precio_venta, factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2',
                [varianteId, recetaId]
            );
            if (varianteResult.rows.length > 0) {
                const variante = varianteResult.rows[0];
                precioUnitario = parseFloat(variante.precio_venta);
                factorVariante = parseFloat(variante.factor) || 1;
                log('info', 'Venta con variante', { varianteId, precio: precioUnitario, factor: factorVariante });
            }
        } else if (precioVariante && precioVariante > 0) {
            // Fallback: usar precio enviado desde frontend
            precioUnitario = precioVariante;
        }

        const total = precioUnitario * cantidadValidada;

        const ingredientesReceta = receta.ingredientes || [];
        /* VALIDACIÓN DESACTIVADA - Permitir stock negativo (restaurantes venden antes de recibir mercancía)
        for (const ing of ingredientesReceta) {
            const stockResult = await client.query('SELECT stock_actual, nombre FROM ingredientes WHERE id = $1', [ing.ingredienteId]);
            if (stockResult.rows.length > 0) {
                const stockActual = parseFloat(stockResult.rows[0].stock_actual);
                const stockNecesario = ing.cantidad * cantidad;
                if (stockActual < stockNecesario) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        error: `Stock insuficiente de ${stockResult.rows[0].nombre}: necesitas ${stockNecesario}, tienes ${stockActual}`
                    });
                }
            }
        }
        */

        // 📅 Usar fecha proporcionada o NOW() por defecto
        const fechaVenta = fecha ? new Date(fecha) : new Date();

        const ventaResult = await client.query(
            'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [recetaId, cantidadValidada, precioUnitario, total, fechaVenta, req.restauranteId]
        );

        // ⚡ NUEVO: Aplicar factor de variante al descuento de stock
        // 🔧 FIX: Dividir por porciones - cada venta es 1 porción, no el lote completo
        const porciones = parseInt(receta.porciones) || 1;
        for (const ing of ingredientesReceta) {
            // 🔧 FIX: Soportar múltiples formatos de ID de ingrediente
            const ingId = ing.ingredienteId || ing.ingrediente_id || ing.ingredientId || ing.id;
            const ingCantidad = ing.cantidad || ing.quantity || 0;

            if (!ingId) {
                log('warn', 'Ingrediente sin ID en receta', { recetaId, ing });
                continue;
            }

            // SELECT FOR UPDATE para prevenir race condition en ventas simultáneas
            await client.query(
                'SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE',
                [ingId]
            );
            // Cantidad a descontar = (cantidad_receta ÷ porciones) × cantidad_vendida × factor_variante
            const cantidadADescontar = (ingCantidad / porciones) * cantidadValidada * factorVariante;
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2',
                [cantidadADescontar, ingId]
            );
            log('debug', 'Stock descontado', { ingredienteId: ingId, cantidad: cantidadADescontar });
        }

        await client.query('COMMIT');
        res.status(201).json(ventaResult.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error registrando venta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

app.delete('/api/sales/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener la venta antes de borrarla
        const ventaResult = await client.query(
            'SELECT * FROM ventas WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL',
            [req.params.id, req.restauranteId]
        );

        if (ventaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Venta no encontrada o ya eliminada' });
        }

        const venta = ventaResult.rows[0];

        // 2. Obtener la receta para saber qué ingredientes restaurar
        const recetaResult = await client.query(
            'SELECT * FROM recetas WHERE id = $1',
            [venta.receta_id]
        );

        if (recetaResult.rows.length > 0) {
            const receta = recetaResult.rows[0];
            const ingredientesReceta = receta.ingredientes || [];
            const porciones = parseInt(receta.porciones) || 1;

            // 3. Restaurar stock de cada ingrediente (inverso del descuento)
            for (const ing of ingredientesReceta) {
                if (ing.ingredienteId && ing.cantidad) {
                    // Cantidad a restaurar = (cantidad_receta ÷ porciones) × cantidad_vendida
                    const cantidadARestaurar = ((ing.cantidad || 0) / porciones) * venta.cantidad;

                    await client.query(
                        'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3',
                        [cantidadARestaurar, ing.ingredienteId, req.restauranteId]
                    );

                    log('info', 'Stock restaurado por eliminación de venta', {
                        ingredienteId: ing.ingredienteId,
                        cantidad: cantidadARestaurar,
                        ventaId: venta.id
                    });
                }
            }
        }

        // 4. SOFT DELETE: marca como eliminado
        await client.query(
            'UPDATE ventas SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1',
            [req.params.id]
        );

        await client.query('COMMIT');
        log('info', 'Venta eliminada con stock restaurado', { id: req.params.id });
        res.json({ message: 'Eliminado y stock restaurado', id: venta.id });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando venta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});


// ========== ENDPOINT: PARSEAR PDF DE TPV CON IA ==========
// Recibe un PDF del TPV y extrae los datos de ventas usando Claude API
app.post('/api/parse-pdf', authMiddleware, async (req, res) => {
    try {
        const { pdfBase64, filename } = req.body;

        if (!pdfBase64) {
            return res.status(400).json({ error: 'Se requiere pdfBase64' });
        }

        // API Key de Anthropic (configurar en variables de entorno)
        const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        if (!ANTHROPIC_API_KEY) {
            return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' });
        }

        log('info', 'Procesando PDF con Claude API', { filename, tamaño: pdfBase64.length });

        // Llamar a Claude API con el PDF
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 32000,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: 'application/pdf',
                                data: pdfBase64
                            }
                        },
                        {
                            type: 'text',
                            text: `Extrae las líneas de venta de este informe de TPV.

PRIMERO, extrae la FECHA del documento (busca "Fecha:" o "Desde:" en el encabezado).

Retorna ÚNICAMENTE JSON válido sin explicaciones:
{
  "fecha": "2026-01-12",
  "ventas": [
    {"codigo": "00117", "descripcion": "CAÑA", "unidades": 67, "importe": 201.00, "familia": "BEBIDAS"}
  ]
}

REGLAS:
- La fecha debe estar en formato YYYY-MM-DD
- Solo líneas con código numérico de 5-6 dígitos
- Ignora líneas de TOTAL
- El importe usa punto decimal`
                        }
                    ]
                }]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            log('error', 'Error de Claude API', errorData);
            return res.status(500).json({ error: 'Error procesando PDF con IA', details: errorData });
        }

        const claudeResponse = await response.json();
        let textContent = claudeResponse.content?.[0]?.text || '';

        // Limpiar respuesta de Claude (quitar markdown code blocks)
        textContent = textContent.replace(/```json/g, '').replace(/```/g, '').trim();

        // Extraer JSON
        const startIdx = textContent.indexOf('{');
        const endIdx = textContent.lastIndexOf('}');
        if (startIdx === -1 || endIdx === -1) {
            return res.status(500).json({ error: 'No se pudo extraer JSON de la respuesta de IA' });
        }

        const jsonStr = textContent.substring(startIdx, endIdx + 1);
        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (parseError) {
            log('error', 'Error parseando JSON de Claude', { error: parseError.message, rawText: textContent.substring(0, 500) });
            return res.status(500).json({ error: 'Error parseando respuesta de IA', details: parseError.message });
        }

        // Formatear para el frontend
        const fechaDocumento = data.fecha || new Date().toISOString().split('T')[0];
        const ventasFormateadas = (data.ventas || []).map(v => ({
            receta: v.descripcion,
            codigo_tpv: v.codigo,
            cantidad: parseInt(v.unidades) || 1,
            total: parseFloat(v.importe) || 0,
            fecha: fechaDocumento + 'T12:00:00.000Z'
        }));

        log('info', 'PDF procesado exitosamente', { fecha: fechaDocumento, ventas: ventasFormateadas.length });

        res.json({
            success: true,
            fecha: fechaDocumento,
            ventas: ventasFormateadas,
            totalVentas: ventasFormateadas.length,
            totalImporte: ventasFormateadas.reduce((sum, v) => sum + v.total, 0)
        });

    } catch (error) {
        log('error', 'Error procesando PDF', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Error procesando PDF', details: error.message });
    }
});

// Endpoint para carga masiva de ventas (n8n compatible)
app.post('/api/sales/bulk', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ventas } = req.body;

        if (!Array.isArray(ventas)) {
            return res.status(400).json({
                error: 'Formato inválido: se esperaba un array "ventas"',
                ejemplo: { ventas: [{ receta: "Nombre Plato", cantidad: 1 }] }
            });
        }

        // Obtener la fecha de las ventas (usar la primera venta o la fecha actual)
        const fechaVenta = ventas[0]?.fecha ? ventas[0].fecha.split('T')[0] : new Date().toISOString().split('T')[0];

        // Verificar si ya existen ventas para esta fecha
        const existingResult = await client.query(
            'SELECT COUNT(*) as count FROM ventas WHERE restaurante_id = $1 AND fecha::date = $2',
            [req.restauranteId, fechaVenta]
        );

        if (parseInt(existingResult.rows[0].count) > 0) {
            client.release();
            return res.status(409).json({
                error: 'Ya existen ventas para esta fecha',
                fecha: fechaVenta,
                mensaje: 'Para reemplazar los datos, primero elimine las ventas existentes de esta fecha',
                ventasExistentes: parseInt(existingResult.rows[0].count)
            });
        }

        await client.query('BEGIN');

        const resultados = {
            procesados: 0,
            fallidos: 0,
            errores: []
        };

        // Obtener recetas y precios de ingredientes
        // Incluir campo codigo para mapeo con códigos del TPV
        const recetasResult = await client.query('SELECT id, nombre, precio_venta, ingredientes, codigo FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL', [req.restauranteId]);

        // Mapa por nombre (para compatibilidad)
        const recetasMapNombre = new Map();
        // Mapa por código TPV (prioridad)
        const recetasMapCodigo = new Map();

        recetasResult.rows.forEach(r => {
            recetasMapNombre.set(r.nombre.toLowerCase().trim(), r);
            // Mapear por código TPV si existe
            if (r.codigo && r.codigo.trim() !== '' && r.codigo !== 'SIN_TPV') {
                recetasMapCodigo.set(r.codigo.trim(), r);
            }
        });

        // ⚡ NUEVO: También mapear códigos de variantes (COPA, BOTELLA, etc.)
        const variantesResult = await client.query(
            `SELECT rv.id as variante_id, rv.codigo, rv.factor, rv.nombre as variante_nombre, 
                    r.id as receta_id, r.nombre as receta_nombre, r.precio_venta, r.ingredientes
             FROM recetas_variantes rv
             JOIN recetas r ON rv.receta_id = r.id
             WHERE r.restaurante_id = $1 AND r.deleted_at IS NULL
             AND rv.codigo IS NOT NULL AND rv.codigo != ''`,
            [req.restauranteId]
        );

        // Mapa de código de variante -> {receta, variante_id, factor}
        const variantesMapCodigo = new Map();
        variantesResult.rows.forEach(v => {
            variantesMapCodigo.set(v.codigo.trim(), {
                id: v.receta_id,
                nombre: v.receta_nombre,
                precio_venta: v.precio_venta,
                ingredientes: v.ingredientes,
                variante_id: v.variante_id,
                variante_nombre: v.variante_nombre,
                factor: parseFloat(v.factor) || 1
            });
        });

        // CORREGIDO: Incluir cantidad_por_formato para calcular precio UNITARIO
        const ingredientesResult = await client.query('SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1', [req.restauranteId]);
        const ingredientesPrecios = new Map();
        ingredientesResult.rows.forEach(i => {
            const precio = parseFloat(i.precio) || 0;
            const cantidadPorFormato = parseFloat(i.cantidad_por_formato) || 1;
            // Precio unitario = precio del formato / cantidad en el formato
            const precioUnitario = precio / cantidadPorFormato;
            ingredientesPrecios.set(i.id, precioUnitario);
        });

        // Acumulador para resumen diario
        const resumenDiario = new Map(); // key: "recetaId-fecha", value: { cantidad, ingresos, coste }

        for (const venta of ventas) {
            const nombreReceta = (venta.receta || '').toLowerCase().trim();
            const codigoTpv = (venta.codigo_tpv || venta.codigo || '').toString().trim();
            const cantidad = validateCantidad(venta.cantidad);
            const varianteId = venta.variante_id || null; // ⚡ NUEVO: Soporte para variantes

            if (cantidad === 0) {
                resultados.fallidos++;
                resultados.errores.push({ receta: venta.receta, error: 'Cantidad inválida' });
                continue;
            }

            // Prioridad: buscar por código TPV, luego en variantes, luego por nombre
            let receta = null;
            let factorAplicado = 1;  // Factor por defecto
            let varianteEncontrada = null;

            if (codigoTpv && recetasMapCodigo.has(codigoTpv)) {
                receta = recetasMapCodigo.get(codigoTpv);
            } else if (codigoTpv && variantesMapCodigo.has(codigoTpv)) {
                // ⚡ Código encontrado en variantes (COPA, BOTELLA, etc.)
                varianteEncontrada = variantesMapCodigo.get(codigoTpv);
                receta = varianteEncontrada;  // Tiene los mismos campos que receta
                factorAplicado = varianteEncontrada.factor;
            } else if (nombreReceta && recetasMapNombre.has(nombreReceta)) {
                receta = recetasMapNombre.get(nombreReceta);
            }

            if (!receta) {
                resultados.fallidos++;
                resultados.errores.push({
                    receta: venta.receta,
                    codigo: codigoTpv || 'sin código',
                    error: 'Receta no encontrada'
                });
                continue;
            }

            // Si se pasó varianteId explícitamente, usarlo para obtener factor
            if (varianteId && !varianteEncontrada) {
                const varianteResult = await client.query(
                    'SELECT factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2',
                    [varianteId, receta.id]
                );
                if (varianteResult.rows.length > 0) {
                    factorAplicado = parseFloat(varianteResult.rows[0].factor) || 1;
                }
            }

            const precioVenta = parseFloat(receta.precio_venta);
            const total = parseFloat(venta.total) || (precioVenta * cantidad);
            const fecha = venta.fecha || new Date().toISOString();
            const fechaDate = fecha.split('T')[0]; // Solo la fecha sin hora

            // Calcular coste de ingredientes para esta venta (aplicando factor de variante)
            let costeIngredientes = 0;
            const ingredientesReceta = receta.ingredientes || [];
            if (Array.isArray(ingredientesReceta)) {
                for (const ing of ingredientesReceta) {
                    const precioIng = ingredientesPrecios.get(ing.ingredienteId) || 0;
                    costeIngredientes += precioIng * (ing.cantidad || 0) * cantidad * factorAplicado;
                }
            }

            // Registrar venta individual
            await client.query(
                'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [receta.id, cantidad, precioVenta, total, fecha, req.restauranteId]
            );

            // Descontar stock (aplicando factor de variante)
            // 🔧 FIX: Dividir por porciones - cada venta es 1 porción, no el lote completo
            const porciones = parseInt(receta.porciones) || 1;
            if (Array.isArray(ingredientesReceta) && ingredientesReceta.length > 0) {
                for (const ing of ingredientesReceta) {
                    // Cantidad a descontar = (cantidad_receta ÷ porciones) × cantidad_vendida × factor
                    const cantidadADescontar = ((ing.cantidad || 0) / porciones) * cantidad * factorAplicado;
                    if (cantidadADescontar > 0 && ing.ingredienteId) {
                        // SELECT FOR UPDATE para prevenir race condition en ventas simultáneas
                        await client.query(
                            'SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE',
                            [ing.ingredienteId]
                        );
                        // ⚡ NUEVO: Multiplicar por factorAplicado (copa = 0.2 de botella)
                        const updateResult = await client.query(
                            'UPDATE ingredientes SET stock_actual = stock_actual - $1, ultima_actualizacion_stock = NOW() WHERE id = $2 AND restaurante_id = $3 RETURNING id, nombre, stock_actual',
                            [cantidadADescontar, ing.ingredienteId, req.restauranteId]
                        );
                        if (updateResult.rows.length > 0) {
                            log('info', 'Stock descontado', {
                                ingrediente: updateResult.rows[0].nombre,
                                cantidad: cantidadADescontar,
                                nuevoStock: updateResult.rows[0].stock_actual
                            });
                        }
                    }
                }
            }

            // Acumular para resumen diario
            const key = `${receta.id}-${fechaDate}`;
            if (!resumenDiario.has(key)) {
                resumenDiario.set(key, {
                    recetaId: receta.id,
                    fecha: fechaDate,
                    precioVenta: precioVenta,
                    cantidad: 0,
                    ingresos: 0,
                    coste: 0
                });
            }
            const resumen = resumenDiario.get(key);
            resumen.cantidad += cantidad;
            resumen.ingresos += total;
            resumen.coste += costeIngredientes;

            resultados.procesados++;
        }

        // Actualizar tabla ventas_diarias_resumen (upsert)
        for (const [key, data] of resumenDiario) {
            await client.query(`
                INSERT INTO ventas_diarias_resumen 
                (receta_id, fecha, cantidad_vendida, precio_venta_unitario, coste_ingredientes, total_ingresos, beneficio_bruto, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (receta_id, fecha, restaurante_id)
                DO UPDATE SET 
                    cantidad_vendida = ventas_diarias_resumen.cantidad_vendida + EXCLUDED.cantidad_vendida,
                    coste_ingredientes = ventas_diarias_resumen.coste_ingredientes + EXCLUDED.coste_ingredientes,
                    total_ingresos = ventas_diarias_resumen.total_ingresos + EXCLUDED.total_ingresos,
                    beneficio_bruto = ventas_diarias_resumen.beneficio_bruto + EXCLUDED.beneficio_bruto
            `, [
                data.recetaId,
                data.fecha,
                data.cantidad,
                data.precioVenta,
                data.coste,
                data.ingresos,
                data.ingresos - data.coste,
                req.restauranteId
            ]);
        }

        await client.query('COMMIT');

        log('info', 'Carga masiva ventas', {
            procesados: resultados.procesados,
            fallidos: resultados.fallidos,
            resumenesActualizados: resumenDiario.size
        });

        res.json(resultados);
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error carga masiva ventas', { error: err.message });
        res.status(500).json({ error: 'Error interno procesando carga masiva' });
    } finally {
        client.release();
    }
});

// ========== EMPLEADOS (Staff Management) ==========

// GET all empleados
app.get('/api/empleados', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM empleados WHERE activo = true AND restaurante_id = $1 ORDER BY nombre',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo empleados', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST crear empleado
app.post('/api/empleados', authMiddleware, async (req, res) => {
    try {
        const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

        if (!nombre) {
            return res.status(400).json({ error: 'nombre es requerido' });
        }

        const result = await pool.query(
            `INSERT INTO empleados (nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [nombre, color || '#3B82F6', horas_contrato || 40, coste_hora || 10, dias_libres_fijos || '', puesto || 'Camarero', req.restauranteId]
        );

        log('info', 'Empleado creado', { nombre });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando empleado', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT actualizar empleado
app.put('/api/empleados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto } = req.body;

        const result = await pool.query(
            `UPDATE empleados SET nombre = COALESCE($1, nombre), color = COALESCE($2, color), 
             horas_contrato = COALESCE($3, horas_contrato), coste_hora = COALESCE($4, coste_hora),
             dias_libres_fijos = COALESCE($5, dias_libres_fijos), puesto = COALESCE($6, puesto)
             WHERE id = $7 AND restaurante_id = $8 RETURNING *`,
            [nombre, color, horas_contrato, coste_hora, dias_libres_fijos, puesto, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando empleado', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE empleado (soft delete)
app.delete('/api/empleados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'UPDATE empleados SET activo = false WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando empleado', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== HORARIOS (Staff Scheduling) ==========

// GET horarios por rango de fechas
app.get('/api/horarios', authMiddleware, async (req, res) => {
    try {
        const { desde, hasta } = req.query;

        if (!desde || !hasta) {
            return res.status(400).json({ error: 'desde y hasta son requeridos' });
        }

        const result = await pool.query(
            `SELECT h.*, e.nombre as empleado_nombre, e.color as empleado_color
             FROM horarios h
             JOIN empleados e ON h.empleado_id = e.id
             WHERE h.fecha BETWEEN $1 AND $2 AND h.restaurante_id = $3
             ORDER BY h.fecha, e.nombre`,
            [desde, hasta, req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo horarios', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST asignar turno
app.post('/api/horarios', authMiddleware, async (req, res) => {
    try {
        const { empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas } = req.body;

        if (!empleado_id || !fecha) {
            return res.status(400).json({ error: 'empleado_id y fecha son requeridos' });
        }

        const result = await pool.query(
            `INSERT INTO horarios (empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (empleado_id, fecha) DO UPDATE SET 
                turno = EXCLUDED.turno, hora_inicio = EXCLUDED.hora_inicio, 
                hora_fin = EXCLUDED.hora_fin, es_extra = EXCLUDED.es_extra, notas = EXCLUDED.notas
             RETURNING *`,
            [empleado_id, fecha, turno || 'completo', hora_inicio, hora_fin, es_extra || false, notas, req.restauranteId]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error asignando turno', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE quitar turno
app.delete('/api/horarios/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(
            'DELETE FROM horarios WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando turno', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE turno por empleado y fecha (para toggle)
app.delete('/api/horarios/empleado/:empleadoId/fecha/:fecha', authMiddleware, async (req, res) => {
    try {
        const { empleadoId, fecha } = req.params;
        await pool.query(
            'DELETE FROM horarios WHERE empleado_id = $1 AND fecha = $2 AND restaurante_id = $3',
            [empleadoId, fecha, req.restauranteId]
        );
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando turno', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE todos los horarios (borrado masivo)
app.delete('/api/horarios/all', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM horarios WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        log('info', 'Todos los horarios eliminados', { count: result.rowCount });
        res.json({ success: true, deleted: result.rowCount });
    } catch (err) {
        log('error', 'Error eliminando todos los horarios', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST copiar semana anterior
app.post('/api/horarios/copiar-semana', authMiddleware, async (req, res) => {
    try {
        const { semana_origen, semana_destino } = req.body;

        if (!semana_origen || !semana_destino) {
            return res.status(400).json({ error: 'semana_origen y semana_destino son requeridos' });
        }

        // Obtener horarios de la semana origen
        const horariosOrigen = await pool.query(
            `SELECT empleado_id, turno, hora_inicio, hora_fin, es_extra, notas,
                    fecha - $1::date as dia_offset
             FROM horarios 
             WHERE fecha BETWEEN $1 AND ($1::date + 6) AND restaurante_id = $2`,
            [semana_origen, req.restauranteId]
        );

        // Insertar en semana destino
        let insertados = 0;
        for (const h of horariosOrigen.rows) {
            const nuevaFecha = new Date(semana_destino);
            nuevaFecha.setDate(nuevaFecha.getDate() + h.dia_offset);

            await pool.query(
                `INSERT INTO horarios (empleado_id, fecha, turno, hora_inicio, hora_fin, es_extra, notas, restaurante_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (empleado_id, fecha) DO NOTHING`,
                [h.empleado_id, nuevaFecha.toISOString().split('T')[0], h.turno, h.hora_inicio, h.hora_fin, h.es_extra, h.notas, req.restauranteId]
            );
            insertados++;
        }

        log('info', 'Semana copiada', { origen: semana_origen, destino: semana_destino, turnos: insertados });
        res.json({ success: true, turnos_copiados: insertados });
    } catch (err) {
        log('error', 'Error copiando semana', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== GASTOS FIJOS (Fixed Expenses) ==========
// GET all gastos fijos
app.get('/api/gastos-fijos', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM gastos_fijos WHERE activo = true AND restaurante_id = $1 ORDER BY id',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'Error obteniendo gastos fijos', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST create gasto fijo
app.post('/api/gastos-fijos', authMiddleware, async (req, res) => {
    try {
        const { concepto, monto_mensual } = req.body;

        if (!concepto) {
            return res.status(400).json({ error: 'El concepto es requerido' });
        }

        const montoValidado = validatePrecio(monto_mensual);

        const result = await pool.query(
            'INSERT INTO gastos_fijos (concepto, monto_mensual, restaurante_id) VALUES ($1, $2, $3) RETURNING *',
            [concepto, montoValidado, req.restauranteId]
        );

        log('info', 'Gasto fijo creado', { id: result.rows[0].id, concepto });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando gasto fijo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT update gasto fijo
app.put('/api/gastos-fijos/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { concepto, monto_mensual } = req.body;

        const montoValidado = monto_mensual !== undefined ? validatePrecio(monto_mensual) : undefined;

        const result = await pool.query(
            'UPDATE gastos_fijos SET concepto = COALESCE($1, concepto), monto_mensual = COALESCE($2, monto_mensual), updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND restaurante_id = $4 RETURNING *',
            [concepto, montoValidado, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Gasto fijo no encontrado' });
        }

        log('info', 'Gasto fijo actualizado', { id, monto_mensual });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando gasto fijo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// DELETE gasto fijo (soft delete)
app.delete('/api/gastos-fijos/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query(
            'UPDATE gastos_fijos SET activo = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );

        log('info', 'Gasto fijo eliminado', { id });
        res.json({ message: 'Gasto fijo eliminado' });
    } catch (err) {
        log('error', 'Error eliminando gasto fijo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== BALANCE Y ESTADÍSTICAS ==========
app.get('/api/balance/mes', authMiddleware, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const mesActual = mes || new Date().getMonth() + 1;
        const anoActual = ano || new Date().getFullYear();

        const ventasMes = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
       FROM ventas
       WHERE EXTRACT(MONTH FROM fecha) = $1 AND EXTRACT(YEAR FROM fecha) = $2 AND restaurante_id = $3 AND deleted_at IS NULL`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasDetalle = await pool.query(
            `SELECT v.cantidad, r.ingredientes
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL`,
            [mesActual, anoActual, req.restauranteId]
        );

        // Precargar todos los precios de ingredientes en UNA query
        const ingredientesResult = await pool.query(
            'SELECT id, precio FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const preciosMap = new Map();
        ingredientesResult.rows.forEach(i => {
            preciosMap.set(i.id, parseFloat(i.precio) || 0);
        });

        // Calcular costos usando el Map (sin queries adicionales)
        let costos = 0;
        for (const venta of ventasDetalle.rows) {
            const ingredientes = venta.ingredientes || [];
            for (const ing of ingredientes) {
                const precio = preciosMap.get(ing.ingredienteId) || 0;
                costos += precio * (ing.cantidad || 0) * venta.cantidad;
            }
        }

        const ingresos = parseFloat(ventasMes.rows[0].ingresos) || 0;
        const ganancia = ingresos - costos;
        const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;

        const platoMasVendido = await pool.query(
            `SELECT r.nombre, SUM(v.cantidad) as total_vendido
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_vendido DESC
       LIMIT 1`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasPorPlato = await pool.query(
            `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
       GROUP BY r.nombre
       ORDER BY total_ingresos DESC`,
            [mesActual, anoActual, req.restauranteId]
        );

        const valorInventario = await pool.query(
            `SELECT COALESCE(SUM(stock_actual * precio), 0) as valor
       FROM ingredientes WHERE restaurante_id = $1`,
            [req.restauranteId]
        );

        res.json({
            ingresos,
            costos,
            ganancia,
            margen: parseFloat(margen),
            num_ventas: parseInt(ventasMes.rows[0].num_ventas) || 0,
            plato_mas_vendido: platoMasVendido.rows[0] || null,
            ventas_por_plato: ventasPorPlato.rows || [],
            valor_inventario: parseFloat(valorInventario.rows[0].valor) || 0
        });
    } catch (error) {
        log('error', 'Error obteniendo balance', { error: error.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.get('/api/balance/comparativa', authMiddleware, async (req, res) => {
    try {
        const meses = await pool.query(
            `SELECT 
         TO_CHAR(fecha, 'YYYY-MM') as mes,
         SUM(total) as ingresos,
         COUNT(*) as num_ventas
       FROM ventas
       WHERE restaurante_id = $1 AND deleted_at IS NULL
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`,
            [req.restauranteId]
        );
        res.json(meses.rows || []);
    } catch (error) {
        log('error', 'Error comparativa', { error: error.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// ========== TRACKING DIARIO DE COSTES/VENTAS ==========

// Obtener precios de compra diarios
app.get('/api/daily/purchases', authMiddleware, async (req, res) => {
    try {
        const { fecha, mes, ano } = req.query;
        let query = `
            SELECT p.*, i.nombre as ingrediente_nombre, i.unidad,
                   pr.nombre as proveedor_nombre
            FROM precios_compra_diarios p
            LEFT JOIN ingredientes i ON p.ingrediente_id = i.id
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            WHERE p.restaurante_id = $1
        `;
        let params = [req.restauranteId];

        if (fecha) {
            query += ' AND p.fecha = $2';
            params.push(fecha);
        } else if (mes && ano) {
            query += ' AND EXTRACT(MONTH FROM p.fecha) = $2 AND EXTRACT(YEAR FROM p.fecha) = $3';
            params.push(mes, ano);
        }

        query += ' ORDER BY p.fecha DESC, i.nombre';

        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo compras diarias', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// Registrar compras diarias (bulk - para n8n)
app.post('/api/daily/purchases/bulk', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { compras } = req.body;

        if (!Array.isArray(compras)) {
            return res.status(400).json({
                error: 'Formato inválido: se esperaba un array "compras"',
                ejemplo: { compras: [{ ingrediente: "Pulpo", precio: 26, cantidad: 10, fecha: "2025-12-17" }] }
            });
        }

        await client.query('BEGIN');

        const resultados = { procesados: 0, fallidos: 0, errores: [] };

        // Función para normalizar nombres (quitar acentos, mayúsculas, espacios extra)
        const normalizar = (str) => {
            return (str || '')
                .toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
                .replace(/[^a-z0-9\s]/g, '') // quitar caracteres especiales
                .replace(/\s+/g, ' ') // espacios múltiples a uno
                .trim();
        };

        // Obtener todos los ingredientes para búsqueda flexible (incluyendo cantidad_por_formato)
        const ingredientesResult = await client.query(
            'SELECT id, nombre, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const ingredientesMap = new Map();
        ingredientesResult.rows.forEach(i => {
            ingredientesMap.set(normalizar(i.nombre), { id: i.id, cantidadPorFormato: parseFloat(i.cantidad_por_formato) || 0 });
        });

        // Obtener todos los alias para búsqueda
        const aliasResult = await client.query(
            `SELECT a.alias, a.ingrediente_id, i.cantidad_por_formato 
             FROM ingredientes_alias a 
             JOIN ingredientes i ON a.ingrediente_id = i.id
             WHERE a.restaurante_id = $1`,
            [req.restauranteId]
        );
        const aliasMap = new Map();
        aliasResult.rows.forEach(a => {
            aliasMap.set(normalizar(a.alias), { id: a.ingrediente_id, cantidadPorFormato: parseFloat(a.cantidad_por_formato) || 0 });
        });

        for (const compra of compras) {
            const nombreNormalizado = normalizar(compra.ingrediente);
            let ingredienteData = ingredientesMap.get(nombreNormalizado);

            // Si no encuentra exacto, buscar coincidencia parcial
            if (!ingredienteData) {
                for (const [nombreDB, data] of ingredientesMap) {
                    if (nombreDB.includes(nombreNormalizado) || nombreNormalizado.includes(nombreDB)) {
                        ingredienteData = data;
                        break;
                    }
                }
            }

            // Si aún no encuentra, buscar en tabla de alias
            if (!ingredienteData) {
                ingredienteData = aliasMap.get(nombreNormalizado);
            }

            // Si aún no encuentra, buscar alias con coincidencia parcial
            if (!ingredienteData) {
                for (const [aliasNombre, data] of aliasMap) {
                    if (aliasNombre.includes(nombreNormalizado) || nombreNormalizado.includes(aliasNombre)) {
                        ingredienteData = data;
                        break;
                    }
                }
            }

            if (!ingredienteData) {
                resultados.fallidos++;
                resultados.errores.push({ ingrediente: compra.ingrediente, error: 'Ingrediente no encontrado' });
                continue;
            }

            const ingredienteId = ingredienteData.id;
            const cantidadPorFormato = ingredienteData.cantidadPorFormato;

            const precio = parseFloat(compra.precio) || 0;
            const cantidad = parseFloat(compra.cantidad) || 0;
            const total = precio * cantidad;
            const fecha = compra.fecha || new Date().toISOString().split('T')[0];

            // Upsert: actualizar si existe, insertar si no
            await client.query(`
                INSERT INTO precios_compra_diarios 
                (ingrediente_id, fecha, precio_unitario, cantidad_comprada, total_compra, restaurante_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (ingrediente_id, fecha, restaurante_id)
                DO UPDATE SET 
                    precio_unitario = EXCLUDED.precio_unitario,
                    cantidad_comprada = precios_compra_diarios.cantidad_comprada + EXCLUDED.cantidad_comprada,
                    total_compra = precios_compra_diarios.total_compra + EXCLUDED.total_compra
            `, [ingredienteId, fecha, precio, cantidad, total, req.restauranteId]);

            // Solo actualizar stock, NO el precio (el precio solo se cambia manualmente)
            // Si tiene cantidad_por_formato, multiplicar: cantidad × cantidad_por_formato
            const stockASumar = cantidadPorFormato > 0 ? cantidad * cantidadPorFormato : cantidad;
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual + $1, ultima_actualizacion_stock = NOW() WHERE id = $2',
                [stockASumar, ingredienteId]
            );

            resultados.procesados++;
        }

        await client.query('COMMIT');
        log('info', 'Compras diarias importadas', { procesados: resultados.procesados, fallidos: resultados.fallidos });
        res.json(resultados);
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error importando compras diarias', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// Obtener resumen diario de ventas
app.get('/api/daily/sales', authMiddleware, async (req, res) => {
    try {
        const { fecha, mes, ano } = req.query;
        let query = `
            SELECT v.*, r.nombre as receta_nombre, r.categoria
            FROM ventas_diarias_resumen v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1
        `;
        let params = [req.restauranteId];

        if (fecha) {
            query += ' AND v.fecha = $2';
            params.push(fecha);
        } else if (mes && ano) {
            query += ' AND EXTRACT(MONTH FROM v.fecha) = $2 AND EXTRACT(YEAR FROM v.fecha) = $3';
            params.push(mes, ano);
        }

        query += ' ORDER BY v.fecha DESC, r.nombre';

        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo ventas diarias', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// Resumen mensual completo (formato tipo Excel)
app.get('/api/monthly/summary', authMiddleware, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const mesActual = parseInt(mes) || new Date().getMonth() + 1;
        const anoActual = parseInt(ano) || new Date().getFullYear();

        // Obtener días del mes con compras
        const comprasDiarias = await pool.query(`
            SELECT 
                p.fecha,
                i.id as ingrediente_id,
                i.nombre as ingrediente,
                p.precio_unitario,
                p.cantidad_comprada,
                p.total_compra
            FROM precios_compra_diarios p
            JOIN ingredientes i ON p.ingrediente_id = i.id
            WHERE p.restaurante_id = $1
              AND EXTRACT(MONTH FROM p.fecha) = $2
              AND EXTRACT(YEAR FROM p.fecha) = $3
            ORDER BY p.fecha, i.nombre
        `, [req.restauranteId, mesActual, anoActual]);

        // Obtener ventas directamente de la tabla ventas (agrupadas por día y receta)
        const ventasDiarias = await pool.query(`
            SELECT 
                DATE(v.fecha) as fecha,
                r.id as receta_id,
                r.nombre as receta,
                r.ingredientes as receta_ingredientes,
                SUM(v.cantidad) as cantidad_vendida,
                AVG(v.precio_unitario) as precio_venta_unitario,
                SUM(v.total) as total_ingresos
            FROM ventas v
            JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
              AND EXTRACT(MONTH FROM v.fecha) = $2
              AND EXTRACT(YEAR FROM v.fecha) = $3
            GROUP BY DATE(v.fecha), r.id, r.nombre, r.ingredientes
            ORDER BY DATE(v.fecha), r.nombre
        `, [req.restauranteId, mesActual, anoActual]);

        // Obtener precios de todos los ingredientes para calcular costes
        // CORREGIDO: Incluir cantidad_por_formato para calcular precio UNITARIO
        const ingredientesPrecios = await pool.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const preciosMap = {};
        ingredientesPrecios.rows.forEach(ing => {
            const precio = parseFloat(ing.precio) || 0;
            const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;
            // Precio unitario = precio del formato / cantidad en el formato
            preciosMap[ing.id] = precio / cantidadPorFormato;
        });

        // Función para calcular coste de una receta
        const calcularCosteReceta = (ingredientesReceta) => {
            if (!ingredientesReceta || !Array.isArray(ingredientesReceta)) return 0;
            return ingredientesReceta.reduce((sum, item) => {
                const precio = preciosMap[item.ingredienteId] || 0;
                const cantidad = parseFloat(item.cantidad) || 0;
                return sum + (precio * cantidad);
            }, 0);
        };

        // Procesar datos en formato tipo Excel
        const ingredientesData = {};
        const recetasData = {};
        const diasSet = new Set();

        // Procesar compras
        comprasDiarias.rows.forEach(row => {
            const fechaStr = row.fecha.toISOString().split('T')[0];
            diasSet.add(fechaStr);

            if (!ingredientesData[row.ingrediente]) {
                ingredientesData[row.ingrediente] = { id: row.ingrediente_id, dias: {}, total: 0, totalCantidad: 0 };
            }

            ingredientesData[row.ingrediente].dias[fechaStr] = {
                precio: parseFloat(row.precio_unitario),
                cantidad: parseFloat(row.cantidad_comprada),
                total: parseFloat(row.total_compra)
            };
            ingredientesData[row.ingrediente].total += parseFloat(row.total_compra);
            ingredientesData[row.ingrediente].totalCantidad += parseFloat(row.cantidad_comprada);
        });

        // Procesar ventas CON CÁLCULO DE COSTES
        ventasDiarias.rows.forEach(row => {
            const fechaStr = row.fecha.toISOString().split('T')[0];
            diasSet.add(fechaStr);

            const cantidadVendida = parseInt(row.cantidad_vendida);
            const totalIngresos = parseFloat(row.total_ingresos);

            // Calcular coste real desde ingredientes de la receta
            const costePorUnidad = calcularCosteReceta(row.receta_ingredientes);
            const costeTotal = costePorUnidad * cantidadVendida;
            const beneficio = totalIngresos - costeTotal;

            if (!recetasData[row.receta]) {
                recetasData[row.receta] = { id: row.receta_id, dias: {}, totalVendidas: 0, totalIngresos: 0, totalCoste: 0, totalBeneficio: 0 };
            }

            recetasData[row.receta].dias[fechaStr] = {
                vendidas: cantidadVendida,
                precioVenta: parseFloat(row.precio_venta_unitario),
                coste: costeTotal,
                ingresos: totalIngresos,
                beneficio: beneficio
            };
            recetasData[row.receta].totalVendidas += cantidadVendida;
            recetasData[row.receta].totalIngresos += totalIngresos;
            recetasData[row.receta].totalCoste += costeTotal;
            recetasData[row.receta].totalBeneficio += beneficio;
        });

        // Ordenar días
        const dias = Array.from(diasSet).sort();

        // Calcular totales generales
        const totalesCompras = Object.values(ingredientesData).reduce((sum, i) => sum + i.total, 0);
        const totalesVentas = Object.values(recetasData).reduce((sum, r) => sum + r.totalIngresos, 0);
        const totalesCostes = Object.values(recetasData).reduce((sum, r) => sum + r.totalCoste, 0);
        const totalesBeneficio = Object.values(recetasData).reduce((sum, r) => sum + r.totalBeneficio, 0);

        res.json({
            mes: mesActual,
            ano: anoActual,
            dias,
            compras: {
                ingredientes: ingredientesData,
                total: totalesCompras
            },
            ventas: {
                recetas: recetasData,
                totalIngresos: totalesVentas,
                totalCostes: totalesCostes,
                beneficioBruto: totalesBeneficio
            },
            resumen: {
                margenBruto: totalesVentas > 0 ? ((totalesBeneficio / totalesVentas) * 100).toFixed(1) : 0,
                foodCost: totalesVentas > 0 ? ((totalesCostes / totalesVentas) * 100).toFixed(1) : 0
            }
        });
    } catch (err) {
        log('error', 'Error resumen mensual', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== 🧠 INTELIGENCIA - ENDPOINT FRESCURA ==========
// Días de vida útil por familia (estándares industria marisquería)
// NOTA: Marisco y pescado tienen valor alto porque llegan congelados
// La caducidad real empieza al cocer/descongelar, no al recibir
const VIDA_UTIL_DIAS = {
    'pescado': 7,    // Congelado: vida larga al llegar
    'marisco': 7,    // Congelado: vida larga al llegar  
    'carne': 4,
    'verdura': 5,
    'lacteo': 5,
    'bebida': 30,
    'alimento': 4,
    'default': 7
};

app.get('/api/intelligence/freshness', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            WITH compras_recientes AS (
                SELECT 
                    p.id as pedido_id,
                    p.fecha_recepcion,
                    CURRENT_DATE - p.fecha_recepcion::date as dias_desde_compra,
                    ing->>'ingredienteId' as ingrediente_id,
                    (ing->>'cantidad')::numeric as cantidad_comprada
                FROM pedidos p
                CROSS JOIN LATERAL jsonb_array_elements(p.ingredientes) AS ing
                WHERE p.restaurante_id = $1
                  AND p.estado = 'recibido'
                  AND p.fecha_recepcion IS NOT NULL
                  AND p.fecha_recepcion >= CURRENT_DATE - INTERVAL '7 days'
            )
            SELECT 
                i.id,
                i.nombre,
                i.familia,
                i.stock_actual,
                i.unidad,
                c.dias_desde_compra,
                c.fecha_recepcion
            FROM compras_recientes c
            JOIN ingredientes i ON i.id = c.ingrediente_id::int
            WHERE i.stock_actual > 0
            ORDER BY c.dias_desde_compra DESC
        `, [req.restauranteId]);

        // Solo productos frescos (carne, pescado, marisco)
        const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];

        const alertas = result.rows
            .filter(row => FAMILIAS_FRESCAS.includes((row.familia || '').toLowerCase()))
            .map(row => {
                const familia = (row.familia || 'default').toLowerCase();
                const vidaUtil = VIDA_UTIL_DIAS[familia] || VIDA_UTIL_DIAS['default'];
                const diasRestantes = vidaUtil - (row.dias_desde_compra || 0);

                return {
                    ...row,
                    vida_util: vidaUtil,
                    dias_restantes: diasRestantes,
                    urgencia: diasRestantes <= 0 ? 'critico' : diasRestantes === 1 ? 'hoy' : diasRestantes <= 2 ? 'mañana' : 'ok'
                };
            })
            .filter(a => a.dias_restantes <= 2);

        res.json(alertas);
    } catch (err) {
        log('error', 'Error en intelligence/freshness', { error: err.message });
        res.status(500).json({ error: 'Error interno', alertas: [] });
    }
});

// ========== 🧠 INTELIGENCIA - PLAN COMPRAS ==========
app.get('/api/intelligence/purchase-plan', authMiddleware, async (req, res) => {
    try {
        const targetDay = parseInt(req.query.day) || 6; // Sábado por defecto
        const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

        const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    ri.ingrediente_id,
                    SUM(ri.cantidad * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_distintos
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                CROSS JOIN LATERAL (
                    SELECT 
                        (ri_json->>'ingredienteId')::int as ingrediente_id,
                        (ri_json->>'cantidad')::numeric as cantidad
                ) ri
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                GROUP BY EXTRACT(DOW FROM v.fecha), ri.ingrediente_id
            )
            SELECT 
                i.id,
                i.nombre,
                i.familia,
                i.stock_actual,
                i.unidad,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) as consumo_promedio,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2 as par_level,
                i.stock_actual - (COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2) as diferencia
            FROM ingredientes i
            LEFT JOIN consumo_por_dia c ON c.ingrediente_id = i.id AND c.dia_semana = $2
            WHERE i.restaurante_id = $1
              AND c.consumo_total > 0
            ORDER BY diferencia ASC
        `, [req.restauranteId, targetDay]);

        const sugerencias = result.rows
            .filter(r => parseFloat(r.diferencia) < 0)
            .map(r => ({
                ...r,
                sugerencia_pedido: Math.abs(parseFloat(r.diferencia))
            }));

        res.json({
            dia_objetivo: DIAS[targetDay],
            sugerencias
        });
    } catch (err) {
        log('error', 'Error en intelligence/purchase-plan', { error: err.message });
        res.status(500).json({ error: 'Error interno', sugerencias: [] });
    }
});

// ========== 🧠 INTELIGENCIA - SOBRESTOCK ==========
// Festivos Galicia 2026 - tratar como sábados
const FESTIVOS_GALICIA = [
    '2026-01-01', '2026-01-06', '2026-04-09', '2026-04-10',
    '2026-05-01', '2026-05-17', '2026-07-25', '2026-08-15',
    '2026-10-12', '2026-11-01', '2026-12-06', '2026-12-08', '2026-12-25'
];

app.get('/api/intelligence/overstock', authMiddleware, async (req, res) => {
    try {
        // Calcular día efectivo (festivos = sábado)
        const hoy = new Date().toISOString().split('T')[0];
        const esFestivo = FESTIVOS_GALICIA.includes(hoy);
        const diaActual = esFestivo ? 6 : new Date().getDay();

        const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    ri.ingrediente_id,
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    SUM(ri.cantidad * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_contados
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                CROSS JOIN LATERAL (
                    SELECT 
                        (ri_json->>'ingredienteId')::int as ingrediente_id,
                        (ri_json->>'cantidad')::numeric as cantidad
                ) ri
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                GROUP BY ri.ingrediente_id, EXTRACT(DOW FROM v.fecha)
            ),
            consumo_dia_actual AS (
                SELECT 
                    ingrediente_id,
                    consumo_total / NULLIF(dias_contados, 0) as consumo_dia
                FROM consumo_por_dia
                WHERE dia_semana = $2
            )
            SELECT 
                i.id, i.nombre, i.familia, i.stock_actual, i.unidad,
                COALESCE(c.consumo_dia, 0) as consumo_diario,
                CASE WHEN COALESCE(c.consumo_dia, 0) > 0 
                    THEN i.stock_actual / c.consumo_dia ELSE 999 END as dias_stock
            FROM ingredientes i
            LEFT JOIN consumo_dia_actual c ON c.ingrediente_id = i.id
            WHERE i.restaurante_id = $1 AND i.stock_actual > 0
              AND COALESCE(c.consumo_dia, 0) > 0
            ORDER BY dias_stock DESC
        `, [req.restauranteId, diaActual]);

        const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];
        const UMBRAL_DIAS = { 'marisco': 3, 'pescado': 3, 'carne': 5, 'default': 7 };

        const sobrestock = result.rows
            .filter(r => FAMILIAS_FRESCAS.includes(r.familia?.toLowerCase()))
            .filter(r => {
                const umbral = UMBRAL_DIAS[r.familia?.toLowerCase()] || UMBRAL_DIAS['default'];
                return parseFloat(r.dias_stock) > umbral;
            });

        res.json(sobrestock);
    } catch (err) {
        log('error', 'Error en intelligence/overstock', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== 🧠 INTELIGENCIA - REVISION PRECIOS ==========
app.get('/api/intelligence/price-check', authMiddleware, async (req, res) => {
    try {
        const TARGET_FOOD_COST = 35;
        const ALERT_THRESHOLD = 40;

        const result = await pool.query(`
            SELECT 
                r.id,
                r.nombre,
                r.precio_venta,
                r.ingredientes
            FROM recetas r
            WHERE r.restaurante_id = $1
              AND r.precio_venta > 0
        `, [req.restauranteId]);

        const ingredientes = await pool.query(`
            SELECT id, nombre, precio, cantidad_por_formato
            FROM ingredientes 
            WHERE restaurante_id = $1
        `, [req.restauranteId]);

        const ingMap = {};
        ingredientes.rows.forEach(i => {
            const precioUnitario = i.cantidad_por_formato > 0
                ? parseFloat(i.precio) / i.cantidad_por_formato
                : parseFloat(i.precio);
            ingMap[i.id] = precioUnitario;
        });

        const recetasProblema = result.rows
            .map(r => {
                let coste = 0;
                if (r.ingredientes && Array.isArray(r.ingredientes)) {
                    r.ingredientes.forEach(ing => {
                        const precioIng = ingMap[ing.ingredienteId] || 0;
                        coste += precioIng * (ing.cantidad || 0);
                    });
                }
                const precioVenta = parseFloat(r.precio_venta) || 0;
                const foodCost = precioVenta > 0 ? (coste / precioVenta) * 100 : 0;
                const precioSugerido = coste / (TARGET_FOOD_COST / 100);

                return {
                    id: r.id,
                    nombre: r.nombre,
                    coste,
                    precio_actual: precioVenta,
                    food_cost: Math.round(foodCost),
                    precio_sugerido: precioSugerido
                };
            })
            .filter(r => r.food_cost > ALERT_THRESHOLD);

        res.json({
            objetivo: TARGET_FOOD_COST,
            umbral_alerta: ALERT_THRESHOLD,
            recetas_problema: recetasProblema
        });
    } catch (err) {
        log('error', 'Error en intelligence/price-check', { error: err.message });
        res.status(500).json({ error: 'Error interno', recetas_problema: [] });
    }
});

// ========== 🗑️ MERMAS - REGISTRO ==========
app.post('/api/mermas', authMiddleware, async (req, res) => {
    try {
        const { mermas } = req.body;
        log('info', 'Recibiendo mermas', {
            count: mermas?.length,
            restauranteId: req.restauranteId,
            body: JSON.stringify(mermas).substring(0, 500)
        });

        if (!mermas || !Array.isArray(mermas)) {
            return res.status(400).json({ error: 'Se requiere array de mermas' });
        }

        let insertados = 0;
        for (const m of mermas) {
            try {
                // Validar que ingredienteId existe o usar NULL
                const ingredienteId = m.ingredienteId ? parseInt(m.ingredienteId) : null;

                // Calcular periodo_id como YYYYMM (ej: 202601 para enero 2026)
                const now = new Date();
                const periodoId = now.getFullYear() * 100 + (now.getMonth() + 1);

                await pool.query(`
                    INSERT INTO mermas 
                    (ingrediente_id, ingrediente_nombre, cantidad, unidad, valor_perdida, motivo, nota, responsable_id, restaurante_id, periodo_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    ingredienteId,
                    m.ingredienteNombre || 'Sin nombre',
                    parseFloat(m.cantidad) || 0,
                    m.unidad || 'ud',
                    parseFloat(m.valorPerdida) || 0,
                    m.motivo || 'Otros',
                    m.nota || '',
                    m.responsableId ? parseInt(m.responsableId) : null,
                    req.restauranteId,
                    periodoId
                ]);

                // NOTA: El frontend ya descuenta el stock antes de llamar este endpoint
                // NO descontar aquí para evitar doble descuento

                insertados++;
            } catch (insertErr) {
                log('error', 'Error insertando merma individual', {
                    merma: JSON.stringify(m),
                    error: insertErr.message,
                    stack: insertErr.stack
                });
                // Continuar con las demás mermas
            }
        }

        log('info', `Registradas ${insertados}/${mermas.length} mermas`, { restauranteId: req.restauranteId });
        res.json({ success: true, count: insertados });
    } catch (err) {
        log('error', 'Error registrando mermas', {
            error: err.message,
            stack: err.stack,
            body: JSON.stringify(req.body).substring(0, 1000)
        });
        res.status(500).json({ error: 'Error interno: ' + err.message });
    }
});

// ========== 🧠 INTELIGENCIA - MERMAS ==========
app.get('/api/intelligence/waste-stats', authMiddleware, async (req, res) => {
    try {
        // Total mermas este mes
        const mesActual = await pool.query(`
            SELECT 
                COALESCE(SUM(valor_perdida), 0) as total_perdida,
                COUNT(*) as total_registros
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `, [req.restauranteId]);

        // Top 5 productos más tirados
        const topProductos = await pool.query(`
            SELECT 
                ingrediente_nombre as nombre,
                SUM(cantidad) as cantidad_total,
                SUM(valor_perdida) as perdida_total,
                COUNT(*) as veces
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
            GROUP BY ingrediente_nombre
            ORDER BY perdida_total DESC
            LIMIT 5
        `, [req.restauranteId]);

        // Comparación con mes anterior
        const mesAnterior = await pool.query(`
            SELECT COALESCE(SUM(valor_perdida), 0) as total_perdida
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
              AND fecha < DATE_TRUNC('month', CURRENT_DATE)
        `, [req.restauranteId]);

        const totalActual = parseFloat(mesActual.rows[0]?.total_perdida || 0);
        const totalAnterior = parseFloat(mesAnterior.rows[0]?.total_perdida || 0);
        const variacion = totalAnterior > 0 ? ((totalActual - totalAnterior) / totalAnterior) * 100 : 0;

        res.json({
            mes_actual: {
                total_perdida: totalActual,
                registros: parseInt(mesActual.rows[0]?.total_registros || 0)
            },
            top_productos: topProductos.rows,
            comparacion: {
                mes_anterior: totalAnterior,
                variacion: Math.round(variacion)
            }
        });
    } catch (err) {
        log('error', 'Error en intelligence/waste-stats', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== 🗑️ MERMAS - LISTAR HISTORIAL ==========
app.get('/api/mermas', authMiddleware, async (req, res) => {
    try {
        const { mes, ano, limite } = req.query;
        const mesActual = parseInt(mes) || new Date().getMonth() + 1;
        const anoActual = parseInt(ano) || new Date().getFullYear();
        const lim = parseInt(limite) || 100;

        log('info', 'GET /api/mermas - Buscando mermas', {
            restauranteId: req.restauranteId,
            mes: mesActual,
            ano: anoActual,
            limite: lim,
            queryParams: req.query
        });

        // Primero, contar TODAS las mermas del restaurante sin filtro de fecha
        const countAll = await pool.query(`
            SELECT COUNT(*) as total FROM mermas WHERE restaurante_id = $1
        `, [req.restauranteId]);

        log('info', `Total mermas en BD para restaurante ${req.restauranteId}: ${countAll.rows[0].total}`);

        // DEBUG: Obtener la última merma para ver qué fecha tiene
        if (parseInt(countAll.rows[0].total) > 0) {
            const ultimaMerma = await pool.query(`
                SELECT id, fecha, EXTRACT(MONTH FROM fecha) as mes_db, EXTRACT(YEAR FROM fecha) as ano_db
                FROM mermas 
                WHERE restaurante_id = $1
                ORDER BY id DESC LIMIT 1
            `, [req.restauranteId]);

            if (ultimaMerma.rows.length > 0) {
                log('info', 'DEBUG - Última merma en BD', {
                    id: ultimaMerma.rows[0].id,
                    fecha: ultimaMerma.rows[0].fecha,
                    mes_en_db: ultimaMerma.rows[0].mes_db,
                    ano_en_db: ultimaMerma.rows[0].ano_db,
                    mes_buscado: mesActual,
                    ano_buscado: anoActual
                });
            }
        }

        // DEBUG TEMPORAL: Quitar TODOS los filtros para confirmar que hay datos
        log('info', `DEBUG - req.restauranteId value: ${req.restauranteId} (type: ${typeof req.restauranteId})`);

        const result = await pool.query(`
            SELECT 
                m.id,
                m.ingrediente_id,
                m.ingrediente_nombre,
                m.cantidad,
                m.unidad,
                m.valor_perdida,
                m.motivo,
                m.nota,
                m.fecha,
                m.restaurante_id,
                i.nombre as ingrediente_actual
            FROM mermas m
            LEFT JOIN ingredientes i ON m.ingrediente_id = i.id
            ORDER BY m.fecha DESC, m.id DESC
            LIMIT $1
        `, [lim]);

        log('info', `GET /api/mermas - Encontradas ${result.rows.length} mermas (SIN NINGUN FILTRO)`, {
            reqRestauranteId: req.restauranteId,
            totalSinFiltro: countAll.rows[0].total,
            resultados: result.rows.length,
            primerasMermas: result.rows.slice(0, 2).map(r => ({ id: r.id, restaurante_id: r.restaurante_id }))
        });

        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error listando mermas', { error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

// ========== 🗑️ MERMAS - RESUMEN MENSUAL ==========
app.get('/api/mermas/resumen', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COALESCE(SUM(valor_perdida), 0) as total_perdida,
                COUNT(DISTINCT ingrediente_id) as total_productos,
                COUNT(*) as total_registros
            FROM mermas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
        `, [req.restauranteId]);

        const data = result.rows[0] || {};
        res.json({
            totalPerdida: parseFloat(data.total_perdida || 0),
            totalProductos: parseInt(data.total_productos || 0),
            totalRegistros: parseInt(data.total_registros || 0)
        });
    } catch (err) {
        log('error', 'Error en mermas/resumen', { error: err.message });
        res.status(500).json({
            totalPerdida: 0,
            totalProductos: 0,
            totalRegistros: 0
        });
    }
});

// ========== 🗑️ MERMAS - BORRAR INDIVIDUAL ==========
app.delete('/api/mermas/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener la merma antes de borrarla
        const mermaResult = await client.query(
            'SELECT * FROM mermas WHERE id = $1 AND restaurante_id = $2',
            [req.params.id, req.restauranteId]
        );

        if (mermaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Merma no encontrada' });
        }

        const merma = mermaResult.rows[0];

        // 2. Restaurar stock del ingrediente (sumar la cantidad que se había restado)
        if (merma.ingrediente_id && merma.cantidad > 0) {
            await client.query(
                `UPDATE ingredientes 
                 SET stock_actual = stock_actual + $1, 
                     ultima_actualizacion_stock = NOW() 
                 WHERE id = $2 AND restaurante_id = $3`,
                [parseFloat(merma.cantidad), merma.ingrediente_id, req.restauranteId]
            );
            log('info', 'Stock restaurado por eliminación de merma', {
                ingredienteId: merma.ingrediente_id,
                cantidad: merma.cantidad
            });
        }

        // 3. Borrar la merma
        await client.query(
            'DELETE FROM mermas WHERE id = $1',
            [req.params.id]
        );

        await client.query('COMMIT');
        log('info', 'Merma eliminada', { id: req.params.id, ingrediente: merma.ingrediente_nombre });
        res.json({ success: true, message: 'Merma eliminada y stock restaurado' });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando merma', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// ========== 🗑️ MERMAS - RESET MENSUAL ==========
app.delete('/api/mermas/reset', authMiddleware, async (req, res) => {
    try {
        const { motivo } = req.body || {};

        // Archivar mermas actuales antes de borrarlas (opcional: crear tabla de archivo)
        const deleted = await pool.query(`
            DELETE FROM mermas 
            WHERE restaurante_id = $1 
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE)
            RETURNING *
        `, [req.restauranteId]);

        log('info', `Reset mermas: ${deleted.rowCount} registros eliminados`, {
            restauranteId: req.restauranteId,
            motivo: motivo || 'manual'
        });

        res.json({
            success: true,
            eliminados: deleted.rowCount,
            motivo: motivo || 'manual'
        });
    } catch (err) {
        log('error', 'Error en mermas/reset', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== HEALTH CHECK ENDPOINT (READ ONLY) ==========
app.get('/api/system/health-check', authMiddleware, async (req, res) => {
    try {
        const restauranteId = req.restauranteId;
        const results = {};

        // 1. Conexión DB
        try {
            await pool.query('SELECT 1');
            results.database = { ok: true, message: 'Conexión OK' };
        } catch (err) {
            results.database = { ok: false, message: err.message };
        }

        // 2. Recetas sin ingredientes
        const recetasSinIng = await pool.query(`
            SELECT id, nombre FROM recetas 
            WHERE restaurante_id = $1 AND deleted_at IS NULL
            AND (ingredientes IS NULL OR ingredientes::text = '[]')
        `, [restauranteId]);
        results.recetasSinIngredientes = {
            ok: recetasSinIng.rows.length === 0,
            count: recetasSinIng.rows.length,
            items: recetasSinIng.rows.slice(0, 10)
        };

        // 3. Stock negativo
        const stockNegativo = await pool.query(`
            SELECT id, nombre, stock_actual, unidad FROM ingredientes 
            WHERE restaurante_id = $1 AND stock_actual < 0
            ORDER BY stock_actual LIMIT 10
        `, [restauranteId]);
        results.stockNegativo = {
            ok: stockNegativo.rows.length === 0,
            count: stockNegativo.rows.length,
            items: stockNegativo.rows
        };

        // 4. Vinos sin ingrediente
        const vinosSinIng = await pool.query(`
            SELECT id, nombre FROM recetas 
            WHERE restaurante_id = $1 AND deleted_at IS NULL
            AND nombre ILIKE '%vino%'
            AND (ingredientes IS NULL OR ingredientes::text = '[]')
        `, [restauranteId]);
        results.vinosSinIngrediente = {
            ok: vinosSinIng.rows.length === 0,
            count: vinosSinIng.rows.length,
            items: vinosSinIng.rows
        };

        // 5. Valor Stock
        const valorStock = await pool.query(`
            SELECT 
                SUM(stock_actual * (precio / COALESCE(NULLIF(cantidad_por_formato, 0), 1))) as valor,
                COUNT(*) as items
            FROM ingredientes WHERE restaurante_id = $1 AND stock_actual > 0
        `, [restauranteId]);
        results.valorStock = {
            valor: parseFloat(valorStock.rows[0].valor) || 0,
            items: parseInt(valorStock.rows[0].items) || 0
        };

        // 6. Ventas hoy
        const today = new Date().toISOString().split('T')[0];
        const ventasHoy = await pool.query(`
            SELECT COUNT(*) as num, COALESCE(SUM(total), 0) as total
            FROM ventas WHERE restaurante_id = $1 AND fecha::date = $2 AND deleted_at IS NULL
        `, [restauranteId, today]);
        results.ventasHoy = {
            fecha: today,
            num_ventas: parseInt(ventasHoy.rows[0].num),
            total: parseFloat(ventasHoy.rows[0].total)
        };

        // Resumen
        const allOk = results.database.ok &&
            results.recetasSinIngredientes.ok &&
            results.stockNegativo.ok &&
            results.vinosSinIngrediente.ok;

        res.json({
            status: allOk ? 'healthy' : 'issues_detected',
            timestamp: new Date().toISOString(),
            restauranteId,
            checks: results
        });
    } catch (err) {
        log('error', 'Error en health-check', { error: err.message });
        res.status(500).json({ error: 'Error ejecutando health check', message: err.message });
    }
});

// ========== 404 ==========
app.use((req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        path: req.originalUrl,
        method: req.method
    });
});



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
    log('info', 'Servidor iniciado', { port: PORT, version: '2.3.0', cors: ALLOWED_ORIGINS });
    console.log(`🚀 API corriendo en puerto ${PORT}`);
    console.log(`📍 La Caleta 102 Dashboard API v3.0-INTEL (con arquitectura limpia v2)`);
    console.log(`✅ CORS habilitado para: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`📦 Rutas v2 montadas: /api/v2/recipes`);

    // ========== UPTIME KUMA HEARTBEAT ==========
    // Heartbeat verifica BD antes de reportar healthy
    const UPTIME_KUMA_PUSH_URL = 'https://uptime.mindloop.cloud/api/push/nw9yvLKJzf';

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
});
// rebuild Sun Jan  4 01:51:53 CET 2026
