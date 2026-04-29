/**
 * orders Routes — Extracted from server.js
 * Orders CRUD with daily purchase tracking & stock rollback on delete
 *
 * ⚠️ STOCK OWNERSHIP RULE:
 * The FRONTEND is the sole owner of stock adjustments (via bulkAdjustStock).
 * POST/PUT in this file must NEVER modify stock_actual.
 * They only record Diario (precios_compra_diarios) for cost tracking.
 * DELETE is the exception: it MUST revert stock since there's no frontend trigger.
 * See tests/critical/stock-no-double-count.test.js for validation.
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { logChange } = require('../utils/auditLog');
const { upsertCompraDiaria } = require('../utils/businessHelpers');
const { validateDate, validateNumber, validateId } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== PEDIDOS ==========
    // ✅ PRODUCCIÓN: Estas rutas inline en server.js son las únicas activas.
    // Los archivos src/routes/order.routes.js fueron movidos a _dormant/ (nunca se cargaron).
    // El POST registra Diario para compra mercado (estado='recibido').
    // El PUT registra Diario al recibir pedidos.
    // El DELETE hace rollback preciso (UPDATE-subtract + DELETE-if-≤0).

    router.get('/orders', authMiddleware, async (req, res) => {
        try {
            const { limit, page } = req.query;
            let query = 'SELECT * FROM pedidos WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY fecha DESC';
            const params = [req.restauranteId];

            if (limit) {
                const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
                const pageNum = Math.max(parseInt(page) || 1, 1);
                const offset = (pageNum - 1) * limitNum;

                const countResult = await pool.query('SELECT COUNT(*) FROM pedidos WHERE restaurante_id=$1 AND deleted_at IS NULL', [req.restauranteId]);
                res.set('X-Total-Count', countResult.rows[0].count);

                query += ` LIMIT $2 OFFSET $3`;
                params.push(limitNum, offset);
            }

            const result = await pool.query(query, params);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo pedidos', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    router.post('/orders', authMiddleware, async (req, res) => {
        const client = await pool.connect();
        try {
            const { proveedorId, fecha, ingredientes, total, estado } = req.body;

            // 🔒 Validar fecha
            const fechaCheck = validateDate(fecha);
            if (!fechaCheck.valid) {
                return res.status(400).json({ error: fechaCheck.error });
            }
            if (estado && !['pendiente', 'recibido', 'cancelado'].includes(estado)) {
                return res.status(400).json({ error: 'Estado inválido. Valores: pendiente, recibido, cancelado' });
            }
            if (ingredientes && !Array.isArray(ingredientes)) {
                return res.status(400).json({ error: 'Ingredientes debe ser un array' });
            }
            if (estado === 'recibido' && ingredientes) {
                for (const item of ingredientes) {
                    const ingId = item.ingredienteId || item.ingrediente_id;
                    if (!ingId) {
                        return res.status(400).json({ error: 'Cada ingrediente debe tener ingredienteId' });
                    }
                }
            }

            // 🔒 VALIDACIÓN CROSS-TENANT: asegurar que el proveedor y TODOS los
            // ingredientes pertenecen al tenant del token. Sin esto, un token de
            // tenant A podría crear pedidos con IDs de recursos del tenant B.
            if (proveedorId) {
                const provCheck = await client.query(
                    'SELECT id FROM proveedores WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                    [proveedorId, req.restauranteId]
                );
                if (provCheck.rows.length === 0) {
                    return res.status(404).json({ error: 'Proveedor no encontrado' });
                }
            }
            if (Array.isArray(ingredientes) && ingredientes.length > 0) {
                const ingIds = ingredientes
                    .filter(it => it.tipo !== 'ajuste')
                    .map(it => it.ingredienteId || it.ingrediente_id)
                    .filter(Boolean);
                if (ingIds.length > 0) {
                    const ingCheck = await client.query(
                        'SELECT id FROM ingredientes WHERE id = ANY($1::int[]) AND restaurante_id = $2 AND deleted_at IS NULL',
                        [ingIds, req.restauranteId]
                    );
                    if (ingCheck.rows.length !== ingIds.length) {
                        return res.status(404).json({ error: 'Uno o más ingredientes no encontrados' });
                    }
                }
            }

            // 🛡️ Guardrail: rechazar cantidades absurdas. Mismo umbral (10.000)
            // que aplican los endpoints /purchases/pending/approve*. Evita que un
            // doble click humano o un click por error infle el stock en miles de
            // unidades (incidente 2026-04-22: Pazo Lusco saltó a 144 botellas por
            // combinación mal introducida cantidad+formato).
            if (Array.isArray(ingredientes)) {
                for (const item of ingredientes) {
                    if (item.tipo === 'ajuste') continue;
                    const cantidadGuard = parseFloat(item.cantidadRecibida || item.cantidad);
                    if (!isNaN(cantidadGuard) && cantidadGuard > 10000) {
                        return res.status(400).json({
                            error: `Cantidad absurda detectada (${cantidadGuard}) para ingrediente ${item.ingredienteId || item.ingrediente_id}. Limite maximo por linea: 10000. Revisa cantidad y formato.`
                        });
                    }
                }
            }

            await client.query('BEGIN');

            const totalValidado = total !== undefined ? validateNumber(total, 0, 0, 9999999) : 0;

            const result = await client.query(
                'INSERT INTO pedidos (proveedor_id, fecha, ingredientes, total, estado, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                [proveedorId, fechaCheck.value, JSON.stringify(ingredientes), totalValidado, estado || 'pendiente', req.restauranteId]
            );

            // 📊 Registrar en Diario y sumar stock si pedido se crea como 'recibido' (compra mercado)
            // NOTA: El frontend NO llama a /daily/purchases/bulk. Esta es la ÚNICA fuente.
            if (estado === 'recibido' && ingredientes && Array.isArray(ingredientes)) {
                const fechaCompra = fecha ? new Date(fecha) : new Date();

                for (const item of ingredientes) {
                    // 🔒 Saltar items de tipo 'ajuste' (envases/bonificaciones) — solo afectan al total, no al Diario
                    if (item.tipo === 'ajuste') continue;
                    const ingId = item.ingredienteId || item.ingrediente_id;
                    const precioReal = parseFloat(item.precioReal || item.precioUnitario || item.precio_unitario) || 0;
                    const cantidad = parseFloat(item.cantidadRecibida || item.cantidad) || 0;
                    const totalItem = precioReal * cantidad;

                    // ⚡ FIX Stabilization v1: ON CONFLICT incluye pedido_id para evitar fusionar pedidos distintos
                    await upsertCompraDiaria(client, {
                        ingredienteId: ingId,
                        fecha: fechaCompra,
                        precioUnitario: precioReal,
                        cantidad, total: totalItem,
                        restauranteId: req.restauranteId,
                        proveedorId: proveedorId || null,
                        pedidoId: result.rows[0].id
                    });

                    // Stock adjustment handled by frontend via bulkAdjustStock — NOT here
                    // (avoids double-counting since frontend already adjusts stock atomically)
                }

                log('info', 'Compras diarias y stock registrados desde compra mercado', { pedidoId: result.rows[0].id, items: ingredientes.length });
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

    router.put('/orders/:id', authMiddleware, async (req, res) => {
        const idCheck = validateId(req.params.id);
        if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

        const client = await pool.connect();
        try {
            const { id } = req.params;
            const { estado, ingredientes, totalRecibido, fechaRecepcion, fecha_recepcion, total_recibido, total } = req.body;
            const fechaRecepcionFinal = fecha_recepcion || fechaRecepcion;

            // Si `total` llega en el body, lo validamos y persistimos. Si no llega
            // pasamos null al UPDATE y COALESCE conserva el valor actual de la columna.
            // Antes de este fix el campo `total` quedaba desactualizado al editar un
            // pedido pendiente desde el modal del frontend (incidente 2026-04-29).
            const totalValidado = (total !== undefined && total !== null)
                ? validateNumber(total, 0, 0, 9999999)
                : null;

            // 🛡️ Guardrail: rechazar cantidades absurdas en recepcion/edicion de
            // pedido. Mismo umbral 10000 que POST /orders. Protege contra errores
            // de UX (incidente 2026-04-22) y contra doble click.
            if (Array.isArray(ingredientes)) {
                for (const item of ingredientes) {
                    if (item.tipo === 'ajuste') continue;
                    const cantidadGuard = parseFloat(item.cantidadRecibida || item.cantidad);
                    if (!isNaN(cantidadGuard) && cantidadGuard > 10000) {
                        return res.status(400).json({
                            error: `Cantidad absurda detectada (${cantidadGuard}) para ingrediente ${item.ingredienteId || item.ingrediente_id}. Limite maximo por linea: 10000. Revisa cantidad y formato.`
                        });
                    }
                }
            }

            await client.query('BEGIN');

            // ⚡ FIX VAL-02: Obtener estado actual para prevenir doble procesamiento
            // Recuperamos también fecha_recepcion + proveedor_id para no sobreescribir
            // valores históricos al editar un pedido ya recibido sin enviarlos.
            const currentOrder = await client.query(
                'SELECT estado, fecha_recepcion, proveedor_id FROM pedidos WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [id, req.restauranteId]
            );
            if (currentOrder.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }
            const wasAlreadyReceived = currentOrder.rows[0].estado === 'recibido';
            const fechaRecepcionPersisted = currentOrder.rows[0].fecha_recepcion;
            const fechaRecepcionFinalReal = fechaRecepcionFinal || fechaRecepcionPersisted || new Date();

            const result = await client.query(
                'UPDATE pedidos SET estado=$1, ingredientes=$2, total=COALESCE($3, total), total_recibido=$4, fecha_recepcion=$5 WHERE id=$6 AND restaurante_id=$7 RETURNING *',
                [estado, JSON.stringify(ingredientes), totalValidado, total_recibido || totalRecibido, fechaRecepcionFinalReal, id, req.restauranteId]
            );

            // Reescribir Diario en 2 escenarios:
            //   a) Transición pendiente → recibido (alta inicial)
            //   b) Edición de un pedido YA recibido (cambio de precios/cantidades)
            // En (b) hay que BORRAR primero las filas previas con este pedido_id para
            // evitar duplicación (upsertCompraDiaria SUMA cantidad/total al hacer
            // ON CONFLICT). Sin este DELETE, editar un pedido recibido inflaba la
            // cantidad y el total en precios_compra_diarios y desincronizaba el JSONB
            // del precio_medio_compra (incidente 2026-04-28: pedido 448 CABREIROA).
            const debeReescribirDiario = estado === 'recibido' && ingredientes && Array.isArray(ingredientes);
            if (debeReescribirDiario) {
                const fechaCompra = new Date(fechaRecepcionFinalReal);

                if (wasAlreadyReceived) {
                    await client.query(
                        'DELETE FROM precios_compra_diarios WHERE pedido_id = $1 AND restaurante_id = $2',
                        [id, req.restauranteId]
                    );
                }

                for (const item of ingredientes) {
                    // 🔒 Saltar items de tipo 'ajuste' (envases/bonificaciones) — solo afectan al total, no al Diario
                    if (item.tipo === 'ajuste') continue;
                    const ingId = item.ingredienteId || item.ingrediente_id;
                    const precioReal = parseFloat(item.precioReal || item.precioUnitario || item.precio_unitario) || 0;
                    const cantidad = parseFloat(item.cantidadRecibida || item.cantidad) || 0;
                    const total = precioReal * cantidad;

                    await upsertCompraDiaria(client, {
                        ingredienteId: ingId,
                        fecha: fechaCompra,
                        precioUnitario: precioReal,
                        cantidad, total,
                        restauranteId: req.restauranteId,
                        proveedorId: result.rows[0]?.proveedor_id || null,
                        pedidoId: id
                    });

                    // Stock adjustment handled by frontend via bulkAdjustStock — NOT here
                    // (avoids double-counting since frontend already adjusts stock atomically)
                }

                log('info', 'Compras diarias registradas/reescritas desde pedido', { pedidoId: id, items: ingredientes.length, edicion: wasAlreadyReceived });
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

    router.delete('/orders/:id', authMiddleware, requireAdmin, async (req, res) => {
        const idCheck = validateId(req.params.id);
        if (!idCheck.valid) return res.status(400).json({ error: idCheck.error });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Obtener el pedido antes de borrarlo para saber qué borrar
            const pedidoResult = await client.query(
                'SELECT * FROM pedidos WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL',
                [req.params.id, req.restauranteId]
            );

            if (pedidoResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Pedido no encontrado o ya eliminado' });
            }

            const pedido = pedidoResult.rows[0];

            // 2. Si el pedido estaba recibido, borrar las compras diarias asociadas
            if (pedido.estado === 'recibido' && pedido.ingredientes) {
                let ingredientes;
                try {
                    ingredientes = typeof pedido.ingredientes === 'string'
                        ? JSON.parse(pedido.ingredientes)
                        : pedido.ingredientes;
                } catch (parseErr) {
                    log('error', 'Error parseando ingredientes de pedido', { id: pedido.id, error: parseErr.message });
                    ingredientes = [];
                }

                const fechaRecepcion = pedido.fecha_recepcion || pedido.fecha;

                // ⚡ FIX Stabilization v1: Borrar compras diarias por pedido_id (preciso)
                // Si el pedido tiene ID, borrar directamente sus filas (cada pedido tiene sus propias filas ahora)
                const hasPedidoBasedRows = await client.query(
                    `SELECT COUNT(*) as cnt FROM precios_compra_diarios 
                 WHERE pedido_id = $1 AND restaurante_id = $2`,
                    [pedido.id, req.restauranteId]
                );

                if (parseInt(hasPedidoBasedRows.rows[0].cnt) > 0) {
                    // Camino nuevo: borrar por pedido_id (seguro, no afecta otros pedidos)
                    await client.query(
                        `DELETE FROM precios_compra_diarios 
                     WHERE pedido_id = $1 AND restaurante_id = $2`,
                        [pedido.id, req.restauranteId]
                    );
                    log('info', 'Compras diarias borradas por pedido_id', { pedidoId: pedido.id });
                } else {
                    // Camino legacy: filas sin pedido_id (datos anteriores a la migración)
                    // Usar UPDATE-subtract + DELETE-if-≤0 como fallback
                    log('warn', 'Pedido sin filas con pedido_id, usando fallback legacy', { pedidoId: pedido.id });
                    for (const item of ingredientes) {
                        // 🔒 Saltar items de tipo 'ajuste' (no están en el Diario)
                        if (item.tipo === 'ajuste') continue;
                        const ingId = item.ingredienteId || item.ingrediente_id;
                        const cantidadRecibida = parseFloat(item.cantidadRecibida || item.cantidad || 0);
                        const precioReal = parseFloat(item.precioReal || item.precioUnitario || item.precio_unitario || 0);
                        const totalItem = precioReal * cantidadRecibida;

                        if (cantidadRecibida > 0 && fechaRecepcion) {
                            await client.query(
                                `UPDATE precios_compra_diarios 
                             SET cantidad_comprada = cantidad_comprada - $1,
                                 total_compra = total_compra - $2
                             WHERE ingrediente_id = $3 
                             AND fecha::date = $4::date 
                             AND restaurante_id = $5
                             AND pedido_id IS NULL`,
                                [cantidadRecibida, totalItem, ingId, fechaRecepcion, req.restauranteId]
                            );

                            await client.query(
                                `DELETE FROM precios_compra_diarios 
                             WHERE ingrediente_id = $1 
                             AND fecha::date = $2::date 
                             AND restaurante_id = $3
                             AND pedido_id IS NULL
                             AND cantidad_comprada <= 0`,
                                [ingId, fechaRecepcion, req.restauranteId]
                            );
                        }
                    }
                }

                // Revertir stock de cada ingrediente
                // Frontend adds stock via bulkAdjustStock. For pedido recepción,
                // delta = cantidadRecibida × cantPorFormato (already multiplied).
                // For compra mercado, delta = cantidad (raw base units, no multiplication).
                // 🔧 FIX (2026-04-15): cantidadRecibida YA viene en unidades base.
                // El bug del frontend que multiplicaba doble se arregló en pedidos-recepcion.js.
                // Aquí también hay que revertir SIN multiplicar otra vez por cantidad_por_formato.
                //
                // 🛡️ GUARDRAIL (2026-04-23): loggeamos warn si un item trae campos que
                // sugieren que su cantidad podría NO estar en unidades base (pedidos legacy
                // o de endpoints antiguos). NO cambiamos la fórmula — solo alertamos para
                // revisión manual. El rollback actual es correcto para el flujo vivo
                // (POST /orders + PUT /orders/:id de recepción) desde 2026-04-15.
                for (const item of ingredientes) {
                    if (item.tipo === 'ajuste') continue; // Ajustes no afectan al stock
                    const ingId = item.ingredienteId || item.ingrediente_id;
                    const stockARevertir = parseFloat(item.cantidadRecibida || item.cantidad || 0);

                    const mult = parseFloat(item.multiplicador);
                    const hasFormatoOverride = item.formato_override !== undefined && item.formato_override !== null;
                    const recibidoSinCantRecibida = pedido.estado === 'recibido'
                        && (item.cantidadRecibida === undefined || item.cantidadRecibida === null);
                    if ((Number.isFinite(mult) && mult !== 1) || hasFormatoOverride || recibidoSinCantRecibida) {
                        log('warn', 'DELETE /orders rollback: item con campos sospechosos — revisar stock tras borrado', {
                            pedidoId: pedido.id,
                            ingredienteId: ingId,
                            cantidad: item.cantidad,
                            cantidadRecibida: item.cantidadRecibida,
                            multiplicador: item.multiplicador,
                            formato_override: item.formato_override,
                            stockARevertir
                        });
                    }

                    if (stockARevertir > 0 && ingId) {
                        await client.query(
                            'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                            [ingId, req.restauranteId]
                        );
                        await client.query(
                            `UPDATE ingredientes
                         SET stock_actual = GREATEST(0, stock_actual - $1),
                             ultima_actualizacion_stock = NOW()
                         WHERE id = $2 AND restaurante_id = $3`,
                            [stockARevertir, ingId, req.restauranteId]
                        );
                    }
                }

                log('info', 'Compras diarias y stock revertidos por borrado de pedido', {
                    pedidoId: req.params.id,
                    ingredientes: ingredientes.length
                });
            }

            // 3. SOFT DELETE del pedido
            await client.query(
                'UPDATE pedidos SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2',
                [req.params.id, req.restauranteId]
            );

            await client.query('COMMIT');
            log('info', 'Pedido eliminado con cascading delete', { id: req.params.id, estado: pedido.estado });

            // Audit: registramos el DELETE a nivel pedido (la operación lógica).
            // `pedido` ya contiene el JSON de ingredientes, stock revertido y filas
            // de precios_compra_diarios borradas — todo deducible desde aquí.
            logChange(pool, {
                req,
                tabla: 'pedidos',
                operacion: 'DELETE',
                registroId: pedido.id,
                datosAntes: pedido,
                datosDespues: null,
            });

            res.json({ message: 'Eliminado', id: pedido.id });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error eliminando pedido', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    return router;
};
