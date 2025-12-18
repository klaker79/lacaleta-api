require('dotenv').config();
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
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Permitir cargar recursos desde otros orígenes
}));

// Configuración de CORS - SIEMPRE permite GitHub Pages
const GITHUB_PAGES_ORIGIN = 'https://klaker79.github.io';
app.use(cors({
    origin: function (origin, callback) {
        // Permitir requests sin origin (como apps móviles, curl, n8n)
        if (!origin) return callback(null, true);

        // SIEMPRE permitir GitHub Pages
        if (origin === GITHUB_PAGES_ORIGIN) return callback(null, true);

        // Permitir orígenes configurados o en desarrollo
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

// Rate Limiting para prevenir abuso
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 500, // Límite de peticiones por IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones, por favor intenta más tarde.' }
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 20, // Límite estricto para login
    message: { error: 'Demasiados intentos de inicio de sesión, intenta en una hora.' }
});

// Parsing del body
app.use(express.json({ limit: '10mb' }));

// Logging personalizado
const LOG_FILE = path.join(__dirname, 'server.log');
const log = (level, message, data = {}) => {
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({ timestamp, level, message, ...data });
    console.log(`[${level.toUpperCase()}] ${message}`, Object.keys(data).length ? data : '');

    // Escribir a archivo de forma asíncrona pero sin bloquear
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
    // SSL requerido para producción en muchos servicios cloud
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicialización de DB
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
    // Definición de esquema
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
        
        -- Índices para optimización
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
        stock_actual: joi.number().optional(), // Compatibilidad
        stock_minimo: joi.number().optional(), // Compatibilidad
        proveedor_id: joi.number().optional()  // Compatibilidad
    }).unknown(true) // Permitir campos extra por compatibilidad
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

// --- Health Check ---
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
        // Normalización de campos legacy
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

        // Construcción dinámica de query para actualizar solo lo enviado
        // (Simplificado para este ejemplo: actualizamos todo lo común)
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

// --- Pedidos (Orders) ---
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

        // Si el pedido se crea como 'recibido', actualizar stock inmediatamente
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

// --- Ventas (Sales) ---
app.post('/api/sales', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { recetaId, cantidad, fecha } = req.body;

        await client.query('BEGIN');

        // 1. Obtener datos de la receta para calcular total y descontar stock
        const recetaResult = await client.query(
            'SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2',
            [recetaId, req.restauranteId]
        );

        if (recetaResult.rows.length === 0) throw new Error('Receta no encontrada');
        const receta = recetaResult.rows[0];

        const totalVenta = receta.precio_venta * cantidad;

        // 2. Registrar venta
        const ventaResult = await client.query(
            `INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [recetaId, cantidad, receta.precio_venta, totalVenta, fecha || new Date(), req.restauranteId]
        );

        // 3. Descontar stock de ingredientes
        // (Asumimos que ingredientes es un array de objetos con {id, cantidad})
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

// --- GET Ventas (listar) ---
app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin } = req.query;
        let query = `
            SELECT v.*, r.nombre as receta_nombre, r.categoria as receta_categoria
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1
        `;
        const params = [req.user.restauranteId];

        if (fecha_inicio && fecha_fin) {
            query += ` AND v.fecha BETWEEN $2 AND $3`;
            params.push(fecha_inicio, fecha_fin);
        }

        query += ' ORDER BY v.fecha DESC LIMIT 500';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener ventas' });
    }
});

// --- DELETE Venta ---
app.delete('/api/sales/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        // Nota: NO restauramos stock automáticamente al eliminar
        const result = await pool.query(
            'DELETE FROM ventas WHERE id = $1 AND restaurante_id = $2 RETURNING *',
            [id, req.user.restauranteId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Venta no encontrada' });
        }

        res.json({ message: 'Venta eliminada', venta: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar venta' });
    }
});

// --- PUT Pedido (actualizar/recibir) ---
app.put('/api/orders/:id', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { id } = req.params;
        const { estado, ingredientes, total_recibido } = req.body;

        // Obtener pedido actual
        const pedidoResult = await client.query(
            'SELECT * FROM pedidos WHERE id = $1 AND restaurante_id = $2',
            [id, req.user.restauranteId]
        );

        if (pedidoResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        const pedidoActual = pedidoResult.rows[0];

        // Si se marca como recibido, actualizar stock de ingredientes
        if (estado === 'recibido' && pedidoActual.estado !== 'recibido') {
            const items = ingredientes || pedidoActual.ingredientes;

            for (const item of items) {
                const cantidadASumar = item.cantidadRecibida !== undefined
                    ? item.cantidadRecibida
                    : item.cantidad;

                if (cantidadASumar > 0 && item.estado !== 'no-entregado') {
                    await client.query(
                        'UPDATE ingredientes SET stock_actual = stock_actual + $1 WHERE id = $2 AND restaurante_id = $3',
                        [cantidadASumar, item.ingredienteId, req.user.restauranteId]
                    );

                    // Si hay precio real, actualizar precio del ingrediente
                    if (item.precioReal && item.precioReal > 0) {
                        await client.query(
                            'UPDATE ingredientes SET precio = $1 WHERE id = $2 AND restaurante_id = $3',
                            [item.precioReal, item.ingredienteId, req.user.restauranteId]
                        );
                    }
                }
            }
        }

        // Actualizar pedido
        const updateResult = await client.query(`
            UPDATE pedidos SET 
                estado = COALESCE($1, estado),
                ingredientes = COALESCE($2, ingredientes),
                total_recibido = COALESCE($3, total_recibido),
                fecha_recepcion = CASE WHEN $1 = 'recibido' THEN NOW() ELSE fecha_recepcion END
            WHERE id = $4 AND restaurante_id = $5
            RETURNING *
        `, [estado, ingredientes ? JSON.stringify(ingredientes) : null, total_recibido, id, req.user.restauranteId]);

        await client.query('COMMIT');
        res.json(updateResult.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error actualizando pedido', { error: err.message });
        res.status(500).json({ error: 'Error al actualizar pedido' });
    } finally {
        client.release();
    }
});

// --- TEAM MANAGEMENT ---
// GET Team (listar usuarios del restaurante)
app.get('/api/team', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email, nombre, rol, created_at FROM usuarios WHERE restaurante_id = $1 ORDER BY created_at',
            [req.user.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener equipo' });
    }
});

// POST Invite User
app.post('/api/team/invite', authenticateToken, async (req, res) => {
    try {
        const { email, nombre, password, rol = 'usuario' } = req.body;

        // Validar que el usuario actual sea admin
        if (req.user.rol !== 'admin') {
            return res.status(403).json({ error: 'Solo administradores pueden invitar usuarios' });
        }

        // Verificar si el email ya existe
        const existing = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existing.rowCount > 0) {
            return res.status(400).json({ error: 'El email ya está registrado' });
        }

        // Hash password
        const tempPassword = password || Math.random().toString(36).slice(-8);
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        // Crear usuario
        const result = await pool.query(`
            INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, email, nombre, rol, created_at
        `, [req.user.restauranteId, email, passwordHash, nombre || email, rol]);

        res.status(201).json({
            user: result.rows[0],
            tempPassword: password ? undefined : tempPassword // Solo devolver si se generó automáticamente
        });
    } catch (err) {
        log('error', 'Error invitando usuario', { error: err.message });
        res.status(500).json({ error: 'Error al invitar usuario' });
    }
});

// DELETE Team Member
app.delete('/api/team/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar que el usuario actual sea admin
        if (req.user.rol !== 'admin') {
            return res.status(403).json({ error: 'Solo administradores pueden eliminar usuarios' });
        }

        // No permitir eliminarse a sí mismo
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
        }

        const result = await pool.query(
            'DELETE FROM usuarios WHERE id = $1 AND restaurante_id = $2 RETURNING id, email',
            [id, req.user.restauranteId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ message: 'Usuario eliminado', user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

// --- INVENTORY ENDPOINTS ---
// GET Inventory (ingredientes con info de stock)
app.get('/api/inventory', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, nombre, unidad, precio, stock_actual, stock_minimo, stock_real, 
                   familia, ultima_actualizacion_stock
            FROM ingredientes 
            WHERE restaurante_id = $1 
            ORDER BY nombre
        `, [req.user.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener inventario' });
    }
});

// PUT Update Stock Real Individual
app.put('/api/inventory/:id/stock-real', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { stock_real } = req.body;

        const result = await pool.query(`
            UPDATE ingredientes 
            SET stock_real = $1, ultima_actualizacion_stock = NOW()
            WHERE id = $2 AND restaurante_id = $3
            RETURNING *
        `, [stock_real, id, req.user.restauranteId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error actualizando stock real' });
    }
});

// PUT Bulk Update Stock
app.put('/api/inventory/bulk-update-stock', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { stocks } = req.body; // Array de { id, stock_real }

        for (const item of stocks) {
            await client.query(`
                UPDATE ingredientes 
                SET stock_real = $1, ultima_actualizacion_stock = NOW()
                WHERE id = $2 AND restaurante_id = $3
            `, [item.stock_real, item.id, req.user.restauranteId]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Stock actualizado', count: stocks.length });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error en actualización masiva' });
    } finally {
        client.release();
    }
});

