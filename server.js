const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, param, query, validationResult } = require('express-validator');

// ========== CONFIGURACIÓN ==========
// IMPORTANTE: Configurar estas variables de entorno en producción
const config = {
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',') || [],
    DB: {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
    }
};

// Validar configuración requerida
const validateConfig = () => {
    const required = ['JWT_SECRET', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    const missing = required.filter(key => {
        if (key === 'JWT_SECRET') return !config.JWT_SECRET;
        if (key.startsWith('DB_')) return !config.DB[key.replace('DB_', '').toLowerCase()];
        return false;
    });

    if (missing.length > 0 && config.NODE_ENV === 'production') {
        console.error('❌ Variables de entorno requeridas no configuradas:', missing);
        process.exit(1);
    }

    // Solo en desarrollo: usar valores por defecto (NO EN PRODUCCIÓN)
    if (config.NODE_ENV !== 'production') {
        console.warn('⚠️ Ejecutando en modo desarrollo con valores por defecto');
        config.JWT_SECRET = config.JWT_SECRET || 'dev-secret-change-in-production';
        config.DB.host = config.DB.host || 'localhost';
        config.DB.database = config.DB.database || 'mindloop';
        config.DB.user = config.DB.user || 'postgres';
        config.DB.password = config.DB.password || 'postgres';
        config.ALLOWED_ORIGINS = ['http://localhost:5500', 'http://127.0.0.1:5500'];
    }
};

validateConfig();

const app = express();

// ========== MIDDLEWARE DE SEGURIDAD ==========

// Helmet: Headers de seguridad
app.use(helmet({
    contentSecurityPolicy: false, // Ajustar según necesidad
    crossOriginEmbedderPolicy: false
}));

// CORS: Solo orígenes permitidos
const corsOptions = {
    origin: function (origin, callback) {
        // Log para debug
        console.log('🌐 CORS Request from origin:', origin);
        console.log('✅ Allowed origins:', config.ALLOWED_ORIGINS);

        // Permitir requests sin origin (curl, Postman, server-to-server)
        if (!origin) {
            return callback(null, true);
        }

        // Verificar si el origin está permitido
        if (config.ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }

        // No permitido - pero no lanzar error, solo rechazar
        console.log('❌ CORS blocked for origin:', origin);
        callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    optionsSuccessStatus: 200 // Para navegadores legacy
};

// Aplicar CORS
app.use(cors(corsOptions));

// Manejar preflight OPTIONS explícitamente para todas las rutas
app.options('*', cors(corsOptions));

// Parser JSON con límite de tamaño
app.use(express.json({ limit: '10mb' }));

// Rate Limiting General
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // 100 requests por ventana
    message: { error: 'Demasiadas peticiones, intenta más tarde' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', generalLimiter);

// Rate Limiting Estricto para Login
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // 5 intentos
    message: { error: 'Demasiados intentos de login, espera 15 minutos' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate Limiting para Registro
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 3, // 3 registros por hora
    message: { error: 'Límite de registros alcanzado' }
});

// ========== LOGGING ==========
const logger = {
    info: (message, meta = {}) => {
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            message,
            ...meta
        }));
    },
    error: (message, error = null, meta = {}) => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'error',
            message,
            error: error?.message || error,
            stack: error?.stack,
            ...meta
        }));
    },
    warn: (message, meta = {}) => {
        console.warn(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'warn',
            message,
            ...meta
        }));
    }
};

// ========== BASE DE DATOS ==========
const pool = new Pool(config.DB);

