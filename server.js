const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuración de PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS.split(','),
  credentials: true
}));
app.use(express.json());

// Test de conexión
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error conectando a PostgreSQL:', err.stack);
  } else {
    console.log('✅ Conectado a PostgreSQL');
    release();
  }
});

// ==================== PROVEEDORES ====================

// GET /api/proveedores - Obtener todos los proveedores
app.get('/api/proveedores', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proveedores ORDER BY nombre');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener proveedores' });
  }
});

// POST /api/proveedores - Crear proveedor
app.post('/api/proveedores', async (req, res) => {
  const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      'INSERT INTO proveedores (nombre, contacto, telefono, email, direccion, notas) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [nombre, contacto, telefono, email, direccion, notas]
    );
    
    const proveedorId = result.rows[0].id;
    
    // Insertar ingredientes asociados
    if (ingredientes && ingredientes.length > 0) {
      for (const ingId of ingredientes) {
        await client.query(
          'INSERT INTO proveedores_ingredientes (proveedor_id, ingrediente_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [proveedorId, ingId]
        );
      }
    }
    
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al crear proveedor' });
  } finally {
    client.release();
  }
});

// PUT /api/proveedores/:id - Actualizar proveedor
app.put('/api/proveedores/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      'UPDATE proveedores SET nombre=$1, contacto=$2, telefono=$3, email=$4, direccion=$5, notas=$6 WHERE id=$7 RETURNING *',
      [nombre, contacto, telefono, email, direccion, notas, id]
    );
    
    // Actualizar ingredientes asociados
    await client.query('DELETE FROM proveedores_ingredientes WHERE proveedor_id=$1', [id]);
    
    if (ingredientes && ingredientes.length > 0) {
      for (const ingId of ingredientes) {
        await client.query(
          'INSERT INTO proveedores_ingredientes (proveedor_id, ingrediente_id) VALUES ($1, $2)',
          [id, ingId]
        );
      }
    }
    
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar proveedor' });
  } finally {
    client.release();
  }
});

// DELETE /api/proveedores/:id - Eliminar proveedor
app.delete('/api/proveedores/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM proveedores WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar proveedor' });
  }
});

// GET /api/proveedores/:id/ingredientes - Obtener ingredientes de un proveedor
app.get('/api/proveedores/:id/ingredientes', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT ingrediente_id FROM proveedores_ingredientes WHERE proveedor_id=$1',
      [id]
    );
    res.json(result.rows.map(r => r.ingrediente_id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener ingredientes del proveedor' });
  }
});

// ==================== INGREDIENTES ====================

// GET /api/ingredientes - Obtener todos los ingredientes
app.get('/api/ingredientes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ingredientes ORDER BY nombre');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener ingredientes' });
  }
});

// POST /api/ingredientes - Crear ingrediente
app.post('/api/ingredientes', async (req, res) => {
  const { nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [nombre, proveedor_id || null, precio, unidad, stock_actual, stock_minimo]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear ingrediente' });
  }
});

// PUT /api/ingredientes/:id - Actualizar ingrediente
app.put('/api/ingredientes/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, proveedor_id, precio, unidad, stock_actual, stock_minimo } = req.body;
  try {
    const result = await pool.query(
      'UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, stock_actual=$5, stock_minimo=$6 WHERE id=$7 RETURNING *',
      [nombre, proveedor_id || null, precio, unidad, stock_actual, stock_minimo, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar ingrediente' });
  }
});

// DELETE /api/ingredientes/:id - Eliminar ingrediente
app.delete('/api/ingredientes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM ingredientes WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar ingrediente' });
  }
});

// ==================== RECETAS ====================

// GET /api/recetas - Obtener todas las recetas con sus ingredientes
app.get('/api/recetas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM recetas ORDER BY nombre');
    const recetas = result.rows;
    
    // Obtener ingredientes de cada receta
    for (const receta of recetas) {
      const ingResult = await pool.query(
        'SELECT ingrediente_id, cantidad FROM recetas_ingredientes WHERE receta_id=$1',
        [receta.id]
      );
      receta.ingredientes = ingResult.rows;
    }
    
    res.json(recetas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener recetas' });
  }
});

// POST /api/recetas - Crear receta
app.post('/api/recetas', async (req, res) => {
  const { nombre, categoria, precio_venta, porciones, ingredientes } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      'INSERT INTO recetas (nombre, categoria, precio_venta, porciones) VALUES ($1, $2, $3, $4) RETURNING *',
      [nombre, categoria, precio_venta, porciones]
    );
    
    const recetaId = result.rows[0].id;
    
    // Insertar ingredientes
    if (ingredientes && ingredientes.length > 0) {
      for (const ing of ingredientes) {
        await client.query(
          'INSERT INTO recetas_ingredientes (receta_id, ingrediente_id, cantidad) VALUES ($1, $2, $3)',
          [recetaId, ing.ingrediente_id, ing.cantidad]
        );
      }
    }
    
    await client.query('COMMIT');
    
    const receta = result.rows[0];
    receta.ingredientes = ingredientes;
    res.json(receta);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al crear receta' });
  } finally {
    client.release();
  }
});

