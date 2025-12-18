// Cargar dotenv solo si está disponible (desarrollo local)
try {
    require('dotenv').config();
} catch (e) {
    console.log('dotenv no disponible - usando variables de entorno del sistema');
}

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const joi = require('joi');

// ==========================================
// 1. CONFIGURACIÓN Y CONSTANTES
// ==========================================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.warn('⚠️  ADVERTENCIA: JWT_SECRET no está definido en variables de entorno.');
    console.warn('    Se usará un secreto temporal inseguro. !ESTO NO ES SEGURO PARA PRODUCCIÓN!');
}
const SAFE_JWT_SECRET = JWT_SECRET || 'temp_dev_secret_do_not_use_in_prod';

// Orígenes permitidos para CORS
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:5500', 'https://klaker79.github.io'];

const app = express();

// ==========================================
// 2. MIDDLEWARES DE SEGURIDAD Y UTILIDADES
// ==========================================

// Helmet para cabeceras de seguridad HTTP
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// Configuración de CORS
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            console.warn(`Bloqueado por CORS: ${origin}`);
            callback(new Error('No permitido por CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones, por favor intenta más tarde.' }
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Demasiados intentos de inicio de sesión, intenta en una hora.' }
});

app.use(express.json({ limit: '10mb' }));

const LOG_FILE = path.join(__dirname, 'server.log');
const log = (level, message, data = {}) => {
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({ timestamp, level, message, ...data });
    console.log(`[${level.toUpperCase()}] ${message}`, Object.keys(data).length ? data : '');
    fs.appendFile(LOG_FILE, logEntry + '\n', (err) => {
        if (err) console.error('Error escribiendo log:', err);
    });
};

// ==========================================
// 3. BASE DE DATOS (PostgreSQL)
// ==========================================
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

(async () => {
    try {
        await pool.query('SELECT NOW()');
        log('info', 'Conexión a base de datos exitosa');
        await inicializarTablas();
    } catch (err) {
        log('error', 'Error conectando a la base de datos', { error: err.message });
        console.error('❌ Error fatal: No se pudo conectar a la base de datos.');
    }
})();

async function inicializarTablas() {
    const schema = `
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
            codigo VARCHAR(50),
            ultima_actualizacion_stock TIMESTAMP,
            fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS recetas (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(255) NOT NULL,
            categoria VARCHAR(100) DEFAULT 'principal',
            precio_venta DECIMAL(10, 2) DEFAULT 0,
            porciones INTEGER DEFAULT 1,
            ingredientes JSONB DEFAULT '[]',
            codigo VARCHAR(50),
            fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
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
            cif VARCHAR(50),
            codigo VARCHAR(50),
            ingredientes INTEGER[] DEFAULT '{}',
            fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
            restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ventas (
            id SERIAL PRIMARY KEY,
            receta_id INTEGER REFERENCES recetas(id) ON DELETE SET NULL,
            cantidad INTEGER NOT NULL,
            precio_unitario DECIMAL(10, 2) NOT NULL,
            total DECIMAL(10, 2) NOT NULL,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS api_tokens (
            id SERIAL PRIMARY KEY,
            restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
            nombre VARCHAR(255) NOT NULL,
            token_hash VARCHAR(255) NOT NULL,
            ultimo_uso TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
        CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
        CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante ON ingredientes(restaurante_id);
        CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
    `;

    try {
        await pool.query(schema);
        log('info', 'Esquema de base de datos verificado/creado');
    } catch (err) {
        log('error', 'Error creando esquema', { error: err.message });
    }
}

// ==========================================
// 4. MIDDLEWARES DE APLICACIÓN
// ==========================================

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Token de autenticación requerido' });

    jwt.verify(token, SAFE_JWT_SECRET, (err, user) => {
        if (err) {
            log('warn', 'Token inválido', { error: err.message, ip: req.ip });
            return res.status(403).json({ error: 'Token inválido o expirado' });
        }
        req.user = user;
        req.restauranteId = user.restauranteId;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.rol !== 'admin' && req.user.rol !== 'api') {
        return res.status(403).json({ error: 'Se requieren permisos de administrador' });
    }
    next();
};

// ==========================================
// 5. VALIDACIÓN DE DATOS (JOI)
// ==========================================