// Test conexión e inicializar DB
(async () => {
    try {
        await pool.query('SELECT NOW()');
        logger.info('Conectado a PostgreSQL');

        // Crear tablas (mismo código que antes)
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
      
      CREATE TABLE IF NOT EXISTS proveedores (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        nombre VARCHAR(255) NOT NULL,
        contacto VARCHAR(255) DEFAULT '',
        telefono VARCHAR(50) DEFAULT '',
        email VARCHAR(255) DEFAULT '',
        direccion TEXT DEFAULT '',
        notas TEXT DEFAULT '',
        ingredientes INTEGER[] DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS ingredientes (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        nombre VARCHAR(255) NOT NULL,
        proveedor_id INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
        precio DECIMAL(10, 2) DEFAULT 0,
        unidad VARCHAR(50) DEFAULT 'kg',
        stock_actual DECIMAL(10, 2) DEFAULT 0,
        stock_minimo DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS recetas (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        nombre VARCHAR(255) NOT NULL,
        categoria VARCHAR(100) DEFAULT 'principal',
        precio_venta DECIMAL(10, 2) DEFAULT 0,
        porciones INTEGER DEFAULT 1,
        ingredientes JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        proveedor_id INTEGER NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        ingredientes JSONB NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        estado VARCHAR(50) DEFAULT 'pendiente',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_recepcion TIMESTAMP,
        total_recibido DECIMAL(10, 2)
      );
      
      CREATE TABLE IF NOT EXISTS ventas (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        receta_id INTEGER REFERENCES recetas(id) ON DELETE CASCADE,
        cantidad INTEGER NOT NULL,
        precio_unitario DECIMAL(10, 2) NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
      CREATE INDEX IF NOT EXISTS idx_usuarios_restaurante ON usuarios(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante ON ingredientes(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_recetas_restaurante ON recetas(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_proveedores_restaurante ON proveedores(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_pedidos_restaurante ON pedidos(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
      CREATE INDEX IF NOT EXISTS idx_ventas_restaurante ON ventas(restaurante_id);
    `);
        logger.info('Tablas inicializadas correctamente');
    } catch (err) {
        logger.error('Error al conectar con la base de datos', err);
        process.exit(1);
    }
})();

// ========== MIDDLEWARE DE AUTENTICACIÓN ==========
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        req.user = decoded;
        req.restauranteId = decoded.restauranteId;
        next();
    } catch (error) {
        logger.warn('Token inválido', { ip: req.ip });
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
};

// Helper de validación
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
};

// ========== ENDPOINTS PÚBLICOS ==========

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.1.0',
            environment: config.NODE_ENV
        });
    } catch (err) {
        res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
    }
});

// Root
app.get('/', (req, res) => {
    res.json({
        message: '🍽️ MindLoop CostOS API',
        version: '2.1.0',
        status: 'running',
        docs: '/api/docs'
    });
});

// ========== AUTENTICACIÓN ==========
app.post('/api/auth/login',
    loginLimiter,
    [
        body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
        body('password').isLength({ min: 6 }).withMessage('Contraseña mínimo 6 caracteres')
    ],
    validate,
    async (req, res) => {
        try {
            const { email, password } = req.body;

            const result = await pool.query(
                'SELECT u.*, r.nombre as restaurante_nombre FROM usuarios u JOIN restaurantes r ON u.restaurante_id = r.id WHERE u.email = $1',
                [email]
            );

            if (result.rows.length === 0) {
                logger.warn('Intento de login fallido - usuario no existe', { email, ip: req.ip });
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }

            const user = result.rows[0];
            const validPassword = await bcrypt.compare(password, user.password_hash);

            if (!validPassword) {
                logger.warn('Intento de login fallido - contraseña incorrecta', { email, ip: req.ip });
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }

            const token = jwt.sign(
                { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol },
                config.JWT_SECRET,
                { expiresIn: config.JWT_EXPIRES_IN }
            );

            logger.info('Login exitoso', { userId: user.id, restauranteId: user.restaurante_id });

            res.json({
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    nombre: user.nombre,
                    rol: user.rol,
                    restaurante: user.restaurante_nombre
                }
            });
        } catch (err) {
            logger.error('Error en login', err);
            res.status(500).json({ error: 'Error en el servidor' });
        }
    }
);

app.post('/api/auth/register',
    registerLimiter,
    [
        body('restauranteNombre').trim().notEmpty().escape().withMessage('Nombre de restaurante requerido'),
        body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
        body('password').isLength({ min: 8 }).withMessage('Contraseña mínimo 8 caracteres')
            .matches(/[A-Z]/).withMessage('Debe contener mayúscula')
            .matches(/[0-9]/).withMessage('Debe contener número'),
        body('nombreUsuario').optional().trim().escape()
    ],
    validate,
    async (req, res) => {
        const client = await pool.connect();
        try {
            const { restauranteNombre, email, password, nombreUsuario } = req.body;

            await client.query('BEGIN');

            const existingUser = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
            if (existingUser.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'El email ya está registrado' });
            }

            const restauranteResult = await client.query(
                'INSERT INTO restaurantes (nombre, email) VALUES ($1, $2) RETURNING id',
                [restauranteNombre, email]
            );
            const restauranteId = restauranteResult.rows[0].id;

            const passwordHash = await bcrypt.hash(password, 12); // Aumentado a 12 rounds
            const userResult = await client.query(
                'INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [restauranteId, email, passwordHash, nombreUsuario || 'Admin', 'admin']
            );

            await client.query('COMMIT');

            const token = jwt.sign(
                { userId: userResult.rows[0].id, restauranteId, email, rol: 'admin' },
                config.JWT_SECRET,
                { expiresIn: config.JWT_EXPIRES_IN }
            );

            logger.info('Nuevo restaurante registrado', { restauranteId, email });

            res.status(201).json({
                token,
                user: {
                    id: userResult.rows[0].id,
                    email,
                    nombre: nombreUsuario || 'Admin',
                    rol: 'admin',
                    restaurante: restauranteNombre
                }
            });
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Error en registro', err);
            res.status(500).json({ error: 'Error en el servidor' });
        } finally {
            client.release();
        }
    }
);

// ========== INGREDIENTES ==========
app.get('/api/ingredients', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM ingredientes WHERE restaurante_id = $1 ORDER BY id',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error('Error al obtener ingredientes', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/ingredients',
    authMiddleware,
    [
        body('nombre').trim().notEmpty().escape().withMessage('Nombre requerido'),
        body('precio').optional().isFloat({ min: 0 }).withMessage('Precio debe ser positivo'),
        body('unidad').optional().trim().escape(),
        body('stockActual').optional().isFloat({ min: 0 }),
        body('stockMinimo').optional().isFloat({ min: 0 }),
        body('proveedorId').optional().isInt()
    ],
    validate,
    async (req, res) => {
        try {
            const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo } = req.body;

            const finalStockActual = stockActual ?? stock_actual ?? 0;
            const finalStockMinimo = stockMinimo ?? stock_minimo ?? 0;
            const finalProveedorId = proveedorId ?? proveedor_id ?? null;

            const result = await pool.query(
                'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                [nombre, finalProveedorId, precio || 0, unidad || 'kg', finalStockActual, finalStockMinimo, req.restauranteId]
            );

            logger.info('Ingrediente creado', { ingredienteId: result.rows[0].id, restauranteId: req.restauranteId });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            logger.error('Error al crear ingrediente', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.put('/api/ingredients/:id',
    authMiddleware,
    [
        param('id').isInt().withMessage('ID inválido'),
        body('nombre').optional().trim().notEmpty().escape(),
        body('precio').optional().isFloat({ min: 0 }),
        body('stockActual').optional().isFloat({ min: 0 }),
        body('stockMinimo').optional().isFloat({ min: 0 })
    ],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo } = req.body;

            const finalStockActual = stockActual ?? stock_actual ?? 0;
            const finalStockMinimo = stockMinimo ?? stock_minimo ?? 0;
            const finalProveedorId = proveedorId ?? proveedor_id ?? null;

            const result = await pool.query(
                'UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, stock_actual=$5, stock_minimo=$6 WHERE id=$7 AND restaurante_id=$8 RETURNING *',
                [nombre, finalProveedorId, precio || 0, unidad, finalStockActual, finalStockMinimo, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            res.json(result.rows[0]);
        } catch (err) {
            logger.error('Error al actualizar ingrediente', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.delete('/api/ingredients/:id',
    authMiddleware,
    [param('id').isInt().withMessage('ID inválido')],
    validate,
    async (req, res) => {
        try {
            const result = await pool.query(
                'DELETE FROM ingredientes WHERE id=$1 AND restaurante_id=$2 RETURNING id',
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Ingrediente no encontrado' });
            }

            logger.info('Ingrediente eliminado', { ingredienteId: req.params.id });
            res.json({ message: 'Ingrediente eliminado correctamente' });
        } catch (err) {
            logger.error('Error al eliminar ingrediente', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

// ========== RECETAS ==========
app.get('/api/recipes', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM recetas WHERE restaurante_id=$1 ORDER BY id',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error('Error al obtener recetas', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/recipes',
    authMiddleware,
    [
        body('nombre').trim().notEmpty().escape().withMessage('Nombre requerido'),
        body('categoria').optional().trim().escape(),
        body('precio_venta').optional().isFloat({ min: 0 }),
        body('porciones').optional().isInt({ min: 1 })
    ],
    validate,
    async (req, res) => {
        try {
            const { nombre, categoria, precio_venta, porciones, ingredientes } = req.body;

            const result = await pool.query(
                'INSERT INTO recetas (nombre, categoria, precio_venta, porciones, ingredientes, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                [nombre, categoria || 'principal', precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), req.restauranteId]
            );

            logger.info('Receta creada', { recetaId: result.rows[0].id });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            logger.error('Error al crear receta', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.put('/api/recipes/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { nombre, categoria, precio_venta, porciones, ingredientes } = req.body;

            const result = await pool.query(
                'UPDATE recetas SET nombre=$1, categoria=$2, precio_venta=$3, porciones=$4, ingredientes=$5 WHERE id=$6 AND restaurante_id=$7 RETURNING *',
                [nombre, categoria, precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Receta no encontrada' });
            }

            res.json(result.rows[0]);
        } catch (err) {
            logger.error('Error al actualizar receta', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.delete('/api/recipes/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const result = await pool.query(
                'DELETE FROM recetas WHERE id=$1 AND restaurante_id=$2 RETURNING id',
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Receta no encontrada' });
            }

            res.json({ message: 'Receta eliminada correctamente' });
        } catch (err) {
            logger.error('Error al eliminar receta', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

// ========== PROVEEDORES ==========
app.get('/api/suppliers', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM proveedores WHERE restaurante_id=$1 ORDER BY id',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error('Error al obtener proveedores', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/suppliers',
    authMiddleware,
    [
        body('nombre').trim().notEmpty().escape().withMessage('Nombre requerido'),
        body('email').optional().isEmail().normalizeEmail(),
        body('telefono').optional().trim().escape()
    ],
    validate,
    async (req, res) => {
        try {
            const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;

            const result = await pool.query(
                'INSERT INTO proveedores (nombre, contacto, telefono, email, direccion, notas, ingredientes, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
                [nombre, contacto || '', telefono || '', email || '', direccion || '', notas || '', ingredientes || [], req.restauranteId]
            );

            logger.info('Proveedor creado', { proveedorId: result.rows[0].id });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            logger.error('Error al crear proveedor', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.put('/api/suppliers/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;

            const result = await pool.query(
                'UPDATE proveedores SET nombre=$1, contacto=$2, telefono=$3, email=$4, direccion=$5, notas=$6, ingredientes=$7 WHERE id=$8 AND restaurante_id=$9 RETURNING *',
                [nombre, contacto || '', telefono || '', email || '', direccion || '', notas || '', ingredientes || [], id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proveedor no encontrado' });
            }

            res.json(result.rows[0]);
        } catch (err) {
            logger.error('Error al actualizar proveedor', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.delete('/api/suppliers/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const result = await pool.query(
                'DELETE FROM proveedores WHERE id=$1 AND restaurante_id=$2 RETURNING id',
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proveedor no encontrado' });
            }

            res.json({ message: 'Proveedor eliminado correctamente' });
        } catch (err) {
            logger.error('Error al eliminar proveedor', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

// ========== PEDIDOS ==========
app.get('/api/orders', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM pedidos WHERE restaurante_id=$1 ORDER BY fecha DESC',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        logger.error('Error al obtener pedidos', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/orders',
    authMiddleware,
    [
        body('proveedorId').isInt().withMessage('Proveedor requerido'),
        body('fecha').isISO8601().withMessage('Fecha inválida'),
        body('total').isFloat({ min: 0 }).withMessage('Total inválido')
    ],
    validate,
    async (req, res) => {
        try {
            const { proveedorId, fecha, ingredientes, total, estado } = req.body;

            const result = await pool.query(
                'INSERT INTO pedidos (proveedor_id, fecha, ingredientes, total, estado, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                [proveedorId, fecha, JSON.stringify(ingredientes), total, estado || 'pendiente', req.restauranteId]
            );

            logger.info('Pedido creado', { pedidoId: result.rows[0].id });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            logger.error('Error al crear pedido', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.put('/api/orders/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { estado, ingredientes, totalRecibido, fechaRecepcion } = req.body;

            const result = await pool.query(
                'UPDATE pedidos SET estado=$1, ingredientes=$2, total_recibido=$3, fecha_recepcion=$4 WHERE id=$5 AND restaurante_id=$6 RETURNING *',
                [estado, JSON.stringify(ingredientes), totalRecibido, fechaRecepcion || new Date(), id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            res.json(result.rows[0]);
        } catch (err) {
            logger.error('Error al actualizar pedido', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

app.delete('/api/orders/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const result = await pool.query(
                'DELETE FROM pedidos WHERE id=$1 AND restaurante_id=$2 RETURNING id',
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            res.json({ message: 'Pedido eliminado correctamente' });
        } catch (err) {
            logger.error('Error al eliminar pedido', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

// ========== VENTAS ==========
app.get('/api/sales', authMiddleware, async (req, res) => {
    try {
        const { fecha } = req.query;
        let queryText = 'SELECT v.*, r.nombre as receta_nombre FROM ventas v LEFT JOIN recetas r ON v.receta_id = r.id WHERE v.restaurante_id = $1';
        let params = [req.restauranteId];

        if (fecha) {
            queryText += ' AND DATE(v.fecha) = $2';
            params.push(fecha);
        }

        queryText += ' ORDER BY v.fecha DESC';
        const result = await pool.query(queryText, params);
        res.json(result.rows);
    } catch (err) {
        logger.error('Error al obtener ventas', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/sales',
    authMiddleware,
    [
        body('recetaId').isInt().withMessage('Receta requerida'),
        body('cantidad').isInt({ min: 1 }).withMessage('Cantidad debe ser mayor a 0')
    ],
    validate,
    async (req, res) => {
        const client = await pool.connect();
        try {
            const { recetaId, cantidad } = req.body;

            await client.query('BEGIN');

            const recetaResult = await client.query(
                'SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2',
                [recetaId, req.restauranteId]
            );

            if (recetaResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Receta no encontrada' });
            }

            const receta = recetaResult.rows[0];
            const precioUnitario = parseFloat(receta.precio_venta);
            const total = precioUnitario * cantidad;

            // Verificar stock
            const ingredientesReceta = receta.ingredientes;
            for (const ing of ingredientesReceta) {
                const stockResult = await client.query(
                    'SELECT stock_actual, nombre FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
                    [ing.ingredienteId, req.restauranteId]
                );

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

            // Registrar venta
            const ventaResult = await client.query(
                'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, restaurante_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [recetaId, cantidad, precioUnitario, total, req.restauranteId]
            );

            // Descontar stock
            for (const ing of ingredientesReceta) {
                await client.query(
                    'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2 AND restaurante_id = $3',
                    [ing.cantidad * cantidad, ing.ingredienteId, req.restauranteId]
                );
            }

            await client.query('COMMIT');
            logger.info('Venta registrada', { ventaId: ventaResult.rows[0].id, total });
            res.status(201).json(ventaResult.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Error al registrar venta', err);
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    }
);

app.delete('/api/sales/:id',
    authMiddleware,
    [param('id').isInt()],
    validate,
    async (req, res) => {
        try {
            const result = await pool.query(
                'DELETE FROM ventas WHERE id=$1 AND restaurante_id=$2 RETURNING id',
                [req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Venta no encontrada' });
            }

            res.json({ message: 'Venta eliminada correctamente' });
        } catch (err) {
            logger.error('Error al eliminar venta', err);
            res.status(500).json({ error: 'Error interno' });
        }
    }
);

// ========== BALANCE Y ESTADÍSTICAS ==========
app.get('/api/balance/mes', authMiddleware, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const mesActual = mes || new Date().getMonth() + 1;
        const anoActual = ano || new Date().getFullYear();

        const ventasMes = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
       FROM ventas
       WHERE EXTRACT(MONTH FROM fecha) = $1 
         AND EXTRACT(YEAR FROM fecha) = $2 
         AND restaurante_id = $3`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasDetalle = await pool.query(
            `SELECT v.cantidad, r.ingredientes
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 
         AND EXTRACT(YEAR FROM v.fecha) = $2 
         AND v.restaurante_id = $3`,
            [mesActual, anoActual, req.restauranteId]
        );

        let costos = 0;
        for (const venta of ventasDetalle.rows) {
            const ingredientes = venta.ingredientes;
            for (const ing of ingredientes) {
                const ingResult = await pool.query(
                    'SELECT precio FROM ingredientes WHERE id = $1',
                    [ing.ingredienteId]
                );
                if (ingResult.rows.length > 0) {
                    costos += parseFloat(ingResult.rows[0].precio) * ing.cantidad * venta.cantidad;
                }
            }
        }

        const ingresos = parseFloat(ventasMes.rows[0].ingresos) || 0;
        const ganancia = ingresos - costos;
        const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;

        const platoMasVendido = await pool.query(
            `SELECT r.nombre, SUM(v.cantidad) as total_vendido
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 
         AND EXTRACT(YEAR FROM v.fecha) = $2 
         AND v.restaurante_id = $3
       GROUP BY r.nombre
       ORDER BY total_vendido DESC
       LIMIT 1`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasPorPlato = await pool.query(
            `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 
         AND EXTRACT(YEAR FROM v.fecha) = $2 
         AND v.restaurante_id = $3
       GROUP BY r.nombre
       ORDER BY total_ingresos DESC`,
            [mesActual, anoActual, req.restauranteId]
        );

        const valorInventario = await pool.query(
            `SELECT COALESCE(SUM(stock_actual * precio), 0) as valor
       FROM ingredientes 
       WHERE restaurante_id = $1`,
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
        logger.error('Error obteniendo balance', error);
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
       WHERE restaurante_id = $1
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`,
            [req.restauranteId]
        );

        res.json(meses.rows);
    } catch (error) {
        logger.error('Error obteniendo comparativa', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== WEBHOOKS PARA N8N ==========
app.get('/api/webhooks/stock-alerts', authMiddleware, async (req, res) => {
    try {
        const alertas = await pool.query(
            `SELECT id, nombre, stock_actual, stock_minimo, unidad 
       FROM ingredientes 
       WHERE stock_actual < stock_minimo AND restaurante_id = $1
       ORDER BY (stock_minimo - stock_actual) DESC`,
            [req.restauranteId]
        );

        res.json({
            count: alertas.rows.length,
            alertas: alertas.rows
        });
    } catch (err) {
        logger.error('Error obteniendo alertas de stock', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.get('/api/webhooks/daily-summary', authMiddleware, async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];

        const ventas = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as num_ventas
       FROM ventas 
       WHERE DATE(fecha) = $1 AND restaurante_id = $2`,
            [hoy, req.restauranteId]
        );

        const topPlatos = await pool.query(
            `SELECT r.nombre, SUM(v.cantidad) as cantidad, SUM(v.total) as total
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE DATE(v.fecha) = $1 AND v.restaurante_id = $2
       GROUP BY r.nombre
       ORDER BY cantidad DESC
       LIMIT 5`,
            [hoy, req.restauranteId]
        );

        res.json({
            fecha: hoy,
            ventas_total: parseFloat(ventas.rows[0].total) || 0,
            num_ventas: parseInt(ventas.rows[0].num_ventas) || 0,
            top_platos: topPlatos.rows
        });
    } catch (err) {
        logger.error('Error obteniendo resumen diario', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== MANEJO DE ERRORES ==========
app.use((err, req, res, next) => {
    logger.error('Error no manejado', err);

    if (err.message === 'No permitido por CORS') {
        return res.status(403).json({ error: 'Origen no permitido' });
    }

    res.status(500).json({ error: 'Error interno del servidor' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ========== INICIAR SERVIDOR ==========
app.listen(config.PORT, '0.0.0.0', () => {
    logger.info('Servidor iniciado', {
        port: config.PORT,
        environment: config.NODE_ENV,
        version: '2.1.0'
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('Recibida señal SIGTERM, cerrando...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('Recibida señal SIGINT, cerrando...');
    await pool.end();
    process.exit(0);
});
