/**
 * ============================================
 * routes/sale.routes.js - Rutas de Ventas
 * ============================================
 *
 * CRUD de ventas + carga masiva + parseo PDF
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const express = require('express');
const router = express.Router();

const { pool } = require('../config/database');
const { log } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth');
const { validateCantidad } = require('../utils/validators');

/**
 * GET /api/sales
 * Obtener ventas (filtradas por fecha opcional)
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { fecha } = req.query;
        let query = `SELECT v.*, r.nombre as receta_nombre 
                     FROM ventas v LEFT JOIN recetas r ON v.receta_id = r.id 
                     WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL`;
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

/**
 * POST /api/sales
 * Registrar venta (con soporte para variantes)
 */
router.post('/', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { recetaId, cantidad, varianteId, precioVariante, fecha } = req.body;

        const cantidadValidada = validateCantidad(cantidad);
        if (cantidadValidada === 0) {
            return res.status(400).json({ error: 'Cantidad debe ser positivo' });
        }

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
        let precioUnitario = parseFloat(receta.precio_venta);
        let factorVariante = 1;

        // Si hay variante, obtener precio y factor
        if (varianteId) {
            const varianteResult = await client.query(
                'SELECT precio_venta, factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2',
                [varianteId, recetaId]
            );
            if (varianteResult.rows.length > 0) {
                const variante = varianteResult.rows[0];
                precioUnitario = parseFloat(variante.precio_venta);
                factorVariante = parseFloat(variante.factor) || 1;
            }
        } else if (precioVariante && precioVariante > 0) {
            precioUnitario = precioVariante;
        }

        const total = precioUnitario * cantidadValidada;
        const fechaVenta = fecha ? new Date(fecha) : new Date();

        const ventaResult = await client.query(
            `INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [recetaId, cantidadValidada, precioUnitario, total, fechaVenta, req.restauranteId]
        );

        // Descontar stock
        const ingredientesReceta = receta.ingredientes || [];
        const porciones = parseInt(receta.porciones) || 1;

        for (const ing of ingredientesReceta) {
            await client.query('SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE', [ing.ingredienteId]);
            const cantidadADescontar = ((ing.cantidad || 0) / porciones) * cantidadValidada * factorVariante;
            await client.query(
                'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2',
                [cantidadADescontar, ing.ingredienteId]
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

/**
 * DELETE /api/sales/:id
 * Soft delete venta (restaura stock)
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const ventaResult = await client.query(
            'SELECT * FROM ventas WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL',
            [req.params.id, req.restauranteId]
        );

        if (ventaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Venta no encontrada' });
        }

        const venta = ventaResult.rows[0];

        // Restaurar stock
        const recetaResult = await client.query('SELECT * FROM recetas WHERE id = $1', [venta.receta_id]);
        if (recetaResult.rows.length > 0) {
            const receta = recetaResult.rows[0];
            const porciones = parseInt(receta.porciones) || 1;

            for (const ing of (receta.ingredientes || [])) {
                if (ing.ingredienteId && ing.cantidad) {
                    await client.query('SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE', [ing.ingredienteId]);
                    const cantidadARestaurar = ((ing.cantidad || 0) / porciones) * venta.cantidad;
                    await client.query(
                        `UPDATE ingredientes SET stock_actual = stock_actual + $1
                         WHERE id = $2 AND restaurante_id = $3`,
                        [cantidadARestaurar, ing.ingredienteId, req.restauranteId]
                    );
                }
            }
        }

        await client.query('UPDATE ventas SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1', [req.params.id]);

        await client.query('COMMIT');
        log('info', 'Venta eliminada con stock restaurado', { id: req.params.id });
        res.json({ message: 'Eliminado', id: venta.id });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando venta', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/sales/bulk
 * Carga masiva de ventas (n8n compatible)
 */
router.post('/bulk', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ventas } = req.body;

        if (!ventas || !Array.isArray(ventas) || ventas.length === 0) {
            return res.status(400).json({ error: 'Array de ventas requerido' });
        }

        await client.query('BEGIN');

        const resultados = [];
        const errores = [];

        for (const venta of ventas) {
            try {
                const { recetaId, cantidad, precioUnitario, total, fecha } = venta;

                if (!recetaId || !cantidad) {
                    errores.push({ venta, error: 'recetaId y cantidad requeridos' });
                    continue;
                }

                const result = await client.query(
                    `INSERT INTO ventas (receta_id, cantidad, precio_unitario, total, fecha, restaurante_id)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                    [recetaId, cantidad, precioUnitario || 0, total || 0,
                        fecha || new Date(), req.restauranteId]
                );

                // 🔧 FIX Bug #1: Descontar stock (igual que POST /api/sales)
                const recetaResult = await client.query(
                    'SELECT ingredientes, porciones FROM recetas WHERE id = $1 AND restaurante_id = $2',
                    [recetaId, req.restauranteId]
                );
                if (recetaResult.rows.length > 0) {
                    const receta = recetaResult.rows[0];
                    const porciones = parseInt(receta.porciones) || 1;
                    for (const ing of (receta.ingredientes || [])) {
                        if (ing.ingredienteId && ing.cantidad) {
                            await client.query('SELECT id FROM ingredientes WHERE id = $1 FOR UPDATE', [ing.ingredienteId]);
                            const cantidadADescontar = ((ing.cantidad || 0) / porciones) * cantidad;
                            await client.query(
                                'UPDATE ingredientes SET stock_actual = stock_actual - $1 WHERE id = $2 AND restaurante_id = $3',
                                [cantidadADescontar, ing.ingredienteId, req.restauranteId]
                            );
                        }
                    }
                }

                resultados.push({ recetaId, ventaId: result.rows[0].id });
            } catch (e) {
                errores.push({ venta, error: e.message });
            }
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            procesadas: resultados.length,
            errores: errores.length,
            resultados,
            detalleErrores: errores
        });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error en bulk sales', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
