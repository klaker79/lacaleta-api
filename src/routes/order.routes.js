/**
 * ============================================
 * routes/order.routes.js - Rutas de Pedidos
 * ============================================
 *
 * CRUD de pedidos a proveedores
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
 * GET /api/orders
 * Obtener todos los pedidos
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM pedidos WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY fecha DESC',
            [req.restauranteId]
        );
        res.json(result.rows || []);
    } catch (err) {
        log('error', 'Error obteniendo pedidos', { error: err.message });
        res.status(500).json({ error: 'Error interno', data: [] });
    }
});

/**
 * POST /api/orders
 * Crear pedido (con registro de precios_compra_diarios si está recibido)
 */
router.post('/', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { proveedorId, fecha, ingredientes, total, estado } = req.body;

        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO pedidos (proveedor_id, fecha, ingredientes, total, estado, restaurante_id) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [proveedorId, fecha, JSON.stringify(ingredientes), total, estado || 'pendiente', req.restauranteId]
        );

        // Si el pedido se crea directamente como 'recibido', registrar precios de compra diarios
        if (estado === 'recibido' && ingredientes && Array.isArray(ingredientes)) {
            const fechaCompra = fecha ? new Date(fecha) : new Date();

            for (const item of ingredientes) {
                const precioReal = parseFloat(item.precioReal || item.precioUnitario || item.precio_unitario) || 0;
                const cantidad = parseFloat(item.cantidadRecibida || item.cantidad) || 0;
                const totalItem = precioReal * cantidad;
                const ingId = item.ingredienteId || item.ingrediente_id;

                if (ingId && cantidad > 0) {
                    await client.query(`
                        INSERT INTO precios_compra_diarios 
                        (ingrediente_id, fecha, precio_unitario, cantidad_comprada, total_compra, restaurante_id, proveedor_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (ingrediente_id, fecha, restaurante_id)
                        DO UPDATE SET 
                            precio_unitario = EXCLUDED.precio_unitario,
                            cantidad_comprada = precios_compra_diarios.cantidad_comprada + EXCLUDED.cantidad_comprada,
                            total_compra = precios_compra_diarios.total_compra + EXCLUDED.total_compra
                    `, [ingId, fechaCompra, precioReal, cantidad, totalItem, req.restauranteId, proveedorId]);
                }
            }

            log('info', 'Compras diarias registradas al crear pedido recibido', {
                pedidoId: result.rows[0].id,
                items: ingredientes.length
            });
        }

        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error creando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/orders/:id
 * Actualizar pedido (incluye marcar como recibido)
 */
