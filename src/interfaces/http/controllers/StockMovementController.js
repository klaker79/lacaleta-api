/**
 * Controller: StockMovementController
 * Maneja requests HTTP para ajustes de inventario y mermas
 */

const StockMovementRepository = require('../../../infrastructure/repositories/StockMovementRepository');
const pool = require('../../../infrastructure/database/connection');

class StockMovementController {
    /**
     * GET /api/inventory/adjustments
     * Lista ajustes de inventario de un ingrediente
     */
    static async listAdjustments(req, res, next) {
        try {
            const { ingredientId } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            if (!ingredientId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'INVALID_INPUT', message: 'Se requiere ingredientId' }
                });
            }

            const adjustments = await repo.findAdjustmentsByIngredient(ingredientId, restaurantId);

            res.json({
                success: true,
                data: adjustments.map(a => a.toDTO()),
                count: adjustments.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/inventory/adjustments
     * Crea un ajuste de inventario
     */
    static async createAdjustment(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            const adjustment = await repo.createAdjustment(req.body, restaurantId);

            res.status(201).json({
                success: true,
                data: adjustment.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/mermas
     * Lista mermas con filtros opcionales
     */
    static async listWaste(req, res, next) {
        try {
            const { startDate, endDate, limit } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            let waste;

            if (startDate && endDate) {
                waste = await repo.findWasteByDateRange(startDate, endDate, restaurantId);
            } else {
                waste = await repo.findRecentWaste(restaurantId, parseInt(limit) || 50);
            }

            res.json({
                success: true,
                data: waste.map(w => w.toDTO()),
                count: waste.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/mermas/:id
     * Obtiene una merma por ID
     */
    static async getWasteById(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            const waste = await repo.findWasteById(id, restaurantId);

            if (!waste) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Merma no encontrada' }
                });
            }

            res.json({
                success: true,
                data: waste.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/mermas
     * Registra una o más mermas
     */
    static async createWaste(req, res, next) {
        try {
            const { mermas } = req.body;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            // Soporta array o item individual
            if (mermas && Array.isArray(mermas)) {
                const waste = await repo.createWasteBulk(mermas, restaurantId);
                res.status(201).json({
                    success: true,
                    data: waste.map(w => w.toDTO()),
                    count: waste.length
                });
            } else {
                const waste = await repo.createWaste(req.body, restaurantId);
                res.status(201).json({
                    success: true,
                    data: waste.toDTO()
                });
            }
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/mermas/stats
     * Obtiene estadísticas de mermas
     */
    static async getWasteStats(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            const start = startDate || new Date(new Date().setDate(1)).toISOString().split('T')[0];
            const end = endDate || new Date().toISOString().split('T')[0];

            const totals = await repo.getWasteTotalByDateRange(start, end, restaurantId);
            const byReason = await repo.getWasteByReason(restaurantId, start, end);
            const topWasted = await repo.getTopWastedIngredients(restaurantId, 10);

            res.json({
                success: true,
                data: {
                    period: { startDate: start, endDate: end },
                    totals: {
                        count: totals.count,
                        totalQuantity: totals.totalQuantity,
                        totalValue: totals.totalValue
                    },
                    byReason,
                    topWastedIngredients: topWasted
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/mermas/by-reason
     * Obtiene mermas agrupadas por motivo
     */
    static async getWasteByReason(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            const byReason = await repo.getWasteByReason(restaurantId, startDate, endDate);

            res.json({
                success: true,
                data: byReason
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/mermas/top-ingredients
     * Obtiene ingredientes con más mermas
     */
    static async getTopWastedIngredients(req, res, next) {
        try {
            const { limit } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new StockMovementRepository(pool);

            const topWasted = await repo.getTopWastedIngredients(restaurantId, parseInt(limit) || 10);

            res.json({
                success: true,
                data: topWasted
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = StockMovementController;
