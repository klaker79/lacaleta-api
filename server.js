const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mindloop-costos-secret-key-2024';

const app = express();
const PORT = 3000;

// Middleware
app.use(cors({
  origin: ['https://klaker79.github.io', 'http://localhost:5500'],
  credentials: true
}));
app.use(express.json());
app.use(express.json());

// Middleware de autenticación
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

// PostgreSQL

// PostgreSQL
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
    console.log('✅ Conectado a PostgreSQL');
    
    // Crear tablas
    await pool.query(`
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
        total_recibido DECIMAL(10, 2)
      );
      
      CREATE TABLE IF NOT EXISTS ventas (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER REFERENCES recetas(id) ON DELETE CASCADE,
        cantidad INTEGER NOT NULL,
        precio_unitario DECIMAL(10, 2) NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
    `);
    console.log('✅ Tablas inicializadas');
  } catch (err) {
    console.error('❌ Error DB:', err.message);
  }
})();
// ========== AUTENTICACIÓN ==========
// Login
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
    console.error('Error login:', err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Registro de nuevo restaurante
app.post('/api/auth/register', async (req, res) => {
  try {
    const { restauranteNombre, email, password, nombreUsuario } = req.body;
    
    if (!restauranteNombre || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    // Verificar si email ya existe
    const existingUser = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }
    
    // Crear restaurante
    const restauranteResult = await pool.query(
      'INSERT INTO restaurantes (nombre, email) VALUES ($1, $2) RETURNING id',
      [restauranteNombre, email]
    );
    const restauranteId = restauranteResult.rows[0].id;
    
    // Crear usuario admin
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
    console.error('Error registro:', err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({ 
    message: '🍽️ La Caleta 102 API',
    version: '2.0.0',
    status: 'running'
  });
});

// ========== INGREDIENTES ==========
app.get('/api/ingredients', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ingredientes WHERE restaurante_id = $1 ORDER BY id', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
            [nombre, finalProveedorId, precio || 0, unidad, finalStockActual, finalStockMinimo, req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/ingredients/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM ingredientes WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ========== INVENTARIO AVANZADO ==========

// GET: Obtener inventario completo con precio medio y stock real
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
        (i.stock_actual - COALESCE(i.stock_real, 0)) as diferencia,
        COALESCE(
          (SELECT 
            SUM(
              (ingrediente->>'cantidad')::numeric * 
              (ingrediente->>'precioUnitario')::numeric
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
              (ingrediente->>'precioUnitario')::numeric
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
    console.error('Error inventario completo:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT: Actualizar stock real de un ingrediente
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
    console.error('Error actualizando stock real:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT: Actualizar múltiples stocks reales a la vez (inventario mensual)
app.put('/api/inventory/bulk-update-stock', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { stocks } = req.body; // Array de { id, stock_real }
    
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
    console.error('Error bulk update:', err);
    res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/recipes/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM recetas WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== PROVEEDORES ==========
app.get('/api/suppliers', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM proveedores WHERE restaurante_id=$1 ORDER BY id', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/suppliers/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM proveedores WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== PEDIDOS ==========
app.get('/api/orders', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pedidos WHERE restaurante_id=$1 ORDER BY fecha DESC', [req.restauranteId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM pedidos WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sales', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { recetaId, cantidad } = req.body;
    
    await client.query('BEGIN');
    
    // Obtener receta con ingredientes
    const recetaResult = await client.query('SELECT * FROM recetas WHERE id = $1', [recetaId]);
    if (recetaResult.rows.length === 0) {
      throw new Error('Receta no encontrada');
    }
    
    const receta = recetaResult.rows[0];
    const precioUnitario = parseFloat(receta.precio_venta);
    const total = precioUnitario * cantidad;

    // Validar stock suficiente antes de vender
    const ingredientesReceta = receta.ingredientes;
    for (const ing of ingredientesReceta) {
      const stockResult = await client.query('SELECT stock_actual, nombre FROM ingredientes WHERE id = $1', [ing.ingredienteId]);
      if (stockResult.rows.length > 0) {
        const stockActual = parseFloat(stockResult.rows[0].stock_actual);
        const stockNecesario = ing.cantidad * cantidad;
        if (stockActual < stockNecesario) {
          throw new Error(`Stock insuficiente de ${stockResult.rows[0].nombre}: necesitas ${stockNecesario}, tienes ${stockActual}`);
        }
      }
    }

    // Registrar venta
    const ventaResult = await client.query(
            'INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, restaurante_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [recetaId, cantidad, precioUnitario, total, req.restauranteId]
        );
    
    // Descontar ingredientes del stock
    const ingredientes = receta.ingredientes;
    for (const ing of ingredientes) {
      await client.query(
        'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2',
        [ing.cantidad * cantidad, ing.ingredienteId]
      );
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

app.delete('/api/sales/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM ventas WHERE id=$1 AND restaurante_id=$2', [req.params.id, req.restauranteId]);
        res.json({ message: 'Eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== BALANCE Y ESTADÍSTICAS ==========
app.get('/api/balance/mes', authMiddleware, async (req, res) => {
  try {
    const { mes, ano } = req.query;
    const mesActual = mes || new Date().getMonth() + 1;
    const anoActual = ano || new Date().getFullYear();

    // Ingresos del mes
    const ventasMes = await pool.query(
            `SELECT COALESCE(SUM(total), 0) as ingresos, COUNT(*) as num_ventas
            FROM ventas
            WHERE EXTRACT(MONTH FROM fecha) = $1 AND EXTRACT(YEAR FROM fecha) = $2 AND restaurante_id = $3`,
            [mesActual, anoActual, req.restauranteId]
        );

    // Costos - calculados desde ingredientes de recetas (usando JSONB)
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

    // Plato más vendido
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

    // Ventas por plato
    const ventasPorPlato = await pool.query(
            `SELECT r.nombre, SUM(v.total) as total_ingresos, SUM(v.cantidad) as cantidad
            FROM ventas v
            JOIN recetas r ON v.receta_id = r.id
            WHERE EXTRACT(MONTH FROM v.fecha) = $1 AND EXTRACT(YEAR FROM v.fecha) = $2 AND v.restaurante_id = $3
            GROUP BY r.nombre
            ORDER BY total_ingresos DESC`,
            [mesActual, anoActual, req.restauranteId]
        );

    // Valor del inventario
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
    console.error('Error obteniendo balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Comparativa mensual
app.get('/api/balance/comparativa', async (req, res) => {
  try {
    const meses = await pool.query(
      `SELECT 
         TO_CHAR(fecha, 'YYYY-MM') as mes,
         SUM(total) as ingresos,
         COUNT(*) as num_ventas
       FROM ventas
       GROUP BY TO_CHAR(fecha, 'YYYY-MM')
       ORDER BY mes DESC
       LIMIT 12`
    );
    
    res.json(meses.rows);
  } catch (error) {
    console.error('Error obteniendo comparativa:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`);
  console.log(`📍 La Caleta 102 Dashboard API v2.0`);
});