// POST Consolidate Stock (ajusta stock_actual al stock_real)
app.post('/api/inventory/consolidate', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { adjustments } = req.body; // Array de { id, stock_real }

        for (const item of adjustments) {
            await client.query(`
                UPDATE ingredientes 
                SET stock_actual = $1, stock_real = $1, ultima_actualizacion_stock = NOW()
                WHERE id = $2 AND restaurante_id = $3
            `, [item.stock_real, item.id, req.user.restauranteId]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Stock consolidado', count: adjustments.length });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error en consolidación de stock' });
    } finally {
        client.release();
    }
});

// --- ANALYSIS: Menu Engineering (Matriz BCG) ---
app.get('/api/analysis/menu-engineering', authenticateToken, async (req, res) => {
    try {
        // Obtener recetas con sus ventas totales
        const recetasResult = await pool.query(`
            SELECT r.id, r.nombre, r.precio_venta, r.ingredientes,
                   COALESCE(SUM(v.cantidad), 0) as total_vendidas
            FROM recetas r
            LEFT JOIN ventas v ON r.id = v.receta_id
            WHERE r.restaurante_id = $1
            GROUP BY r.id
            ORDER BY r.nombre
        `, [req.user.restauranteId]);

        // Obtener todos los ingredientes para calcular costes
        const ingredientesResult = await pool.query(
            'SELECT id, precio FROM ingredientes WHERE restaurante_id = $1',
            [req.user.restauranteId]
        );

        const ingredientesMap = {};
        ingredientesResult.rows.forEach(ing => {
            ingredientesMap[ing.id] = parseFloat(ing.precio) || 0;
        });

        // Calcular métricas para clasificación BCG
        const recetasConMetricas = recetasResult.rows.map(rec => {
            // Calcular coste de la receta
            let coste = 0;
            const ingredientesReceta = rec.ingredientes || [];
            ingredientesReceta.forEach(item => {
                const precioIng = ingredientesMap[item.ingredienteId] || 0;
                coste += precioIng * (item.cantidad || 0);
            });

            const precioVenta = parseFloat(rec.precio_venta) || 0;
            const margen = precioVenta - coste;
            const popularidad = parseInt(rec.total_vendidas) || 0;

            return {
                id: rec.id,
                nombre: rec.nombre,
                coste,
                precioVenta,
                margen,
                popularidad
            };
        });

        // Calcular medianas para clasificación
        const margenes = recetasConMetricas.map(r => r.margen).sort((a, b) => a - b);
        const popularidades = recetasConMetricas.map(r => r.popularidad).sort((a, b) => a - b);

        const medianaMargen = margenes.length > 0
            ? margenes[Math.floor(margenes.length / 2)]
            : 0;
        const medianaPopularidad = popularidades.length > 0
            ? popularidades[Math.floor(popularidades.length / 2)]
            : 0;

        // Clasificar cada receta
        const resultado = recetasConMetricas.map(rec => {
            let clasificacion;
            if (rec.margen >= medianaMargen && rec.popularidad >= medianaPopularidad) {
                clasificacion = 'estrella';
            } else if (rec.margen < medianaMargen && rec.popularidad >= medianaPopularidad) {
                clasificacion = 'caballo';
            } else if (rec.margen >= medianaMargen && rec.popularidad < medianaPopularidad) {
                clasificacion = 'puzzle';
            } else {
                clasificacion = 'perro';
            }

            return { ...rec, clasificacion };
        });

        res.json(resultado);
    } catch (err) {
        log('error', 'Error en menu engineering', { error: err.message });
        res.status(500).json({ error: 'Error al obtener análisis de menú' });
    }
});

