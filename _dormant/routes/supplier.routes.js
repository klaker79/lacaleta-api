/**
 * ============================================
 * routes/supplier.routes.js - Rutas de Proveedores
 * ============================================
 *
 * CRUD de proveedores
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');

/**
 * GET /api/suppliers
 * Obtener todos los proveedores
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM proveedores WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY id',
            [req.restauranteId]
        );
        const proveedores = result.rows || [];

        // Obtener ingredientes de tabla de relación
        const relaciones = await pool.query(
            'SELECT proveedor_id, ingrediente_id FROM ingredientes_proveedores WHERE proveedor_id = ANY($1)',
            [proveedores.map(p => p.id)]
        );

        const ingPorProveedor = {};
        relaciones.rows.forEach(rel => {
            if (!ingPorProveedor[rel.proveedor_id]) {
                ingPorProveedor[rel.proveedor_id] = new Set();
            }
            ingPorProveedor[rel.proveedor_id].add(rel.ingrediente_id);
        });

        // Combinar ingredientes
        proveedores.forEach(prov => {
            const ingColumna = Array.isArray(prov.ingredientes) ? prov.ingredientes : [];
            const ingRelacion = ingPorProveedor[prov.id] ? Array.from(ingPorProveedor[prov.id]) : [];
            prov.ingredientes = Array.from(new Set([...ingColumna, ...ingRelacion]));
        });

        res.json(proveedores);
    } catch (err) {
        log('error', 'Error obteniendo proveedores', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

/**
 * POST /api/suppliers
 * Crear proveedor
 */
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;
        const result = await pool.query(
            `INSERT INTO proveedores (nombre, contacto, telefono, email, direccion, notas, ingredientes, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [nombre, contacto || '', telefono || '', email || '', direccion || '',
                notas || '', ingredientes || [], req.restauranteId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'Error creando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * PUT /api/suppliers/:id
 * Actualizar proveedor
 */
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, contacto, telefono, email, direccion, notas, ingredientes } = req.body;
        const result = await pool.query(
            `UPDATE proveedores SET nombre=$1, contacto=$2, telefono=$3, email=$4, 
             direccion=$5, notas=$6, ingredientes=$7 WHERE id=$8 AND restaurante_id=$9 RETURNING *`,
            [nombre, contacto || '', telefono || '', email || '', direccion || '',
                notas || '', ingredientes || [], id, req.restauranteId]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        log('error', 'Error actualizando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * DELETE /api/suppliers/:id
 * Soft delete proveedor
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE proveedores SET deleted_at = CURRENT_TIMESTAMP 
             WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING *`,
            [req.params.id, req.restauranteId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Proveedor no encontrado' });
        }
        log('info', 'Proveedor soft deleted', { id: req.params.id });
        res.json({ message: 'Eliminado', id: result.rows[0].id });
    } catch (err) {
        log('error', 'Error eliminando proveedor', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