// PUT /api/recetas/:id - Actualizar receta
app.put('/api/recetas/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, categoria, precio_venta, porciones, ingredientes } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      'UPDATE recetas SET nombre=$1, categoria=$2, precio_venta=$3, porciones=$4 WHERE id=$5 RETURNING *',
      [nombre, categoria, precio_venta, porciones, id]
    );
    
    // Actualizar ingredientes
    await client.query('DELETE FROM recetas_ingredientes WHERE receta_id=$1', [id]);
    
    if (ingredientes && ingredientes.length > 0) {
      for (const ing of ingredientes) {
        await client.query(
          'INSERT INTO recetas_ingredientes (receta_id, ingrediente_id, cantidad) VALUES ($1, $2, $3)',
          [id, ing.ingrediente_id, ing.cantidad]
        );
      }
    }
    
    await client.query('COMMIT');
    
    const receta = result.rows[0];
    receta.ingredientes = ingredientes;
    res.json(receta);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar receta' });
  } finally {
    client.release();
  }
});

// DELETE /api/recetas/:id - Eliminar receta
app.delete('/api/recetas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM recetas WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar receta' });
  }
});

// POST /api/recetas/:id/producir - Producir receta y actualizar stock
app.post('/api/recetas/:id/producir', async (req, res) => {
  const { id } = req.params;
  const { cantidad } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Obtener ingredientes de la receta
    const ingResult = await client.query(
      'SELECT ingrediente_id, cantidad FROM recetas_ingredientes WHERE receta_id=$1',
      [id]
    );
    
    // Actualizar stock de cada ingrediente
    for (const item of ingResult.rows) {
      await client.query(
        'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id=$2',
        [item.cantidad * cantidad, item.ingrediente_id]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al producir receta' });
  } finally {
    client.release();
  }
});

// ==================== PEDIDOS ====================

// GET /api/pedidos - Obtener todos los pedidos
app.get('/api/pedidos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pedidos ORDER BY fecha DESC');
    const pedidos = result.rows;
    
    // Obtener items de cada pedido
    for (const pedido of pedidos) {
      const itemsResult = await pool.query(
        'SELECT * FROM pedidos_items WHERE pedido_id=$1',
        [pedido.id]
      );
      pedido.items = itemsResult.rows;
    }
    
    res.json(pedidos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// POST /api/pedidos - Crear pedido
app.post('/api/pedidos', async (req, res) => {
  const { proveedor_id, fecha, total, items } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      'INSERT INTO pedidos (proveedor_id, fecha, total, estado) VALUES ($1, $2, $3, $4) RETURNING *',
      [proveedor_id, fecha, total, 'pendiente']
    );
    
    const pedidoId = result.rows[0].id;
    
    // Insertar items
    if (items && items.length > 0) {
      for (const item of items) {
        await client.query(
          'INSERT INTO pedidos_items (pedido_id, ingrediente_id, cantidad, precio_unitario, subtotal) VALUES ($1, $2, $3, $4, $5)',
          [pedidoId, item.ingrediente_id, item.cantidad, item.precio_unitario, item.subtotal]
        );
      }
    }
    
    await client.query('COMMIT');
    
    const pedido = result.rows[0];
    pedido.items = items;
    res.json(pedido);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al crear pedido' });
  } finally {
    client.release();
  }
});

// PUT /api/pedidos/:id/recibir - Recibir pedido y actualizar stock
app.put('/api/pedidos/:id/recibir', async (req, res) => {
  const { id } = req.params;
  const { items, total_recibido } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Actualizar pedido
    await client.query(
      'UPDATE pedidos SET estado=$1, total_recibido=$2, fecha_recepcion=$3 WHERE id=$4',
      ['recibido', total_recibido, new Date(), id]
    );
    
    // Actualizar items y stock
    for (const item of items) {
      await client.query(
        'UPDATE pedidos_items SET cantidad_recibida=$1, precio_real=$2, estado=$3 WHERE id=$4',
        [item.cantidad_recibida, item.precio_real, item.estado, item.id]
      );
      
      // Actualizar stock si no está marcado como no-entregado
      if (item.estado !== 'no-entregado') {
        await client.query(
          'UPDATE ingredientes SET stock_actual = stock_actual + $1 WHERE id=$2',
          [item.cantidad_recibida, item.ingrediente_id]
        );
      }
    }
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al recibir pedido' });
  } finally {
    client.release();
  }
});

// DELETE /api/pedidos/:id - Eliminar pedido
app.delete('/api/pedidos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM pedidos WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar pedido' });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'La Caleta 102 API funcionando' });
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 API corriendo en puerto ${port}`);
  console.log(`📊 La Caleta 102 Dashboard API`);
});
