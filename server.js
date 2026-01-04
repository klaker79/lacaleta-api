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

// ========== RESEND (Email) ==========
const resend = new Resend(process.env.RESEND_API_KEY || 're_8hWi8wSn_Px7T4JymbKP7s7mR4y3ioILc');

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

    // Permitir requests sin origin (curl, Postman, healthchecks)
    if (!origin || origin === '') {
        res.header('Access-Control-Allow-Origin', '*');
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
    max: 10, // 10 intentos de login
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
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        proveedor_id INTEGER NOT NULL,
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
            { expiresIn: '24h' }
        );

        log('info', 'Login exitoso', { userId: user.id, email });

        // Establecer token en httpOnly cookie (seguro para navegadores)
        const isProduction = process.env.NODE_ENV === 'production';
        res.cookie('auth_token', token, {
            httpOnly: true,           // No accesible desde JavaScript
            secure: isProduction,     // Solo HTTPS en producción
            sameSite: 'lax',          // Protección CSRF (lax permite navegación normal)
            maxAge: 24 * 60 * 60 * 1000, // 24 horas
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

// Código de invitación válido
const INVITATION_CODE = process.env.INVITATION_CODE || 'MINDLOOP2024';

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
            { expiresIn: '24h' }
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
            JWT_SECRET, { expiresIn: '24h' }
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

app.post('/api/ingredients', authMiddleware, async (req, res) => {
    try {
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia, formato_compra, cantidad_por_formato } = req.body;

        // Validación numérica segura (previene NaN, valores negativos)
        const finalPrecio = validatePrecio(precio);
        const finalStockActual = validateCantidad(stockActual ?? stock_actual);
        const finalStockMinimo = validateCantidad(stockMinimo ?? stock_minimo);
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const finalFamilia = familia || 'alimento';
        const finalFormatoCompra = formato_compra || null;
        const finalCantidadPorFormato = cantidad_por_formato ? validateCantidad(cantidad_por_formato) : null;

        const result = await pool.query(
            'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, familia, restaurante_id, formato_compra, cantidad_por_formato) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [nombre, finalProveedorId, finalPrecio, unidad || 'kg', finalStockActual, finalStockMinimo, finalFamilia, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato]
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
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia, formato_compra, cantidad_por_formato } = req.body;

        // Validación numérica segura (previene NaN, valores negativos)
        const finalPrecio = validatePrecio(precio);
        const finalStockActual = validateCantidad(stockActual ?? stock_actual);
        const finalStockMinimo = validateCantidad(stockMinimo ?? stock_minimo);
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const finalFamilia = familia || 'alimento';
        const finalFormatoCompra = formato_compra || null;
        const finalCantidadPorFormato = cantidad_por_formato ? validateCantidad(cantidad_por_formato) : null;

        const result = await pool.query(
            'UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, stock_actual=$5, stock_minimo=$6, familia=$7, formato_compra=$10, cantidad_por_formato=$11 WHERE id=$8 AND restaurante_id=$9 RETURNING *',
            [nombre, finalProveedorId, finalPrecio, unidad, finalStockActual, finalStockMinimo, finalFamilia, id, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        log('error', 'Error actualizando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/ingredients/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM ingredientes WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        log('error', 'Error eliminando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
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
        CASE 
            WHEN i.stock_real IS NULL THEN NULL 
            ELSE (i.stock_real - i.stock_actual) 
        END as diferencia,
        COALESCE(
          (SELECT 
            SUM(
              (ingrediente->>'cantidad')::numeric *
              COALESCE((ingrediente->>'precioReal')::numeric, (ingrediente->>'precioUnitario')::numeric)
            ) / NULLIF(SUM((ingrediente->>'cantidad')::numeric), 0)
           FROM pedidos p, 
           jsonb_array_elements(p.ingredientes) as ingrediente
           WHERE (ingrediente->>'ingredienteId')::integer = i.id 
           AND p.estado = 'recibido'
           AND p.restaurante_id = $1
          ), i.precio
        ) as precio_medio,
        (i.stock_actual * COALESCE(
          (SELECT 
            SUM(
              (ingrediente->>'cantidad')::numeric *
              COALESCE((ingrediente->>'precioReal')::numeric, (ingrediente->>'precioUnitario')::numeric)
            ) / NULLIF(SUM((ingrediente->>'cantidad')::numeric), 0)
           FROM pedidos p, 
           jsonb_array_elements(p.ingredientes) as ingrediente
           WHERE (ingrediente->>'ingredienteId')::integer = i.id 
           AND p.estado = 'recibido'
           AND p.restaurante_id = $1
          ), i.precio
        )) as valor_stock
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
        const ingredientesResult = await pool.query(
            'SELECT id, precio FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const preciosMap = new Map();
        ingredientesResult.rows.forEach(ing => {
            preciosMap.set(ing.id, parseFloat(ing.precio) || 0);
        });

        const analisis = [];
        const totalVentasRestaurante = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
        const promedioPopularidad = totalVentasRestaurante / ventas.rows.length;
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
                popularidad: parseFloat(plato.cantidad_vendida)
            });
        }

        const promedioMargen = totalVentasRestaurante > 0 ? sumaMargenes / totalVentasRestaurante : 0;

        const resultado = analisis.map(p => {
            const esPopular = p.popularidad >= (promedioPopularidad * 0.7);
            const esRentable = p.margen >= promedioMargen;

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
                    promedioPopularidad,
                    promedioMargen
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
        const { nombre, categoria, precio_venta, porciones, ingredientes } = req.body;
        const result = await pool.query(
            'INSERT INTO recetas (nombre, categoria, precio_venta, porciones, ingredientes, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [nombre, categoria || 'principal', precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), req.restauranteId]
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
        const { nombre, categoria, precio_venta, porciones, ingredientes } = req.body;
        const result = await pool.query(
            'UPDATE recetas SET nombre=$1, categoria=$2, precio_venta=$3, porciones=$4, ingredientes=$5 WHERE id=$6 AND restaurante_id=$7 RETURNING *',
            [nombre, categoria, precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), id, req.restauranteId]
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
app.get('/api/suppliers', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM proveedores WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY id', [req.restauranteId]);
        res.json(result.rows || []);
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
        const { estado, ingredientes, totalRecibido, fechaRecepcion } = req.body;

        await client.query('BEGIN');

        const result = await client.query(
            'UPDATE pedidos SET estado=$1, ingredientes=$2, total_recibido=$3, fecha_recepcion=$4 WHERE id=$5 AND restaurante_id=$6 RETURNING *',
            [estado, JSON.stringify(ingredientes), totalRecibido, fechaRecepcion || new Date(), id, req.restauranteId]
        );

        // Si el pedido se marca como recibido, registrar los precios de compra diarios
        if (estado === 'recibido' && ingredientes && Array.isArray(ingredientes)) {
            const fechaCompra = fechaRecepcion ? new Date(fechaRecepcion) : new Date();

            for (const item of ingredientes) {
                const precioReal = parseFloat(item.precioReal || item.precioUnitario) || 0;
                const cantidad = parseFloat(item.cantidad) || 0;
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
    try {
        // SOFT DELETE: marca como eliminado sin borrar datos
        const result = await pool.query(
            'UPDATE pedidos SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING *',
            [req.params.id, req.restauranteId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pedido no encontrado o ya eliminado' });
        }
        log('info', 'Pedido soft deleted', { id: req.params.id });
        res.json({ message: 'Eliminado', id: result.rows[0].id });
    } catch (err) {
        log('error', 'Error eliminando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== VENTAS ==========
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
        const { recetaId, cantidad } = req.body;

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
        const precioUnitario = parseFloat(receta.precio_venta);
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

        const ventaResult = await client.query(
            'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, restaurante_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [recetaId, cantidadValidada, precioUnitario, total, req.restauranteId]
        );

        for (const ing of ingredientesReceta) {
            // SELECT FOR UPDATE para prevenir race condition en ventas simultáneas
            await client.query(
                'SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE',
                [ing.ingredienteId]
            );
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2',
                [ing.cantidad * cantidadValidada, ing.ingredienteId]
            );
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
    try {
        // SOFT DELETE: marca como eliminado sin borrar datos
        const result = await pool.query(
            'UPDATE ventas SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING *',
            [req.params.id, req.restauranteId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Venta no encontrada o ya eliminada' });
        }
        log('info', 'Venta soft deleted', { id: req.params.id });
        res.json({ message: 'Eliminado', id: result.rows[0].id });
    } catch (err) {
        log('error', 'Error eliminando venta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
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

        const ingredientesResult = await client.query('SELECT id, precio FROM ingredientes WHERE restaurante_id = $1', [req.restauranteId]);
        const ingredientesPrecios = new Map();
        ingredientesResult.rows.forEach(i => {
            ingredientesPrecios.set(i.id, parseFloat(i.precio) || 0);
        });

        // Acumulador para resumen diario
        const resumenDiario = new Map(); // key: "recetaId-fecha", value: { cantidad, ingresos, coste }

        for (const venta of ventas) {
            const nombreReceta = (venta.receta || '').toLowerCase().trim();
            const codigoTpv = (venta.codigo_tpv || venta.codigo || '').toString().trim();
            const cantidad = validateCantidad(venta.cantidad);

            if (cantidad === 0) {
                resultados.fallidos++;
                resultados.errores.push({ receta: venta.receta, error: 'Cantidad inválida' });
                continue;
            }

            // Prioridad: buscar por código TPV, luego por nombre
            let receta = null;
            if (codigoTpv && recetasMapCodigo.has(codigoTpv)) {
                receta = recetasMapCodigo.get(codigoTpv);
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

            const precioVenta = parseFloat(receta.precio_venta);
            const total = parseFloat(venta.total) || (precioVenta * cantidad);
            const fecha = venta.fecha || new Date().toISOString();
            const fechaDate = fecha.split('T')[0]; // Solo la fecha sin hora

            // Calcular coste de ingredientes para esta venta
            let costeIngredientes = 0;
            const ingredientesReceta = receta.ingredientes || [];
            if (Array.isArray(ingredientesReceta)) {
                for (const ing of ingredientesReceta) {
                    const precioIng = ingredientesPrecios.get(ing.ingredienteId) || 0;
                    costeIngredientes += precioIng * (ing.cantidad || 0) * cantidad;
                }
            }

            // Registrar venta individual
            await client.query(
                'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [receta.id, cantidad, precioVenta, total, fecha, req.restauranteId]
            );

            // Descontar stock
            if (Array.isArray(ingredientesReceta)) {
                for (const ing of ingredientesReceta) {
                    // SELECT FOR UPDATE para prevenir race condition en ventas simultáneas
                    await client.query(
                        'SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE',
                        [ing.ingredienteId]
                    );
                    await client.query(
                        'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2 AND restaurante_id = $3',
                        [ing.cantidad * cantidad, ing.ingredienteId, req.restauranteId]
                    );
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

        // Obtener todos los ingredientes para búsqueda rápida
        const ingredientesResult = await client.query(
            'SELECT id, nombre FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const ingredientesMap = new Map();
        ingredientesResult.rows.forEach(i => {
            ingredientesMap.set(i.nombre.toLowerCase().trim(), i.id);
        });

        for (const compra of compras) {
            const nombreIng = (compra.ingrediente || '').toLowerCase().trim();
            const ingredienteId = ingredientesMap.get(nombreIng);

            if (!ingredienteId) {
                resultados.fallidos++;
                resultados.errores.push({ ingrediente: compra.ingrediente, error: 'Ingrediente no encontrado' });
                continue;
            }

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

            // Actualizar precio base del ingrediente
            await client.query(
                'UPDATE ingredientes SET precio = $1 WHERE id = $2',
                [precio, ingredienteId]
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
        const ingredientesPrecios = await pool.query(
            'SELECT id, precio FROM ingredientes WHERE restaurante_id = $1',
            [req.restauranteId]
        );
        const preciosMap = {};
        ingredientesPrecios.rows.forEach(ing => {
            preciosMap[ing.id] = parseFloat(ing.precio) || 0;
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
app.listen(PORT, '0.0.0.0', () => {
    log('info', 'Servidor iniciado', { port: PORT, version: '2.3.0', cors: ALLOWED_ORIGINS });
    console.log(`🚀 API corriendo en puerto ${PORT}`);
    console.log(`📍 La Caleta 102 Dashboard API v2.3`);
    console.log(`✅ CORS habilitado para: ${ALLOWED_ORIGINS.join(', ')}`);

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
