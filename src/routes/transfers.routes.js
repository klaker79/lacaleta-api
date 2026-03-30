/**
 * ============================================
 * transfers.routes.js
 * ============================================
 * Inter-restaurant stock transfers.
 * Owner creates transfer → destination restaurant approves/rejects.
 * On approval: stock deducted from origin, added to destination.
 */

const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { validateId } = require('../utils/validators');
const { log } = require('../utils/logger');

module.exports = function (pool) {
    const router = Router();

    /**
     * Verify two restaurants share the same owner.
     * Returns owner's user_id or null.
     */
    async function verifySharedOwner(client, restauranteId1, restauranteId2) {
        const result = await client.query(
            `SELECT ur1.usuario_id
             FROM usuario_restaurantes ur1
             JOIN usuario_restaurantes ur2 ON ur1.usuario_id = ur2.usuario_id
             WHERE ur1.restaurante_id = $1
               AND ur2.restaurante_id = $2
               AND ur1.rol = 'owner'
               AND ur2.rol = 'owner'
             LIMIT 1`,
            [restauranteId1, restauranteId2]
        );
        return result.rows.length > 0 ? result.rows[0].usuario_id : null;
    }

    /**
     * Try to find matching ingredient in destination restaurant by name (fuzzy).
     */
    async function findIngredientInRestaurant(client, nombre, restauranteId) {
        const normalizado = (nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

        // Exact match first
        const exact = await client.query(
            `SELECT id, nombre FROM ingredientes
             WHERE restaurante_id = $1 AND deleted_at IS NULL
               AND LOWER(nombre) = LOWER($2)
             LIMIT 1`,
            [restauranteId, nombre.trim()]
        );
        if (exact.rows.length > 0) return exact.rows[0];

        // Fuzzy: contains match
        if (normalizado.length >= 3) {
            const fuzzy = await client.query(
                `SELECT id, nombre FROM ingredientes
                 WHERE restaurante_id = $1 AND deleted_at IS NULL
                   AND LOWER(nombre) LIKE '%' || LOWER($2) || '%'
                 ORDER BY LENGTH(nombre) ASC
                 LIMIT 1`,
                [restauranteId, nombre.trim()]
            );
            if (fuzzy.rows.length > 0) return fuzzy.rows[0];
        }

        return null;
    }

    // ==========================================
    // POST /transfers — Create transfer request
    // ==========================================
    router.post('/transfers', authMiddleware, requireAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            const { destino_restaurante_id, ingrediente_id, cantidad, notas } = req.body;
            const origenId = req.restauranteId;

            if (!destino_restaurante_id || !ingrediente_id || !cantidad || cantidad <= 0) {
                return res.status(400).json({ error: 'destino_restaurante_id, ingrediente_id y cantidad (>0) son requeridos' });
            }

            if (parseInt(destino_restaurante_id) === origenId) {
                return res.status(400).json({ error: 'No puedes transferir al mismo restaurante' });
            }

            await client.query('BEGIN');

            // Verify both restaurants share the same owner
            const ownerId = await verifySharedOwner(client, origenId, parseInt(destino_restaurante_id));
            if (!ownerId) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Solo se pueden transferir entre restaurantes del mismo propietario' });
            }

            // Get ingredient from origin
            const ingResult = await client.query(
                'SELECT id, nombre, precio, stock_actual, unidad, cantidad_por_formato FROM ingredientes WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [ingrediente_id, origenId]
            );

            if (ingResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Ingrediente no encontrado en el restaurante de origen' });
            }

            const ingrediente = ingResult.rows[0];
            const cantidadNum = parseFloat(cantidad);

            if (ingrediente.stock_actual < cantidadNum) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `Stock insuficiente. Disponible: ${ingrediente.stock_actual} ${ingrediente.unidad}`,
                    stock_disponible: parseFloat(ingrediente.stock_actual)
                });
            }

            // Calculate unit price
            const cantidadPorFormato = parseFloat(ingrediente.cantidad_por_formato) || 1;
            const precioUnitario = parseFloat(ingrediente.precio) / cantidadPorFormato;

            // Try to find matching ingredient in destination
            const destinoIng = await findIngredientInRestaurant(client, ingrediente.nombre, parseInt(destino_restaurante_id));

            // Get destination restaurant name
            const destRest = await client.query('SELECT nombre FROM restaurantes WHERE id = $1', [destino_restaurante_id]);
            const destNombre = destRest.rows.length > 0 ? destRest.rows[0].nombre : 'Desconocido';

            // Insert transfer
            const result = await client.query(
                `INSERT INTO transferencias_stock
                 (origen_restaurante_id, destino_restaurante_id, ingrediente_nombre,
                  ingrediente_id_origen, ingrediente_id_destino, cantidad,
                  precio_unitario, estado, notas, solicitado_por)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente', $8, $9)
                 RETURNING *`,
                [origenId, destino_restaurante_id, ingrediente.nombre,
                 ingrediente_id, destinoIng ? destinoIng.id : null, cantidadNum,
                 precioUnitario, notas || null, req.user.userId]
            );

            await client.query('COMMIT');

            log('info', 'Transferencia creada', {
                id: result.rows[0].id,
                origen: origenId,
                destino: destino_restaurante_id,
                ingrediente: ingrediente.nombre,
                cantidad: cantidadNum
            });

            res.json({
                success: true,
                transfer: result.rows[0],
                destino_nombre: destNombre,
                ingrediente_destino_match: destinoIng ? destinoIng.nombre : null
            });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error creando transferencia', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // GET /transfers/incoming — Pending transfers TO my restaurant
    // ==========================================
    router.get('/transfers/incoming', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT t.*, r.nombre as origen_nombre,
                        u.nombre as solicitado_por_nombre
                 FROM transferencias_stock t
                 JOIN restaurantes r ON t.origen_restaurante_id = r.id
                 LEFT JOIN usuarios u ON t.solicitado_por = u.id
                 WHERE t.destino_restaurante_id = $1
                   AND t.estado = 'pendiente'
                 ORDER BY t.created_at DESC`,
                [req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error listando transferencias entrantes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ==========================================
    // GET /transfers/outgoing — Transfers FROM my restaurant
    // ==========================================
    router.get('/transfers/outgoing', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT t.*, r.nombre as destino_nombre,
                        u.nombre as solicitado_por_nombre
                 FROM transferencias_stock t
                 JOIN restaurantes r ON t.destino_restaurante_id = r.id
                 LEFT JOIN usuarios u ON t.solicitado_por = u.id
                 WHERE t.origen_restaurante_id = $1
                 ORDER BY t.created_at DESC
                 LIMIT 50`,
                [req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error listando transferencias salientes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ==========================================
    // GET /transfers/history — All resolved transfers (both directions)
    // ==========================================
    router.get('/transfers/history', authMiddleware, requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT t.*,
                        ro.nombre as origen_nombre,
                        rd.nombre as destino_nombre,
                        us.nombre as solicitado_por_nombre,
                        ua.nombre as aprobado_por_nombre
                 FROM transferencias_stock t
                 JOIN restaurantes ro ON t.origen_restaurante_id = ro.id
                 JOIN restaurantes rd ON t.destino_restaurante_id = rd.id
                 LEFT JOIN usuarios us ON t.solicitado_por = us.id
                 LEFT JOIN usuarios ua ON t.aprobado_por = ua.id
                 WHERE t.origen_restaurante_id = $1 OR t.destino_restaurante_id = $1
                 ORDER BY t.created_at DESC
                 LIMIT 100`,
                [req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error listando historial transferencias', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ==========================================
    // POST /transfers/:id/approve — Approve incoming transfer
    // ==========================================
    router.post('/transfers/:id/approve', authMiddleware, requireAdmin, async (req, res) => {
        if (!validateId(req.params.id, res)) return;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get transfer (must be pending and destined for my restaurant)
            const transferResult = await client.query(
                `SELECT * FROM transferencias_stock
                 WHERE id = $1 AND destino_restaurante_id = $2 AND estado = 'pendiente'
                 FOR UPDATE`,
                [req.params.id, req.restauranteId]
            );

            if (transferResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Transferencia no encontrada o ya procesada' });
            }

            const transfer = transferResult.rows[0];

            // Lock source ingredient before deducting (prevent race condition on concurrent transfers)
            await client.query(
                'SELECT id FROM ingredientes WHERE id = $1 AND restaurante_id = $2 FOR UPDATE',
                [transfer.ingrediente_id_origen, transfer.origen_restaurante_id]
            );

            // Deduct stock from origin (GREATEST(0, ...) — business rule: no negative stock)
            await client.query(
                `UPDATE ingredientes
                 SET stock_actual = GREATEST(0, stock_actual - $1),
                     ultima_actualizacion_stock = NOW()
                 WHERE id = $2 AND restaurante_id = $3`,
                [transfer.cantidad, transfer.ingrediente_id_origen, transfer.origen_restaurante_id]
            );

            // Resolve destination ingredient
            let destinoIngId = transfer.ingrediente_id_destino;
            if (!destinoIngId) {
                // Try to find matching ingredient in destination
                const match = await findIngredientInRestaurant(client, transfer.ingrediente_nombre, req.restauranteId);
                if (match) {
                    destinoIngId = match.id;
                    // Update transfer with found match
                    await client.query(
                        'UPDATE transferencias_stock SET ingrediente_id_destino = $1 WHERE id = $2',
                        [destinoIngId, transfer.id]
                    );
                }
            }

            if (!destinoIngId) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `No se encontró "${transfer.ingrediente_nombre}" en tu restaurante. Créalo primero o asígnalo manualmente.`
                });
            }

            // Add stock to destination
            await client.query(
                `UPDATE ingredientes
                 SET stock_actual = stock_actual + $1,
                     ultima_actualizacion_stock = NOW()
                 WHERE id = $2 AND restaurante_id = $3`,
                [transfer.cantidad, destinoIngId, req.restauranteId]
            );

            // Mark as approved
            await client.query(
                `UPDATE transferencias_stock
                 SET estado = 'aprobada', aprobado_por = $1, resuelto_at = NOW()
                 WHERE id = $2`,
                [req.user.userId, transfer.id]
            );

            await client.query('COMMIT');

            log('info', 'Transferencia aprobada', {
                id: transfer.id,
                ingrediente: transfer.ingrediente_nombre,
                cantidad: transfer.cantidad,
                origen: transfer.origen_restaurante_id,
                destino: req.restauranteId
            });

            res.json({ success: true, message: 'Transferencia aprobada. Stock actualizado.' });
        } catch (err) {
            await client.query('ROLLBACK');
            log('error', 'Error aprobando transferencia', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // POST /transfers/:id/reject — Reject incoming transfer
    // ==========================================
    router.post('/transfers/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
        if (!validateId(req.params.id, res)) return;
        try {
            const result = await pool.query(
                `UPDATE transferencias_stock
                 SET estado = 'rechazada', aprobado_por = $1, resuelto_at = NOW()
                 WHERE id = $2 AND destino_restaurante_id = $3 AND estado = 'pendiente'
                 RETURNING id`,
                [req.user.userId, req.params.id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Transferencia no encontrada o ya procesada' });
            }

            log('info', 'Transferencia rechazada', { id: req.params.id });
            res.json({ success: true, message: 'Transferencia rechazada' });
        } catch (err) {
            log('error', 'Error rechazando transferencia', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ==========================================
    // GET /transfers/pending-count — Count of pending incoming transfers (for badge)
    // ==========================================
    router.get('/transfers/pending-count', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT COUNT(*) as count FROM transferencias_stock
                 WHERE destino_restaurante_id = $1 AND estado = 'pendiente'`,
                [req.restauranteId]
            );
            res.json({ count: parseInt(result.rows[0].count) });
        } catch (err) {
            log('error', 'Error contando transferencias pendientes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ==========================================
    // GET /owner/restaurants — All owner's restaurants with summary KPIs
    // ==========================================
    router.get('/owner/restaurants', authMiddleware, async (req, res) => {
        try {
            // Get all restaurants where this user is owner
            const restResult = await pool.query(
                `SELECT r.id, r.nombre, r.plan, r.plan_status, ur.rol
                 FROM usuario_restaurantes ur
                 JOIN restaurantes r ON ur.restaurante_id = r.id
                 WHERE ur.usuario_id = $1 AND ur.rol = 'owner'
                 ORDER BY r.nombre`,
                [req.user.userId]
            );

            if (restResult.rows.length === 0) {
                return res.json({ restaurants: [] });
            }

            const restaurants = [];
            for (const rest of restResult.rows) {
                // Get summary KPIs per restaurant
                const [stockRes, ingredientesRes, pendingRes] = await Promise.all([
                    pool.query(
                        `SELECT COALESCE(SUM(stock_actual * (precio / NULLIF(cantidad_por_formato, 0))), 0) as valor_stock
                         FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL`,
                        [rest.id]
                    ),
                    pool.query(
                        'SELECT COUNT(*) as total FROM ingredientes WHERE restaurante_id = $1 AND deleted_at IS NULL',
                        [rest.id]
                    ),
                    pool.query(
                        "SELECT COUNT(*) as total FROM compras_pendientes WHERE restaurante_id = $1 AND estado = 'pendiente'",
                        [rest.id]
                    )
                ]);

                restaurants.push({
                    id: rest.id,
                    nombre: rest.nombre,
                    plan: rest.plan,
                    plan_status: rest.plan_status,
                    kpis: {
                        valor_stock: parseFloat(stockRes.rows[0].valor_stock) || 0,
                        total_ingredientes: parseInt(ingredientesRes.rows[0].total),
                        compras_pendientes: parseInt(pendingRes.rows[0].total)
                    }
                });
            }

            res.json({ restaurants });
        } catch (err) {
            log('error', 'Error listando restaurantes del owner', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