router.put('/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { estado, ingredientes, totalRecibido, fechaRecepcion } = req.body;

        await client.query('BEGIN');

        const result = await client.query(
            `UPDATE pedidos SET estado=$1, ingredientes=$2, total_recibido=$3, fecha_recepcion=$4 
             WHERE id=$5 AND restaurante_id=$6 RETURNING *`,
            [estado, JSON.stringify(ingredientes), totalRecibido, fechaRecepcion || new Date(), id, req.restauranteId]
        );

        // Registrar precios de compra diarios si se marca como recibido
        if (estado === 'recibido' && ingredientes && Array.isArray(ingredientes)) {
            const fechaCompra = fechaRecepcion ? new Date(fechaRecepcion) : new Date();

            // 🔍 DEBUG: Log completo de lo que recibimos
            log('info', '🔍 DEBUG: Procesando recepción de pedido', {
                pedidoId: id,
                estado,
                fechaCompra: fechaCompra.toISOString(),
                totalItems: ingredientes.length,
                proveedorId: result.rows[0]?.proveedor_id,
                restauranteId: req.restauranteId
            });

            let insertCount = 0;
            let skipCount = 0;

            for (const item of ingredientes) {
                // ⚠️ CRITICAL FIX: Usar cantidadRecibida y precioReal (datos reales de recepción)
                const precioReal = parseFloat(item.precioReal || item.precioUnitario || item.precio_unitario) || 0;
                const cantidadRecibida = parseFloat(item.cantidadRecibida || item.cantidad) || 0;
                const total = precioReal * cantidadRecibida;
                const ingId = item.ingredienteId || item.ingrediente_id;

                // 🔍 DEBUG: Log cada item
                log('info', `🔍 DEBUG: Item ${ingId}`, {
                    ingId,
                    precioReal,
                    cantidadRecibida,
                    total,
                    itemEstado: item.estado,
                    rawPrecioReal: item.precioReal,
                    rawPrecioUnitario: item.precioUnitario,
                    rawCantidadRecibida: item.cantidadRecibida,
                    rawCantidad: item.cantidad
                });

                // Solo insertar si hay cantidad recibida y el item NO está como no-entregado
                if (ingId && cantidadRecibida > 0 && item.estado !== 'no-entregado') {
                    const insertResult = await client.query(`
                        INSERT INTO precios_compra_diarios 
                        (ingrediente_id, fecha, precio_unitario, cantidad_comprada, total_compra, restaurante_id, proveedor_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (ingrediente_id, fecha, restaurante_id)
                        DO UPDATE SET 
                            precio_unitario = EXCLUDED.precio_unitario,
                            cantidad_comprada = precios_compra_diarios.cantidad_comprada + EXCLUDED.cantidad_comprada,
                            total_compra = precios_compra_diarios.total_compra + EXCLUDED.total_compra
                        RETURNING id, ingrediente_id, cantidad_comprada, total_compra
                    `, [ingId, fechaCompra, precioReal, cantidadRecibida, total,
                        req.restauranteId, result.rows[0]?.proveedor_id || null]);

                    insertCount++;
                    log('info', `✅ INSERT OK: ing ${ingId}`, {
                        rowsAffected: insertResult.rowCount,
                        returnedRow: insertResult.rows[0]
                    });
                } else {
                    skipCount++;
                    log('info', `⏭️ SKIP: ing ${ingId}`, {
                        reason: !ingId ? 'no-ingId' : cantidadRecibida <= 0 ? 'cant-zero' : 'no-entregado',
                        ingId,
                        cantidadRecibida,
                        itemEstado: item.estado
                    });
                }
            }

            log('info', '📊 RESUMEN: precios_compra_diarios', {
                pedidoId: id,
                totalItems: ingredientes.length,
                insertados: insertCount,
                saltados: skipCount
            });
        }

        await client.query('COMMIT');
        res.json(result.rows[0] || {});
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error actualizando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/orders/:id
 * Soft delete pedido (con reversión de stock si estaba recibido)
 */
router.delete('/:id', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Obtener pedido
        const pedidoResult = await client.query(
            'SELECT * FROM pedidos WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL',
            [req.params.id, req.restauranteId]
        );

        if (pedidoResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        const pedido = pedidoResult.rows[0];

        // Si estaba recibido, revertir stock y borrar compras diarias
        if (pedido.estado === 'recibido' && pedido.ingredientes) {
            const ingredientes = typeof pedido.ingredientes === 'string'
                ? JSON.parse(pedido.ingredientes)
                : pedido.ingredientes;

            const fechaRecepcion = pedido.fecha_recepcion || pedido.fecha;

            for (const item of ingredientes) {
                const ingId = item.ingredienteId || item.ingrediente_id;
                const cantidadRecibida = parseFloat(item.cantidadRecibida || item.cantidad || 0);

                // Borrar de precios_compra_diarios
                await client.query(
                    `DELETE FROM precios_compra_diarios 
                     WHERE ingrediente_id = $1 AND fecha::date = $2::date AND restaurante_id = $3`,
                    [ingId, fechaRecepcion, req.restauranteId]
                );

                // Revertir stock
                if (cantidadRecibida > 0) {
                    await client.query(
                        `UPDATE ingredientes SET stock_actual = stock_actual - $1 
                         WHERE id = $2 AND restaurante_id = $3`,
                        [cantidadRecibida, ingId, req.restauranteId]
                    );
                }
            }

            log('info', 'Stock revertido por borrado de pedido', { pedidoId: req.params.id });
        }

        // Soft delete
        await client.query('UPDATE pedidos SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1', [req.params.id]);

        await client.query('COMMIT');
        log('info', 'Pedido eliminado', { id: req.params.id });
        res.json({ message: 'Eliminado', id: pedido.id });
    } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'Error eliminando pedido', { error: err.message });
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
