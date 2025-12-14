const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// ========== CONFIGURACIÓN ==========
const JWT_SECRET = process.env.JWT_SECRET || 'mindloop-costos-secret-key-2024';
const PORT = process.env.PORT || 3000;

// CORS: Orígenes permitidos desde variable de entorno o por defecto
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://klaker79.github.io', 'http://localhost:5500', 'http://127.0.0.1:5500'];

const app = express();

// ========== MIDDLEWARE ==========
// CORS configuración mejorada
app.use(cors({
    origin: function (origin, callback) {
        // Permitir requests sin origin (curl, Postman)
        if (!origin) return callback(null, true);

        if (ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            console.log('⛔ CORS bloqueado para:', origin);
            callback(null, false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
}));

// Manejar preflight explícitamente
app.options('*', cors());

// Parser JSON (solo una vez)
app.use(express.json());

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

    // Append to file
    fs.appendFile(LOG_FILE, logEntry + '\n', (err) => {
        if (err) console.error('Error writing to log file:', err);
    });
};

// ========== BASE DE DATOS ==========
const pool = new Pool({
    host: process.env.DB_HOST || 'anais-postgres-2s8h7q',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'db',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || '18061979Anais.',
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
        ultima_actualizacion_stock TIMESTAMP,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

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

        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurante_id INTEGER NOT NULL
      );

      -- Tabla de Ajustes (Detalle del movimiento) - V2 (Fresh Schema)
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

      -- Tabla de Snapshots (Auditoría del estado antes/después) - V2 (Fresh Schema)
      CREATE TABLE IF NOT EXISTS inventory_snapshots_v2 (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        stock_virtual DECIMAL(10, 2) NOT NULL,
        stock_real DECIMAL(10, 2) NOT NULL,
        diferencia DECIMAL(10, 2) NOT NULL,
        restaurante_id INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
      CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
      CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante ON ingredientes(restaurante_id);
    `);
        log('info', 'Tablas inicializadas');
    } catch (err) {
        log('error', 'Error DB', { error: err.message });
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
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        req.restauranteId = decoded.restauranteId;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.rol !== 'admin') {
        log('warn', 'Acceso denegado a ruta protegida', { user: req.user ? req.user.email : 'anon', url: req.originalUrl });
        return res.status(403).json({ error: 'Acceso denegado: Requiere rol de Administrador' });
    }
    next();
};

// ========== ENDPOINTS PÚBLICOS ==========
app.get('/', (req, res) => {
    res.json({
        message: '🍽️ La Caleta 102 API',
        version: '2.1.0',
        status: 'running'
    });
});

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            cors_origins: ALLOWED_ORIGINS
        });
    } catch (e) {
        res.status(503).json({ status: 'unhealthy' });
    }
});

// ========== AUTENTICACIÓN ==========
app.post('/api/auth/login', async (req, res) => {
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

        const token = jwt.sign(
            { userId: user.id, restauranteId: user.restaurante_id, email: user.email, rol: user.rol },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        log('info', 'Login exitoso', { userId: user.id, email });

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
        log('error', 'Error login', { error: err.message });
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { restauranteNombre, email, password, nombreUsuario } = req.body;

        if (!restauranteNombre || !email || !password) {
            return res.status(400).json({ error: 'Todos los campos son requeridos' });
        }

        const existingUser = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'El email ya está registrado' });
        }

        const restauranteResult = await pool.query(
            'INSERT INTO restaurantes (nombre, email) VALUES ($1, $2) RETURNING id',
            [restauranteNombre, email]
        );
        const restauranteId = restauranteResult.rows[0].id;

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await pool.query(
            'INSERT INTO usuarios (restaurante_id, email, password_hash, nombre, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [restauranteId, email, passwordHash, nombreUsuario || 'Admin', 'admin']
        );

        const token = jwt.sign(
            { userId: userResult.rows[0].id, restauranteId, email, rol: 'admin' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        log('info', 'Registro exitoso', { restauranteId, email });

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
        log('error', 'Error registro', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== GESTIÓN DE EQUIPO (MULTI-CUENTA) ==========

// 1. Listar el equipo
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

// 2. Invitar / Crear Usuario (Solo Admin)
app.post('/api/team/invite', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { nombre, email, password, rol } = req.body;

        if (!nombre || !email || !password) {
            return res.status(400).json({ error: 'Faltan datos requeridos (nombre, email, password)' });
        }

        // Verificar si existe el email globalmente (clave única)
        const check = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: 'Este email ya está registrado' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // Rol por defecto 'usuario' si no se especifica
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

// 3. Eliminar Usuario (Solo Admin)
app.delete('/api/team/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const userIdToDelete = parseInt(req.params.id);

        // Evitar auto-borrado
        if (userIdToDelete === req.user.userId) {
            return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
        }

        // Asegurar que el usuario a borrar pertenece al MISMO restaurante
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
        const result = await pool.query('SELECT * FROM ingredientes WHERE restaurante_id = $1 ORDER BY id', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/ingredients', authMiddleware, async (req, res) => {
    try {
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo } = req.body;
        const finalStockActual = stockActual ?? stock_actual ?? 0;
        const finalStockMinimo = stockMinimo ?? stock_minimo ?? 0;
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const result = await pool.query(
            'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [nombre, finalProveedorId, precio || 0, unidad || 'kg', finalStockActual, finalStockMinimo, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/ingredients/:id', authMiddleware, async (req, res) => {
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
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/ingredients/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM ingredientes WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
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

        res.json(result.rows);
    } catch (err) {
        log('error', 'Error inventario completo', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/inventory/:id/stock-real', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { stock_real } = req.body;

        const result = await pool.query(
            `UPDATE ingredientes 
       SET stock_real = $1, 
           ultima_actualizacion_stock = CURRENT_TIMESTAMP 
       WHERE id = $2 AND restaurante_id = $3 
       RETURNING *`,
            [stock_real, id, req.restauranteId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        res.json(result.rows[0]);
    } catch (err) {
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
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// Endpoint para consolidar stock con lógica de Ajustes (ERP)
app.post('/api/inventory/consolidate', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        // adjustments: Array de splits específicos [{ ingrediente_id, cantidad, motivo, notas }]
        // snapshots: Array histórico [{ id (ing_id), stock_virtual, stock_real }]
        // finalStock: Array simple para actualizar el maestro [{ id, stock_real }]
        const { adjustments, snapshots, finalStock } = req.body;

        if (!req.restauranteId) {
            return res.status(401).json({ error: 'No autorizado: Restaurante ID nulo' });
        }

        // Just-in-Time Schema Creation (Asegurar que las tablas existen)
        await client.query(`
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
        `);

        await client.query('BEGIN');

        // 1. Guardar Snapshots (Auditoría V2)
        if (snapshots && Array.isArray(snapshots)) {
            for (const snap of snapshots) {
                // Validación Estricta de Tipos
                const ingId = parseInt(snap.id, 10);
                const real = parseFloat(snap.stock_real);
                const virtual = parseFloat(snap.stock_virtual);

                // Si alguno es NaN, saltamos (o lanzamos error, pero mejor prevenir crash)
                if (isNaN(ingId)) continue;

                // Asegurar valores numéricos seguros (default 0 ya debería venir validado, pero insistimos)
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

        // 2. Guardar Ajustes Desglosados (V2)
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
                     SET stock_actual = $1, -- Actualizamos la referencia oficial
                         stock_real = NULL, -- Limpiamos el conteo físico para la próxima vez
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
        console.error('CRITICAL ERROR in /api/inventory/consolidate:', err); // Log detallado
        res.status(500).json({ error: 'Error interno en la consolidación de datos: ' + err.message });
    } finally {
        client.release();
    }
});

// ========== ANÁLISIS AVANZADO ==========
app.get('/api/analysis/menu-engineering', authMiddleware, async (req, res) => {
    try {
        // 1. Obtener ventas agregadas por receta
        const ventas = await pool.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta, 
                    SUM(v.cantidad) as cantidad_vendida,
                    SUM(v.total) as total_ventas
             FROM ventas v
             JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1
             GROUP BY r.id, r.nombre, r.categoria, r.precio_venta`,
            [req.restauranteId]
        );

        if (ventas.rows.length === 0) {
            return res.json([]);
        }

        // 2. Calcular costes para margen
        const analisis = [];
        const totalVentasRestaurante = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
        const promedioPopularidad = totalVentasRestaurante / ventas.rows.length; // Mix medio

        let sumaMargenes = 0;

        for (const plato of ventas.rows) {
            // Calcular coste (simplificado, idealmente cacheado o pre-calculado)
            const recetaResult = await pool.query('SELECT ingredientes FROM recetas WHERE id = $1', [plato.id]);
            const ingredientes = recetaResult.rows[0].ingredientes;
            let costePlato = 0;
            if (ingredientes) {
                for (const ing of ingredientes) {
                    const ingDb = await pool.query('SELECT precio FROM ingredientes WHERE id = $1', [ing.ingredienteId]);
                    if (ingDb.rows.length > 0) {
                        costePlato += parseFloat(ingDb.rows[0].precio) * ing.cantidad;
                    }
                }
            }

            const margenContribucion = parseFloat(plato.precio_venta) - costePlato;
            sumaMargenes += margenContribucion * parseFloat(plato.cantidad_vendida);

            analisis.push({
                ...plato,
                coste: costePlato,
                margen: margenContribucion,
                popularidad: parseFloat(plato.cantidad_vendida)
            });
        }

        const promedioMargen = totalVentasRestaurante > 0 ? sumaMargenes / totalVentasRestaurante : 0;

        // 3. Clasificar BCG
        // Estrella: Alta Popularidad, Alto Margen
        // Caballo: Alta Popularidad, Bajo Margen
        // Puzzle: Baja Popularidad, Alto Margen
        // Perro: Baja Popularidad, Bajo Margen

        const resultado = analisis.map(p => {
            const esPopular = p.popularidad >= (promedioPopularidad * 0.7); // Umbral del 70% del promedio (común en ingeniería de menu)
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
        console.error(err);
        res.status(500).json({ error: 'Error analizando menú' });
    }
});

// ========== RECETAS ==========
app.get('/api/recipes', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM recetas WHERE restaurante_id=$1 ORDER BY id', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
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
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/recipes/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM recetas WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== PROVEEDORES ==========
app.get('/api/suppliers', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM proveedores WHERE restaurante_id=$1 ORDER BY id', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
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
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/suppliers/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM proveedores WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== PEDIDOS ==========
app.get('/api/orders', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pedidos WHERE restaurante_id=$1 ORDER BY fecha DESC', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
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
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/orders/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado, ingredientes, totalRecibido, fechaRecepcion } = req.body;
        const result = await pool.query(
            'UPDATE pedidos SET estado=$1, ingredientes=$2, total_recibido=$3, fecha_recepcion=$4 WHERE id=$5 AND restaurante_id=$6 RETURNING *',
            [estado, JSON.stringify(ingredientes), totalRecibido, fechaRecepcion || new Date(), id, req.restauranteId]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM pedidos WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== VENTAS ==========
app.get('/api/sales', authMiddleware, async (req, res) => {
    try {
        const { fecha } = req.query;
        let query = 'SELECT v.*, r.nombre as receta_nombre FROM ventas v LEFT JOIN recetas r ON v.receta_id = r.id WHERE v.restaurante_id = $1';
        let params = [req.restauranteId];

        if (fecha) {
            query += ' AND DATE(v.fecha) = $2';
            params.push(fecha);
        }

        query += ' ORDER BY v.fecha DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/sales', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { recetaId, cantidad } = req.body;

        await client.query('BEGIN');

        const recetaResult = await client.query('SELECT * FROM recetas WHERE id = $1 AND restaurante_id = $2', [recetaId, req.restauranteId]);
        if (recetaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Receta no encontrada' });
        }

        const receta = recetaResult.rows[0];
        const precioUnitario = parseFloat(receta.precio_venta);
        const total = precioUnitario * cantidad;

        // Validar stock
        const ingredientesReceta = receta.ingredientes;
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

        // Registrar venta
        const ventaResult = await client.query(
            'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, restaurante_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [recetaId, cantidad, precioUnitario, total, req.restauranteId]
        );

        // Descontar stock
        for (const ing of ingredientesReceta) {
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2',
                [ing.cantidad * cantidad, ing.ingredienteId]
            );
        }

        await client.query('COMMIT');
        res.status(201).json(ventaResult.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

app.delete('/api/sales/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM ventas WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/sales/bulk', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ventas } = req.body; // Array de { receta: "nombre", cantidad: N, total: M, fecha: "ISO" }

        if (!Array.isArray(ventas)) {
            return res.status(400).json({ error: 'Formato inválido: se esperaba un array "ventas"' });
        }

        await client.query('BEGIN');

        const resultados = {
            procesados: 0,
            fallidos: 0,
            errores: []
        };

        // 1. Obtener todas las recetas del restaurante para búsqueda rápida
        const recetasResult = await client.query('SELECT id, nombre, precio_venta, ingredientes FROM recetas WHERE restaurante_id = $1', [req.restauranteId]);
        const recetasMap = new Map();
        recetasResult.rows.forEach(r => {
            recetasMap.set(r.nombre.toLowerCase().trim(), r);
        });

        for (const venta of ventas) {
            const nombreReceta = (venta.receta || '').toLowerCase().trim();
            const cantidad = parseInt(venta.cantidad) || 1;

            // Buscar receta (match exacto insensible a mayúsculas)
            const receta = recetasMap.get(nombreReceta);

            if (!receta) {
                resultados.fallidos++;
                resultados.errores.push({ receta: venta.receta, error: 'Receta no encontrada' });
                continue;
            }

            const total = parseFloat(venta.total) || (parseFloat(receta.precio_venta) * cantidad);
            const fecha = venta.fecha || new Date().toISOString();

            // 2. Registrar venta
            await client.query(
                'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [receta.id, cantidad, receta.precio_venta, total, fecha, req.restauranteId]
            );

            // 3. Descontar stock (Permitir negativo)
            const ingredientesReceta = receta.ingredientes; // JSONB array
            if (Array.isArray(ingredientesReceta)) {
                for (const ing of ingredientesReceta) {
                    await client.query(
                        'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2 AND restaurante_id = $3',
                        [ing.cantidad * cantidad, ing.ingredienteId, req.restauranteId]
                    );
                }
            }

            resultados.procesados++;
        }

        await client.query('COMMIT');
        res.json(resultados);

    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error carga masiva ventas', { error: err.message });
        res.status(500).json({ error: 'Error interno procesando carga masiva' });
    } finally {
        client.release();
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
       WHERE EXTRACT(MONTH FROM fecha) = $1 AND EXTRACT(YEAR FROM fecha) = $2 AND restaurante_id = $3`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasDetalle = await pool.query(
            `SELECT v.cantidad, r.ingredientes
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3`,
            [mesActual, anoActual, req.restauranteId]
        );

        let costos = 0;
        for (const venta of ventasDetalle.rows) {
            const ingredientes = venta.ingredientes;
            for (const ing of ingredientes) {
                const ingResult = await pool.query('SELECT precio FROM ingredientes WHERE id = $1', [ing.ingredienteId]);
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
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3
       GROUP BY r.nombre
       ORDER BY total_vendido DESC
       LIMIT 1`,
            [mesActual, anoActual, req.restauranteId]
        );

        const ventasPorPlato = await pool.query(
            `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
       FROM ventas v
       JOIN recetas r ON v.receta_id = r.id
       WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3
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
       WHERE restaurante_id = $1
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`,
            [req.restauranteId]
        );

        res.json(meses.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== 404 ==========
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ========== INICIAR SERVIDOR ==========
app.listen(PORT, '0.0.0.0', () => {
    log('info', 'Servidor iniciado', { port: PORT, version: '2.1.0', cors: ALLOWED_ORIGINS });
    console.log(`🚀 API corriendo en puerto ${PORT}`);
    console.log(`📍 La Caleta 102 Dashboard API v2.1`);
});