const schemas = {
    login: joi.object({
        email: joi.string().email().required(),
        password: joi.string().required()
    }),
    register: joi.object({
        restauranteNombre: joi.string().required(),
        email: joi.string().email().required(),
        password: joi.string().min(6).required(),
        nombreUsuario: joi.string().optional()
    }),
    ingrediente: joi.object({
        nombre: joi.string().required(),
        precio: joi.number().min(0).default(0),
        unidad: joi.string().default('kg'),
        stockActual: joi.number().default(0),
        stockMinimo: joi.number().default(0),
        proveedorId: joi.number().allow(null).optional(),
        familia: joi.string().default('alimento'),
        stock_actual: joi.number().optional(),
        stock_minimo: joi.number().optional(),
        proveedor_id: joi.number().optional()
    }).unknown(true)
};

const validate = (schema) => (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }
    next();
};

// ==========================================
// 6. RUTAS API
// ==========================================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'healthy', database: 'connected', timestamp: new Date() });
    } catch (e) {
        res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: e.message });
    }
});

// --- Auth ---
app.post('/api/auth/login', authLimiter, validate(schemas.login), async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query(
            'SELECT u.*, r.nombre as restaurante_nombre FROM usuarios u JOIN restaurantes r ON u.restaurante_id = r.id WHERE u.email = $1',
            [email]
        );

        if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) return res.status(401).json({ error: 'Credenciales inválidas' });

        const token = jwt.sign(
            { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol },
            SAFE_JWT_SECRET,
            { expiresIn: '24h' }
        );

        log('info', 'Usuario logueado', { userId: user.id });

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
        log('error', 'Error en login', { error: err.message });
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/auth/register', validate(schemas.register), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { restauranteNombre, email, password, nombreUsuario } = req.body;

        const existingUser = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'El email ya está registrado' });
        }

        const restResult = await client.query(
            'INSERT INTO restaurantes (nombre, email) VALUES ($1, $2) RETURNING id',
            [restauranteNombre, email]
        );
        const restauranteId = restResult.rows[0].id;

        const hashedPassword = await bcrypt.hash(password, 10);
        const userResult = await client.query(
            'INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [restauranteId, email, hashedPassword, nombreUsuario || 'Admin', 'admin']
        );

        await client.query('COMMIT');

        const token = jwt.sign(
            { userId: userResult.rows[0].id, restauranteId, email, rol: 'admin' },
            SAFE_JWT_SECRET,
            { expiresIn: '24h' }
        );

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
        log('error', 'Error en registro', { error: err.message });
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        client.release();
    }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

