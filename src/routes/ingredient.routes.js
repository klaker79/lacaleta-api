/**
 * ============================================
 * routes/ingredient.routes.js - Rutas de Ingredientes
 * ============================================
 *
 * CRUD de ingredientes + gestión de proveedores múltiples
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { validatePrecio, validateCantidad, validateNumber } = require('../utils/validators');

// ========== CRUD INGREDIENTES ==========

/**
 * GET /api/ingredients
 * Obtener todos los ingredientes
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { include_inactive } = req.query;
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

/**
 * POST /api/ingredients
 * Crear ingrediente
 */
router.post('/', authMiddleware, async (req, res) => {
    try {
        const {
            nombre, proveedorId, proveedor_id, precio, unidad,
            stockActual, stock_actual, stockMinimo, stock_minimo,
            familia, formato_compra, cantidad_por_formato
        } = req.body;

        const finalPrecio = validatePrecio(precio);
        const finalStockActual = validateCantidad(stockActual ?? stock_actual);
        const finalStockMinimo = validateCantidad(stockMinimo ?? stock_minimo);
        const finalProveedorId = proveedorId ?? proveedor_id ?? null;
        const finalFamilia = familia || 'alimento';
        const finalFormatoCompra = formato_compra || null;
        const finalCantidadPorFormato = cantidad_por_formato
            ? validateCantidad(cantidad_por_formato) : null;

        const result = await pool.query(
            `INSERT INTO ingredientes (nombre, proveedor_id, precio, unidad, stock_actual, 
             stock_minimo, familia, restaurante_id, formato_compra, cantidad_por_formato) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [nombre, finalProveedorId, finalPrecio, unidad || 'kg', finalStockActual,
                finalStockMinimo, finalFamilia, req.restauranteId, finalFormatoCompra, finalCantidadPorFormato]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/ingredients/:id
 * Actualizar ingrediente (preserva valores existentes)
 */
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body;

        // Obtener valores actuales
        const existingResult = await pool.query(
            'SELECT * FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );

        if (existingResult.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        const existing = existingResult.rows[0];

        // Merge: Solo actualizar campos explícitos
        const finalNombre = body.nombre !== undefined ? body.nombre : existing.nombre;
        const finalProveedorId = body.proveedorId !== undefined ? body.proveedorId :
            (body.proveedor_id !== undefined ? body.proveedor_id : existing.proveedor_id);
        const finalPrecio = body.precio !== undefined
            ? validatePrecio(body.precio) : parseFloat(existing.precio) || 0;
        const finalUnidad = body.unidad !== undefined ? body.unidad : existing.unidad;

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

        const finalFamilia = body.familia !== undefined
            ? body.familia : (existing.familia || 'alimento');
        const finalFormatoCompra = body.formato_compra !== undefined
            ? body.formato_compra : existing.formato_compra;
        const finalCantidadPorFormato = body.cantidad_por_formato !== undefined
            ? (body.cantidad_por_formato ? validateCantidad(body.cantidad_por_formato) : null)
            : existing.cantidad_por_formato;

        const result = await pool.query(
            `UPDATE ingredientes SET nombre=$1, proveedor_id=$2, precio=$3, unidad=$4, 
             stock_actual=$5, stock_minimo=$6, familia=$7, formato_compra=$10, 
             cantidad_por_formato=$11 WHERE id=$8 AND restaurante_id=$9 RETURNING *`,
            [finalNombre, finalProveedorId, finalPrecio, finalUnidad, finalStockActual,
                finalStockMinimo, finalFamilia, id, req.restauranteId, finalFormatoCompra,
                finalCantidadPorFormato]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        log('error', 'Error actualizando ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/ingredients/:id
 * Eliminar ingrediente
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ingredientes_proveedores WHERE ingrediente_id = $1', [req.params.id]);
        await client.query('DELETE FROM ingredientes_alias WHERE ingrediente_id = $1', [req.params.id]);
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

/**
 * PATCH /api/ingredients/:id/toggle-active
 * Toggle activo/inactivo
 */
router.patch('/:id/toggle-active', authMiddleware, async (req, res) => {
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

        log('info', `Ingrediente ${activo ? 'activado' : 'desactivado'}`, { id });
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error toggle activo ingrediente', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * POST /api/ingredients/match
 * Buscar ingrediente por nombre (con alias)
 */
router.post('/match', authMiddleware, async (req, res) => {
    try {
        const { nombre } = req.body;

        if (!nombre || typeof nombre !== 'string') {
            return res.status(400).json({ found: false, error: 'Se requiere el campo nombre' });
        }

        const nombreLimpio = nombre.trim();

        // 1. Buscar exacto
        let result = await pool.query(`
            SELECT id, nombre, unidad, precio, cantidad_por_formato, formato_compra, stock_actual
            FROM ingredientes WHERE restaurante_id = $1 AND LOWER(nombre) = LOWER($2)
            AND (activo IS NULL OR activo = TRUE) LIMIT 1
        `, [req.restauranteId, nombreLimpio]);

        if (result.rows.length > 0) {
            return res.json({ found: true, match_type: 'exact', ingrediente: result.rows[0] });
        }

        // 2. Buscar en alias
        result = await pool.query(`
            SELECT i.id, i.nombre, i.unidad, i.precio, i.cantidad_por_formato, i.formato_compra, i.stock_actual
            FROM ingredientes_alias a JOIN ingredientes i ON a.ingrediente_id = i.id
            WHERE a.restaurante_id = $1 AND LOWER(a.alias) = LOWER($2)
            AND (i.activo IS NULL OR i.activo = TRUE) LIMIT 1
        `, [req.restauranteId, nombreLimpio]);

        if (result.rows.length > 0) {
            return res.json({ found: true, match_type: 'alias', ingrediente: result.rows[0] });
        }

        // 3. Buscar parcial
        result = await pool.query(`
            SELECT id, nombre, unidad, precio FROM ingredientes 
            WHERE restaurante_id = $1 AND LOWER(nombre) LIKE LOWER($2)
            AND (activo IS NULL OR activo = TRUE) ORDER BY LENGTH(nombre) LIMIT 1
        `, [req.restauranteId, `%${nombreLimpio}%`]);

        if (result.rows.length > 0) {
            return res.json({ found: true, match_type: 'partial', ingrediente: result.rows[0] });
        }

        return res.json({ found: false, searched_name: nombreLimpio });
    } catch (err) {
        log('error', 'Error en match ingrediente', { error: err.message });
        res.status(500).json({ found: false, error: 'Error interno' });
    }
});

// ========== PROVEEDORES MÚLTIPLES ==========

/**
 * GET /api/ingredients/:id/suppliers
 * Obtener proveedores de un ingrediente
 */
router.get('/:id/suppliers', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        const checkIng = await pool.query(
            'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
            [id, req.restauranteId]
        );

        if (checkIng.rows.length === 0) {
            return res.status(404).json({ error: 'Ingrediente no encontrado' });
        }

        const result = await pool.query(`
            SELECT ip.id, ip.ingrediente_id, ip.proveedor_id, ip.precio, 
                   ip.es_proveedor_principal, p.nombre as proveedor_nombre, p.telefono, p.email
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

/**
 * POST /api/ingredients/:id/suppliers
 * Asociar proveedor a ingrediente
 */
router.post('/:id/suppliers', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { proveedor_id, precio, es_proveedor_principal } = req.body;

        if (!proveedor_id || precio === undefined) {
            return res.status(400).json({ error: 'proveedor_id y precio son requeridos' });
        }

        const precioNum = parseFloat(precio);
        if (isNaN(precioNum) || precioNum < 0) {
            return res.status(400).json({ error: 'Precio debe ser >= 0' });
        }

        // Si es principal, desmarcar otros
        if (es_proveedor_principal) {
            await pool.query(
                'UPDATE ingredientes_proveedores SET es_proveedor_principal = FALSE WHERE ingrediente_id = $1',
                [id]
            );
            await pool.query('UPDATE ingredientes SET proveedor_id = $1 WHERE id = $2', [proveedor_id, id]);
        }

        const result = await pool.query(`
            INSERT INTO ingredientes_proveedores (ingrediente_id, proveedor_id, precio, es_proveedor_principal)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (ingrediente_id, proveedor_id) 
            DO UPDATE SET precio = $3, es_proveedor_principal = $4
            RETURNING *
        `, [id, proveedor_id, precioNum, es_proveedor_principal || false]);

        log('info', 'Proveedor asociado a ingrediente', { ingrediente_id: id, proveedor_id });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error asociando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/ingredients/:id/suppliers/:supplierId
 * Actualizar asociación
 */
router.put('/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
    try {
        const { id, supplierId } = req.params;
        const { precio, es_proveedor_principal } = req.body;

        if (es_proveedor_principal) {
            await pool.query(
                'UPDATE ingredientes_proveedores SET es_proveedor_principal = FALSE WHERE ingrediente_id = $1',
                [id]
            );
            await pool.query('UPDATE ingredientes SET proveedor_id = $1 WHERE id = $2', [supplierId, id]);
        }

        const result = await pool.query(`
            UPDATE ingredientes_proveedores 
            SET precio = COALESCE($1, precio), es_proveedor_principal = COALESCE($2, es_proveedor_principal)
            WHERE ingrediente_id = $3 AND proveedor_id = $4
            RETURNING *
        `, [precio, es_proveedor_principal, id, supplierId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Asociación no encontrada' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'Error actualizando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/ingredients/:id/suppliers/:supplierId
 * Eliminar asociación
 */
router.delete('/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
    try {
        const { id, supplierId } = req.params;

        await pool.query(
            'DELETE FROM ingredientes_proveedores WHERE ingrediente_id = $1 AND proveedor_id = $2',
            [id, supplierId]
        );

        log('info', 'Eliminada asociación proveedor-ingrediente', { ingrediente_id: id, proveedor_id: supplierId });
        res.json({ success: true });
    } catch (err) {
        log('error', 'Error eliminando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