// --- Resumen Mensual (IMPLEMENTACIÓN REAL) ---
app.get('/api/monthly/summary', authenticateToken, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const mesInt = parseInt(mes) || (new Date().getMonth() + 1);
        const anoInt = parseInt(ano) || new Date().getFullYear();

        // Fechas del mes
        const fechaInicio = `${anoInt}-${String(mesInt).padStart(2, '0')}-01`;
        const fechaFin = new Date(anoInt, mesInt, 0).toISOString().split('T')[0]; // Último día del mes

        // Obtener pedidos (compras) del mes
        const pedidosResult = await pool.query(`
            SELECT p.*, pr.nombre as proveedor_nombre
            FROM pedidos p
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            WHERE p.restaurante_id = $1 
              AND p.fecha BETWEEN $2 AND $3
              AND p.estado = 'recibido'
            ORDER BY p.fecha
        `, [req.user.restauranteId, fechaInicio, fechaFin]);

        // Obtener ventas del mes
        const ventasResult = await pool.query(`
            SELECT v.*, r.nombre as receta_nombre, r.ingredientes as receta_ingredientes
            FROM ventas v
            LEFT JOIN recetas r ON v.receta_id = r.id
            WHERE v.restaurante_id = $1 
              AND v.fecha BETWEEN $2 AND $3
            ORDER BY v.fecha
        `, [req.user.restauranteId, fechaInicio, fechaFin]);

        // Obtener ingredientes para calcular costes
        const ingredientesResult = await pool.query(
            'SELECT id, nombre, precio FROM ingredientes WHERE restaurante_id = $1',
            [req.user.restauranteId]
        );

        const ingredientesMap = {};
        ingredientesResult.rows.forEach(ing => {
            ingredientesMap[ing.id] = { nombre: ing.nombre, precio: parseFloat(ing.precio) || 0 };
        });

        // Generar lista de días del mes
        const dias = [];
        const fechaActual = new Date(fechaInicio);
        const fechaFinDate = new Date(fechaFin);
        while (fechaActual <= fechaFinDate) {
            dias.push(fechaActual.toISOString().split('T')[0]);
            fechaActual.setDate(fechaActual.getDate() + 1);
        }

        // Procesar compras por ingrediente y día
        let totalCompras = 0;
        const comprasIngredientes = {};

        pedidosResult.rows.forEach(pedido => {
            const fechaPedido = new Date(pedido.fecha).toISOString().split('T')[0];
            const items = pedido.ingredientes || [];

            items.forEach(item => {
                const ingInfo = ingredientesMap[item.ingredienteId];
                if (!ingInfo) return;

                const nombre = ingInfo.nombre;
                const precio = item.cantidadRecibida !== undefined
                    ? (item.precioReal || item.precioUnitario || 0) * item.cantidadRecibida
                    : (item.precioUnitario || 0) * item.cantidad;

                totalCompras += precio;

                if (!comprasIngredientes[nombre]) {
                    comprasIngredientes[nombre] = { total: 0, dias: {} };
                }
                comprasIngredientes[nombre].total += precio;

                if (!comprasIngredientes[nombre].dias[fechaPedido]) {
                    comprasIngredientes[nombre].dias[fechaPedido] = { precio: 0, cantidad: 0 };
                }
                comprasIngredientes[nombre].dias[fechaPedido].precio += precio;
                comprasIngredientes[nombre].dias[fechaPedido].cantidad += item.cantidadRecibida || item.cantidad;
            });
        });

        // Procesar ventas por receta y día
        let totalIngresos = 0;
        let totalCosteVentas = 0;
        const ventasRecetas = {};

        ventasResult.rows.forEach(venta => {
            const fechaVenta = new Date(venta.fecha).toISOString().split('T')[0];
            const nombre = venta.receta_nombre || 'Sin nombre';
            const ingresos = parseFloat(venta.total) || 0;

            // Calcular coste de la venta
            let costeVenta = 0;
            const ingredientesReceta = venta.receta_ingredientes || [];
            ingredientesReceta.forEach(item => {
                const ingInfo = ingredientesMap[item.ingredienteId];
                if (ingInfo) {
                    costeVenta += ingInfo.precio * (item.cantidad || 0) * venta.cantidad;
                }
            });

            totalIngresos += ingresos;
            totalCosteVentas += costeVenta;

            if (!ventasRecetas[nombre]) {
                ventasRecetas[nombre] = { totalIngresos: 0, totalVendidas: 0, dias: {} };
            }
            ventasRecetas[nombre].totalIngresos += ingresos;
            ventasRecetas[nombre].totalVendidas += venta.cantidad;

            if (!ventasRecetas[nombre].dias[fechaVenta]) {
                ventasRecetas[nombre].dias[fechaVenta] = { ingresos: 0, vendidas: 0, coste: 0, beneficio: 0 };
            }
            ventasRecetas[nombre].dias[fechaVenta].ingresos += ingresos;
            ventasRecetas[nombre].dias[fechaVenta].vendidas += venta.cantidad;
            ventasRecetas[nombre].dias[fechaVenta].coste += costeVenta;
            ventasRecetas[nombre].dias[fechaVenta].beneficio += (ingresos - costeVenta);
        });

        // Food Cost %
        const foodCost = totalIngresos > 0
            ? ((totalCosteVentas / totalIngresos) * 100).toFixed(1)
            : 0;

        const result = {
            compras: {
                total: totalCompras,
                ingredientes: comprasIngredientes
            },
            ventas: {
                totalIngresos,
                beneficioBruto: totalIngresos - totalCosteVentas,
                recetas: ventasRecetas
            },
            resumen: { foodCost: parseFloat(foodCost) },
            dias
        };

        res.json(result);
    } catch (err) {
        log('error', 'Error en resumen mensual', { error: err.message });
        res.status(500).json({ error: 'Error al obtener resumen mensual' });
    }
});

// --- Manejo de errores 404 ---
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado' });
});

// --- Error Handler Global ---
app.use((err, req, res, next) => {
    log('error', 'Error no manejado', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor crítica' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    log('info', `Servidor iniciado en puerto ${PORT}`);
});
