/**
 * Controller: PurchaseController
 * Maneja requests HTTP para pedidos a proveedores
 */

const PurchaseRepository = require('../../../infrastructure/repositories/PurchaseRepository');
const Purchase = require('../../../domain/entities/Purchase');
const pool = require('../../../infrastructure/database/connection');

class PurchaseController {
    /**
     * GET /api/orders
     * Lista todos los pedidos activos
     */
    static async list(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const purchases = await repo.findActive(restaurantId);

            // Retornar array directo para compatibilidad con frontend
            res.json(purchases.map(p => p.toDTO()));
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/orders/:id
     * Obtiene un pedido por ID
     */
    static async getById(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const purchase = await repo.findById(id, restaurantId);

            if (!purchase) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Pedido no encontrado' }
                });
            }

            res.json({
                success: true,
                data: purchase.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/orders/pending
     * Lista pedidos pendientes
     */
    static async getPending(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const purchases = await repo.findPending(restaurantId);

            res.json({
                success: true,
                data: purchases.map(p => p.toDTO()),
                count: purchases.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/orders/supplier/:supplierId
     * Lista pedidos de un proveedor
     */
    static async getBySupplier(req, res, next) {
        try {
            const { supplierId } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const purchases = await repo.findBySupplier(supplierId, restaurantId);

            res.json({
                success: true,
                data: purchases.map(p => p.toDTO()),
                count: purchases.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/orders
     * Crea un nuevo pedido
     */
    static async create(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const purchase = await repo.create(req.body, restaurantId);

            res.status(201).json({
                success: true,
                data: purchase.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/orders/:id
     * Actualiza un pedido
     */
    static async update(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            // Verificar que el pedido puede ser modificado
            const existing = await repo.findById(id, restaurantId);
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Pedido no encontrado' }
                });
            }

            if (!existing.canBeModified()) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'INVALID_STATE', message: 'El pedido no puede ser modificado en su estado actual' }
                });
            }

            const purchase = await repo.update(id, req.body, restaurantId);

            res.json({
                success: true,
                data: purchase.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/orders/:id/receive
     * Marca un pedido como recibido
     */
    static async receive(req, res, next) {
        try {
            const { id } = req.params;
            const { totalReceived } = req.body;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            // Verificar que el pedido puede ser recibido
            const existing = await repo.findById(id, restaurantId);
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Pedido no encontrado' }
                });
            }

            if (!existing.canBeReceived()) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'INVALID_STATE', message: 'El pedido no puede ser recibido en su estado actual' }
                });
            }

            const purchase = await repo.markAsReceived(id, totalReceived || existing.total, restaurantId);

            res.json({
                success: true,
                data: purchase.toDTO(),
                hasDiscrepancy: purchase.hasDiscrepancy(),
                discrepancy: purchase.getDiscrepancy()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/orders/:id
     * Elimina un pedido (soft delete)
     */
    static async delete(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const deleted = await repo.delete(id, restaurantId);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Pedido no encontrado' }
                });
            }

            res.json({
                success: true,
                message: 'Pedido eliminado'
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/orders/stats
     * Obtiene estadísticas de pedidos
     */
    static async getStats(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new PurchaseRepository(pool);

            const start = startDate || new Date(new Date().setDate(1)).toISOString().split('T')[0];
            const end = endDate || new Date().toISOString().split('T')[0];

            const total = await repo.getTotalByDateRange(start, end, restaurantId);
            const pending = await repo.findPending(restaurantId);

            res.json({
                success: true,
                data: {
                    period: { startDate: start, endDate: end },
                    totalAmount: total,
                    pendingCount: pending.length,
                    pendingAmount: pending.reduce((sum, p) => sum + p.total, 0)
                }
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = PurchaseController;
