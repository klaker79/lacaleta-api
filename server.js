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

// CORS: Orígenes permitidos
const DEFAULT_ORIGINS = [
    'https://klaker79.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];
const ENV_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [];
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS])];

const app = express();

// ========== MIDDLEWARE ==========
app.use(cors({
    origin: function (origin, callback) {
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

app.options('*', cors());
app.use(express.json());

// Logging
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

// ========== BASE DE DATOS ==========
const pool = new Pool({
    host: process.env.DB_HOST || 'anais-postgres-2s8h7q',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'db',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || '18061979Anais.',
});

// Inicializar DB
(async () => {
    try {
        await pool.query('SELECT NOW()');
        log('info', 'Conectado a PostgreSQL');

        // Crear tablas existentes
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

            CREATE TABLE IF NOT EXISTS recetas (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255) NOT NULL,
                codigo VARCHAR(50),
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

            -- =============================================
            -- NUEVA TABLA: REGISTROS DIARIOS (CIERRES)
            -- =============================================
            CREATE TABLE IF NOT EXISTS daily_records (
                id SERIAL PRIMARY KEY,
                fecha DATE NOT NULL,
                ventas_total DECIMAL(12, 2) DEFAULT 0,
                ventas_count INTEGER DEFAULT 0,
                compras_total DECIMAL(12, 2) DEFAULT 0,
                compras_count INTEGER DEFAULT 0,
                margen_bruto DECIMAL(12, 2) DEFAULT 0,
                food_cost_percent DECIMAL(5, 2) DEFAULT 0,
                objetivo_diario DECIMAL(12, 2) DEFAULT 0,
                objetivo_cumplido BOOLEAN DEFAULT false,
                gastos_fijos_prorrateados DECIMAL(12, 2) DEFAULT 0,
                beneficio_neto DECIMAL(12, 2) DEFAULT 0,
                notas TEXT,
                cerrado BOOLEAN DEFAULT false,
                restaurante_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(fecha, restaurante_id)
            );

            -- Tabla para configuración de gastos fijos por restaurante
            CREATE TABLE IF NOT EXISTS config_gastos (
                id SERIAL PRIMARY KEY,
                restaurante_id INTEGER NOT NULL UNIQUE,
                alquiler DECIMAL(10, 2) DEFAULT 1000,
                personal DECIMAL(10, 2) DEFAULT 3000,
                suministros DECIMAL(10, 2) DEFAULT 500,
                otros DECIMAL(10, 2) DEFAULT 300,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Índices para optimización
            CREATE INDEX IF NOT EXISTS idx_daily_records_fecha ON daily_records(fecha);
            CREATE INDEX IF NOT EXISTS idx_daily_records_restaurante ON daily_records(restaurante_id);
            CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
            CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
            CREATE INDEX IF NOT EXISTS idx_pedidos_fecha ON pedidos(fecha);
            CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
            CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante ON ingredientes(restaurante_id);
        `);

        // Migración: añadir columna codigo a recetas si no existe
        try {
            await pool.query(`
                DO $$ 
                BEGIN 
                    IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'recetas' AND column_name = 'codigo') THEN 
                        ALTER TABLE recetas ADD COLUMN codigo VARCHAR(50); 
                    END IF; 
                END $$;
            `);
        } catch (e) {
            log('warn', 'Migración columna codigo', { error: e.message });
        }

        log('info', 'Tablas inicializadas (incluida daily_records)');
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
        return res.status(403).json({ error: 'Acceso denegado: Requiere rol de Administrador' });
    }
    next();
};

// ========== ENDPOINTS PÚBLICOS ==========
app.get('/', (req, res) => {
    res.json({
        message: '🍽️ MindLoop CostOS API',
        version: '2.2.0',
        status: 'running',
        features: ['daily-tracking', 'inventory', 'sales', 'orders']
    });
});

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.2.0'
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
                restaurante: user.restaurante_nombre,
                restauranteId: user.restaurante_id
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

        // Crear configuración de gastos por defecto
        await pool.query(
            'INSERT INTO config_gastos (restaurante_id) VALUES ($1) ON CONFLICT DO NOTHING',
            [restauranteId]
        );

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
                restaurante: restauranteNombre,
                restauranteId
            }
        });
    } catch (err) {
        log('error', 'Error registro', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== GESTIÓN DE EQUIPO ==========
app.get('/api/team', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, nombre, email, rol, created_at as fecha_registro FROM usuarios WHERE restaurante_id = $1 ORDER BY created_at DESC',
            [req.restauranteId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/team/invite', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { nombre, email, password, rol } = req.body;
        if (!nombre || !email || !password) {
            return res.status(400).json({ error: 'Faltan datos requeridos' });
        }

        const check = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: 'Este email ya está registrado' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO usuarios (restaurante_id, nombre, email, password_hash, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id, nombre, email, rol',
            [req.restauranteId, nombre, email, passwordHash, rol || 'usuario']
        );

        res.json(result.rows[0]);
    } catch (err) {
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
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// =============================================
// ========== CONTROL DIARIO (NUEVO) ==========
// =============================================

// Obtener configuración de gastos fijos
app.get('/api/config/gastos', authMiddleware, async (req, res) => {
    try {
        let result = await pool.query(
            'SELECT * FROM config_gastos WHERE restaurante_id = $1',
            [req.restauranteId]
        );

        if (result.rows.length === 0) {
            // Crear configuración por defecto si no existe
            result = await pool.query(
                'INSERT INTO config_gastos (restaurante_id) VALUES ($1) RETURNING *',
                [req.restauranteId]
            );
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Actualizar configuración de gastos fijos
app.put('/api/config/gastos', authMiddleware, async (req, res) => {
    try {
        const { alquiler, personal, suministros, otros } = req.body;

        const result = await pool.query(
            `INSERT INTO config_gastos (restaurante_id, alquiler, personal, suministros, otros, updated_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (restaurante_id) 
             DO UPDATE SET alquiler = $2, personal = $3, suministros = $4, otros = $5, updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [req.restauranteId, alquiler || 0, personal || 0, suministros || 0, otros || 0]
        );

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Obtener datos de un día específico (calculados en tiempo real)
app.get('/api/daily/:fecha', authMiddleware, async (req, res) => {
    try {
        const { fecha } = req.params;

        // Obtener ventas del día
        const ventasResult = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
             FROM ventas 
             WHERE DATE(fecha) = $1 AND restaurante_id = $2`,
            [fecha, req.restauranteId]
        );

        // Obtener compras del día
        const comprasResult = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
             FROM pedidos 
             WHERE DATE(fecha) = $1 AND restaurante_id = $2 AND estado = 'recibido'`,
            [fecha, req.restauranteId]
        );

        // Obtener configuración de gastos
        const gastosResult = await pool.query(
            'SELECT * FROM config_gastos WHERE restaurante_id = $1',
            [req.restauranteId]
        );

        const gastos = gastosResult.rows[0] || { alquiler: 1000, personal: 3000, suministros: 500, otros: 300 };
        const gastosFijosMensuales = parseFloat(gastos.alquiler) + parseFloat(gastos.personal) + 
                                      parseFloat(gastos.suministros) + parseFloat(gastos.otros);

        // Calcular días del mes para prorrateo
        const fechaObj = new Date(fecha);
        const diasMes = new Date(fechaObj.getFullYear(), fechaObj.getMonth() + 1, 0).getDate();
        const objetivoDiario = gastosFijosMensuales / diasMes;

        const ventasTotal = parseFloat(ventasResult.rows[0].total);
        const comprasTotal = parseFloat(comprasResult.rows[0].total);
        const margenBruto = ventasTotal - comprasTotal;
        const foodCostPercent = ventasTotal > 0 ? (comprasTotal / ventasTotal) * 100 : 0;
        const objetivoCumplido = ventasTotal >= objetivoDiario;
        const gastosFijosProrrateados = gastosFijosMensuales / diasMes;
        const beneficioNeto = margenBruto - gastosFijosProrrateados;

        // Buscar registro existente o devolver datos calculados
        const recordResult = await pool.query(
            'SELECT * FROM daily_records WHERE fecha = $1 AND restaurante_id = $2',
            [fecha, req.restauranteId]
        );

        const response = {
            fecha,
            ventas_total: ventasTotal,
            ventas_count: parseInt(ventasResult.rows[0].count),
            compras_total: comprasTotal,
            compras_count: parseInt(comprasResult.rows[0].count),
            margen_bruto: margenBruto,
            food_cost_percent: foodCostPercent,
            objetivo_diario: objetivoDiario,
            objetivo_cumplido: objetivoCumplido,
            gastos_fijos_prorrateados: gastosFijosProrrateados,
            beneficio_neto: beneficioNeto,
            cerrado: recordResult.rows[0]?.cerrado || false,
            notas: recordResult.rows[0]?.notas || ''
        };

        res.json(response);
    } catch (err) {
        log('error', 'Error obteniendo datos diarios', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// Guardar/Actualizar registro diario (cierre automático o manual)
app.post('/api/daily/:fecha', authMiddleware, async (req, res) => {
    try {
        const { fecha } = req.params;
        const { notas, cerrado } = req.body;

        // Calcular datos actuales
        const ventasResult = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
             FROM ventas WHERE DATE(fecha) = $1 AND restaurante_id = $2`,
            [fecha, req.restauranteId]
        );

        const comprasResult = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
             FROM pedidos WHERE DATE(fecha) = $1 AND restaurante_id = $2 AND estado = 'recibido'`,
            [fecha, req.restauranteId]
        );

        const gastosResult = await pool.query(
            'SELECT * FROM config_gastos WHERE restaurante_id = $1',
            [req.restauranteId]
        );

        const gastos = gastosResult.rows[0] || { alquiler: 1000, personal: 3000, suministros: 500, otros: 300 };
        const gastosFijosMensuales = parseFloat(gastos.alquiler) + parseFloat(gastos.personal) + 
                                      parseFloat(gastos.suministros) + parseFloat(gastos.otros);

        const fechaObj = new Date(fecha);
        const diasMes = new Date(fechaObj.getFullYear(), fechaObj.getMonth() + 1, 0).getDate();
        const objetivoDiario = gastosFijosMensuales / diasMes;

        const ventasTotal = parseFloat(ventasResult.rows[0].total);
        const comprasTotal = parseFloat(comprasResult.rows[0].total);
        const margenBruto = ventasTotal - comprasTotal;
        const foodCostPercent = ventasTotal > 0 ? (comprasTotal / ventasTotal) * 100 : 0;
        const objetivoCumplido = ventasTotal >= objetivoDiario;
        const gastosFijosProrrateados = gastosFijosMensuales / diasMes;
        const beneficioNeto = margenBruto - gastosFijosProrrateados;

        // Upsert del registro diario
        const result = await pool.query(
            `INSERT INTO daily_records 
             (fecha, ventas_total, ventas_count, compras_total, compras_count, margen_bruto, 
              food_cost_percent, objetivo_diario, objetivo_cumplido, gastos_fijos_prorrateados, 
              beneficio_neto, notas, cerrado, restaurante_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
             ON CONFLICT (fecha, restaurante_id) 
             DO UPDATE SET 
                ventas_total = $2, ventas_count = $3, compras_total = $4, compras_count = $5,
                margen_bruto = $6, food_cost_percent = $7, objetivo_diario = $8, objetivo_cumplido = $9,
                gastos_fijos_prorrateados = $10, beneficio_neto = $11, notas = COALESCE($12, daily_records.notas),
                cerrado = COALESCE($13, daily_records.cerrado), updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [fecha, ventasTotal, ventasResult.rows[0].count, comprasTotal, comprasResult.rows[0].count,
             margenBruto, foodCostPercent, objetivoDiario, objetivoCumplido, gastosFijosProrrateados,
             beneficioNeto, notas, cerrado, req.restauranteId]
        );

        log('info', 'Registro diario guardado', { fecha, restauranteId: req.restauranteId });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error guardando registro diario', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

// Obtener historial de registros diarios
app.get('/api/daily', authMiddleware, async (req, res) => {
    try {
        const { mes, ano, limit } = req.query;
        
        let query = `
            SELECT * FROM daily_records 
            WHERE restaurante_id = $1
        `;
        const params = [req.restauranteId];
        let paramIndex = 2;

        if (mes && ano) {
            query += ` AND EXTRACT(MONTH FROM fecha) = $${paramIndex} AND EXTRACT(YEAR FROM fecha) = $${paramIndex + 1}`;
            params.push(mes, ano);
            paramIndex += 2;
        }

        query += ` ORDER BY fecha DESC`;

        if (limit) {
            query += ` LIMIT $${paramIndex}`;
            params.push(parseInt(limit));
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Obtener resumen mensual (desde registros diarios)
app.get('/api/daily/summary/month', authMiddleware, async (req, res) => {
    try {
        const { mes, ano } = req.query;
        const mesActual = mes || new Date().getMonth() + 1;
        const anoActual = ano || new Date().getFullYear();

        const result = await pool.query(
            `SELECT 
                COUNT(*) as dias_registrados,
                COALESCE(SUM(ventas_total), 0) as total_ventas,
                COALESCE(SUM(compras_total), 0) as total_compras,
                COALESCE(SUM(margen_bruto), 0) as total_margen,
                COALESCE(AVG(food_cost_percent), 0) as avg_food_cost,
                COALESCE(SUM(beneficio_neto), 0) as total_beneficio,
                COUNT(CASE WHEN objetivo_cumplido THEN 1 END) as dias_objetivo_cumplido
             FROM daily_records
             WHERE EXTRACT(MONTH FROM fecha) = $1 
               AND EXTRACT(YEAR FROM fecha) = $2 
               AND restaurante_id = $3`,
            [mesActual, anoActual, req.restauranteId]
        );

        // Obtener configuración de gastos
        const gastosResult = await pool.query(
            'SELECT * FROM config_gastos WHERE restaurante_id = $1',
            [req.restauranteId]
        );

        const gastos = gastosResult.rows[0] || { alquiler: 1000, personal: 3000, suministros: 500, otros: 300 };
        const gastosFijosMensuales = parseFloat(gastos.alquiler) + parseFloat(gastos.personal) + 
                                      parseFloat(gastos.suministros) + parseFloat(gastos.otros);

        const summary = result.rows[0];
        const totalVentas = parseFloat(summary.total_ventas);
        const totalMargen = parseFloat(summary.total_margen);
        const beneficioReal = totalMargen - gastosFijosMensuales;
        
        // Break-even
        const margenPorcentaje = totalVentas > 0 ? totalMargen / totalVentas : 0.7;
        const breakEven = margenPorcentaje > 0 ? gastosFijosMensuales / margenPorcentaje : 0;

        res.json({
            mes: mesActual,
            ano: anoActual,
            dias_registrados: parseInt(summary.dias_registrados),
            total_ventas: totalVentas,
            total_compras: parseFloat(summary.total_compras),
            total_margen: totalMargen,
            avg_food_cost: parseFloat(summary.avg_food_cost),
            gastos_fijos: gastosFijosMensuales,
            beneficio_neto: beneficioReal,
            rentabilidad: totalVentas > 0 ? (beneficioReal / totalVentas) * 100 : 0,
            break_even_mensual: breakEven,
            break_even_diario: breakEven / 30,
            dias_objetivo_cumplido: parseInt(summary.dias_objetivo_cumplido)
        });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Obtener datos de últimos N días para gráfico
app.get('/api/daily/chart/:dias', authMiddleware, async (req, res) => {
    try {
        const dias = parseInt(req.params.dias) || 7;

        const result = await pool.query(
            `SELECT fecha, ventas_total, compras_total, margen_bruto, objetivo_cumplido
             FROM daily_records
             WHERE restaurante_id = $1 AND fecha >= CURRENT_DATE - INTERVAL '${dias} days'
             ORDER BY fecha ASC`,
            [req.restauranteId]
        );

        res.json(result.rows);
    } catch (err) {
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
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia } = req.body;
        const finalStockActual = stockActual ?? stock_actual ?? 0;
        const finalStockMinimo = stockMinimo ?? stock_minimo ?? 0;
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const finalFamilia = familia || 'alimento';

        const result = await pool.query(
            'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo, familia, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [nombre, finalProveedorId, precio || 0, unidad || 'kg', finalStockActual, finalStockMinimo, finalFamilia, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/ingredients/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, proveedorId, proveedor_id, precio, unidad, stockActual, stock_actual, stockMinimo, stock_minimo, familia } = req.body;
        const finalStockActual = stockActual ?? stock_actual ?? 0;
        const finalStockMinimo = stockMinimo ?? stock_minimo ?? 0;
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const finalFamilia = familia || 'alimento';

        const result = await pool.query(
            'UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, stock_actual=$5, stock_minimo=$6, familia=$7 WHERE id=$8 AND restaurante_id=$9 RETURNING *',
            [nombre, finalProveedorId, precio || 0, unidad, finalStockActual, finalStockMinimo, finalFamilia, id, req.restauranteId]
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
                i.id, i.nombre, i.unidad, i.stock_actual as stock_virtual, i.stock_real,
                i.stock_minimo, i.proveedor_id, i.ultima_actualizacion_stock,
                CASE WHEN i.stock_real IS NULL THEN NULL ELSE (i.stock_real - i.stock_actual) END as diferencia,
                COALESCE(i.precio, 0) as precio_medio,
                (i.stock_actual * COALESCE(i.precio, 0)) as valor_stock
            FROM ingredientes i
            WHERE i.restaurante_id = $1
            ORDER BY i.id
        `, [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/inventory/consolidate', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { adjustments, snapshots, finalStock } = req.body;
        await client.query('BEGIN');

        const updated = [];
        if (finalStock && Array.isArray(finalStock)) {
            for (const item of finalStock) {
                const result = await client.query(
                    `UPDATE ingredientes SET stock_actual = $1, stock_real = NULL, ultima_actualizacion_stock = CURRENT_TIMESTAMP
                     WHERE id = $2 AND restaurante_id = $3 RETURNING *`,
                    [item.stock_real, item.id, req.restauranteId]
                );
                if (result.rows.length > 0) updated.push(result.rows[0]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, updated: updated.length });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
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
        const { nombre, codigo, categoria, precio_venta, porciones, ingredientes } = req.body;
        const result = await pool.query(
            'INSERT INTO recetas (nombre, codigo, categoria, precio_venta, porciones, ingredientes, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [nombre, codigo || null, categoria || 'principal', precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/recipes/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, codigo, categoria, precio_venta, porciones, ingredientes } = req.body;
        const result = await pool.query(
            'UPDATE recetas SET nombre=$1, codigo=$2, categoria=$3, precio_venta=$4, porciones=$5, ingredientes=$6 WHERE id=$7 AND restaurante_id=$8 RETURNING *',
            [nombre, codigo || null, categoria, precio_venta || 0, porciones || 1, JSON.stringify(ingredientes || []), id, req.restauranteId]
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
        res.json(result.rows[0] || {});
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

        // Auto-actualizar registro diario
        await actualizarRegistroDiario(req.restauranteId, fecha, pool);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

app.put('/api/orders/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado, ingredientes, totalRecibido, fechaRecepcion } = req.body;
        
        // Obtener fecha del pedido para actualizar registro diario
        const pedidoResult = await pool.query('SELECT fecha FROM pedidos WHERE id = $1', [id]);
        const fechaPedido = pedidoResult.rows[0]?.fecha;

        const result = await pool.query(
            'UPDATE pedidos SET estado=$1, ingredientes=$2, total_recibido=$3, fecha_recepcion=$4 WHERE id=$5 AND restaurante_id=$6 RETURNING *',
            [estado, JSON.stringify(ingredientes), totalRecibido, fechaRecepcion || new Date(), id, req.restauranteId]
        );

        // Auto-actualizar registro diario
        if (fechaPedido) {
            await actualizarRegistroDiario(req.restauranteId, fechaPedido, pool);
        }

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

        // Registrar venta
        const ventaResult = await client.query(
            'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, restaurante_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [recetaId, cantidad, precioUnitario, total, req.restauranteId]
        );

        // Descontar stock
        const ingredientesReceta = receta.ingredientes;
        for (const ing of ingredientesReceta) {
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2',
                [ing.cantidad * cantidad, ing.ingredienteId]
            );
        }

        await client.query('COMMIT');

        // Auto-actualizar registro diario
        const hoy = new Date().toISOString().split('T')[0];
        await actualizarRegistroDiario(req.restauranteId, hoy, pool);

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

// ========== ANÁLISIS ==========
app.get('/api/analysis/menu-engineering', authMiddleware, async (req, res) => {
    try {
        const ventas = await pool.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta, 
                    SUM(v.cantidad) as cantidad_vendida, SUM(v.total) as total_ventas
             FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 GROUP BY r.id, r.nombre, r.categoria, r.precio_venta`,
            [req.restauranteId]
        );

        if (ventas.rows.length === 0) return res.json([]);

        const analisis = [];
        const totalVentas = ventas.rows.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
        const promedioPopularidad = totalVentas / ventas.rows.length;
        let sumaMargenes = 0;

        for (const plato of ventas.rows) {
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

            const margen = parseFloat(plato.precio_venta) - costePlato;
            sumaMargenes += margen * parseFloat(plato.cantidad_vendida);

            analisis.push({
                ...plato,
                coste: costePlato,
                margen,
                popularidad: parseFloat(plato.cantidad_vendida)
            });
        }

        const promedioMargen = totalVentas > 0 ? sumaMargenes / totalVentas : 0;

        const resultado = analisis.map(p => {
            const esPopular = p.popularidad >= promedioPopularidad * 0.7;
            const esRentable = p.margen >= promedioMargen;

            let clasificacion = 'perro';
            if (esPopular && esRentable) clasificacion = 'estrella';
            else if (esPopular && !esRentable) clasificacion = 'caballo';
            else if (!esPopular && esRentable) clasificacion = 'puzzle';

            return { ...p, clasificacion };
        });

        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ========== FUNCIÓN AUXILIAR: ACTUALIZAR REGISTRO DIARIO ==========
async function actualizarRegistroDiario(restauranteId, fecha, poolConn) {
    try {
        const fechaStr = typeof fecha === 'string' ? fecha.split('T')[0] : new Date(fecha).toISOString().split('T')[0];

        // Obtener totales del día
        const ventasResult = await poolConn.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
             FROM ventas WHERE DATE(fecha) = $1 AND restaurante_id = $2`,
            [fechaStr, restauranteId]
        );

        const comprasResult = await poolConn.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count 
             FROM pedidos WHERE DATE(fecha) = $1 AND restaurante_id = $2 AND estado = 'recibido'`,
            [fechaStr, restauranteId]
        );

        const gastosResult = await poolConn.query(
            'SELECT * FROM config_gastos WHERE restaurante_id = $1',
            [restauranteId]
        );

        const gastos = gastosResult.rows[0] || { alquiler: 1000, personal: 3000, suministros: 500, otros: 300 };
        const gastosFijosMensuales = parseFloat(gastos.alquiler || 0) + parseFloat(gastos.personal || 0) + 
                                      parseFloat(gastos.suministros || 0) + parseFloat(gastos.otros || 0);

        const fechaObj = new Date(fechaStr);
        const diasMes = new Date(fechaObj.getFullYear(), fechaObj.getMonth() + 1, 0).getDate();
        const objetivoDiario = gastosFijosMensuales / diasMes;

        const ventasTotal = parseFloat(ventasResult.rows[0].total);
        const comprasTotal = parseFloat(comprasResult.rows[0].total);
        const margenBruto = ventasTotal - comprasTotal;
        const foodCostPercent = ventasTotal > 0 ? (comprasTotal / ventasTotal) * 100 : 0;
        const objetivoCumplido = ventasTotal >= objetivoDiario;
        const gastosFijosProrrateados = gastosFijosMensuales / diasMes;
        const beneficioNeto = margenBruto - gastosFijosProrrateados;

        await poolConn.query(
            `INSERT INTO daily_records 
             (fecha, ventas_total, ventas_count, compras_total, compras_count, margen_bruto, 
              food_cost_percent, objetivo_diario, objetivo_cumplido, gastos_fijos_prorrateados, 
              beneficio_neto, restaurante_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
             ON CONFLICT (fecha, restaurante_id) 
             DO UPDATE SET 
                ventas_total = $2, ventas_count = $3, compras_total = $4, compras_count = $5,
                margen_bruto = $6, food_cost_percent = $7, objetivo_diario = $8, objetivo_cumplido = $9,
                gastos_fijos_prorrateados = $10, beneficio_neto = $11, updated_at = CURRENT_TIMESTAMP`,
            [fechaStr, ventasTotal, ventasResult.rows[0].count, comprasTotal, comprasResult.rows[0].count,
             margenBruto, foodCostPercent, objetivoDiario, objetivoCumplido, gastosFijosProrrateados,
             beneficioNeto, restauranteId]
        );

        log('info', 'Registro diario auto-actualizado', { fecha: fechaStr, restauranteId });
    } catch (err) {
        log('error', 'Error actualizando registro diario', { error: err.message });
    }
}

// ========== 404 ==========
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ========== INICIAR SERVIDOR ==========
app.listen(PORT, '0.0.0.0', () => {
    log('info', 'Servidor iniciado', { port: PORT, version: '2.2.0' });
    console.log(`🚀 MindLoop CostOS API v2.2.0 corriendo en puerto ${PORT}`);
});