// --- Ingredientes ---
app.get('/api/ingredients', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ingredientes WHERE restaurante_id = $1 ORDER BY nombre', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ingredients', authenticateToken, validate(schemas.ingrediente), async (req, res) => {
    try {
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia, codigo } = req.body;
        const fStock = stockActual ?? stock_actual ?? 0;
        const fMin = stockMinimo ?? stock_minimo ?? 0;
        const fProv = proveedorId ?? proveedor_id ?? null;

        const result = await pool.query(
            `INSERT INTO ingredientes 
            (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, familia, codigo, restaurante_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [nombre, fProv, precio, unidad, fStock, fMin, familia, codigo, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/ingredients/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia, codigo } = req.body;

        const fStock = stockActual ?? stock_actual;
        const fMin = stockMinimo ?? stock_minimo;
        const fProv = proveedorId ?? proveedor_id;

        const result = await pool.query(
            `UPDATE ingredientes SET 
                nombre = COALESCE($1, nombre),
                proveedor_id = COALESCE($2, proveedor_id),
                precio = COALESCE($3, precio),
                unidad = COALESCE($4, unidad),
                stock_actual = COALESCE($5, stock_actual),
                stock_minimo = COALESCE($6, stock_minimo),
                familia = COALESCE($7, familia),
                codigo = COALESCE($8, codigo),
                fecha_actualizacion = CURRENT_TIMESTAMP
            WHERE id = $9 AND restaurante_id = $10 RETURNING *`,
            [nombre, fProv, precio, unidad, fStock, fMin, familia, codigo, id, req.restauranteId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Ingrediente no encontrado' });
        res.json(result.rows[0]);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/ingredients/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM ingredientes WHERE id = $1 AND restaurante_id = $2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Ingrediente eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'No se puede eliminar (probablemente está en uso)' });
    }
});

// --- Recetas ---
app.get('/api/recipes', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM recetas WHERE restaurante_id = $1 ORDER BY nombre', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/recipes', authenticateToken, async (req, res) => {
    try {
        const { nombre, categoria, precio_venta, porciones, ingredientes, codigo } = req.body;
        const result = await pool.query(
            `INSERT INTO recetas (nombre, categoria, precio_venta, porciones, ingredientes, codigo, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [nombre, categoria, precio_venta, porciones, JSON.stringify(ingredientes || []), codigo, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/recipes/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, categoria, precio_venta, porciones, ingredientes, codigo } = req.body;
        const result = await pool.query(
            `UPDATE recetas SET 
                nombre = COALESCE($1, nombre),
                categoria = COALESCE($2, categoria),
                precio_venta = COALESCE($3, precio_venta),
                porciones = COALESCE($4, porciones),
                ingredientes = COALESCE($5, ingredientes),
                codigo = COALESCE($6, codigo),
                fecha_actualizacion = CURRENT_TIMESTAMP
            WHERE id = $7 AND restaurante_id = $8 RETURNING *`,
            [nombre, categoria, precio_venta, porciones, JSON.stringify(ingredientes), codigo, id, req.restauranteId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/recipes/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM recetas WHERE id = $1 AND restaurante_id = $2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Receta eliminada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Proveedores ---
app.get('/api/suppliers', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM proveedores WHERE restaurante_id = $1 ORDER BY nombre', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/suppliers', authenticateToken, async (req, res) => {
    try {
        const { nombre, contacto, telefono, email, direccion, notas, cif } = req.body;
        const result = await pool.query(
            `INSERT INTO proveedores (nombre, contacto, telefono, email, direccion, notas, cif, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [nombre, contacto, telefono, email, direccion, notas, cif, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/suppliers/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, contacto, telefono, email, direccion, notas, cif } = req.body;
        const result = await pool.query(
            `UPDATE proveedores SET 
                nombre = COALESCE($1, nombre),
                contacto = COALESCE($2, contacto),
                telefono = COALESCE($3, telefono),
                email = COALESCE($4, email),
                direccion = COALESCE($5, direccion),
                notas = COALESCE($6, notas),
                cif = COALESCE($7, cif)
            WHERE id = $8 AND restaurante_id = $9 RETURNING *`,
            [nombre, contacto, telefono, email, direccion, notas, cif, id, req.restauranteId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/suppliers/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM proveedores WHERE id = $1 AND restaurante_id = $2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Proveedor eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Pedidos ---
app.get('/api/orders', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, pr.nombre as proveedor_nombre 
             FROM pedidos p 
             LEFT JOIN proveedores pr ON p.proveedor_id = pr.id 
             WHERE p.restaurante_id = $1 
             ORDER BY p.fecha DESC LIMIT 100`,
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { proveedorId, fecha, ingredientes, total, estado } = req.body;
        const estadoInicial = estado || 'pendiente';

        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO pedidos (proveedor_id, fecha, ingredientes, total, estado, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [proveedorId, fecha, JSON.stringify(ingredientes), total, estadoInicial, req.restauranteId]
        );

        if (estadoInicial === 'recibido') {
            for (const item of ingredientes) {
                await client.query(
                    `UPDATE ingredientes SET stock_actual = stock_actual + $1, precio = $2 
                     WHERE id = $3 AND restaurante_id = $4`,
                    [item.cantidad, item.precio, item.ingredienteId, req.restauranteId]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- Ventas ---
app.post('/api/sales', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { recetaId, cantidad, fecha } = req.body;

        await client.query('BEGIN');

        const recetaResult = await client.query(
            'SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2',
            [recetaId, req.restauranteId]
        );

        if (recetaResult.rows.length === 0) throw new Error('Receta no encontrada');
        const receta = recetaResult.rows[0];

        const totalVenta = receta.precio_venta * cantidad;

        const ventaResult = await client.query(
            `INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [recetaId, cantidad, receta.precio_venta, totalVenta, fecha || new Date(), req.restauranteId]
        );

        if (receta.ingredientes && Array.isArray(receta.ingredientes)) {
            for (const ing of receta.ingredientes) {
                await client.query(
                    `UPDATE ingredientes 
                     SET stock_actual = stock_actual - $1 
                     WHERE id = $2 AND restaurante_id = $3`,
                    [ing.cantidad * cantidad, ing.id, req.restauranteId]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json(ventaResult.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- Resumen Mensual ---
app.get('/api/monthly/summary', authenticateToken, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const result = {
            compras: { total: 0, ingredientes: {} },
            ventas: { totalIngresos: 0, beneficioBruto: 0, recetas: {} },
            resumen: { foodCost: 0 },
            dias: []
        };
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Manejo de errores ---
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado' });
});

app.use((err, req, res, next) => {
    log('error', 'Error no manejado', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor crítica' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    log('info', `Servidor iniciado en puerto ${PORT}`);
});
