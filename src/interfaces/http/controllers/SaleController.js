/**
 * Controller: SaleController
 * Maneja requests HTTP para ventas
 */

const SaleRepository = require('../../../infrastructure/repositories/SaleRepository');
const pool = require('../../../infrastructure/database/connection');

class SaleController {
    /**
     * GET /api/sales
     * Lista ventas con filtros opcionales
     */
    static async list(req, res, next) {
        try {
            const { date, startDate, endDate, limit } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            let sales;

            if (date) {
                sales = await repo.findByDate(date, restaurantId);
            } else if (startDate && endDate) {
                sales = await repo.findByDateRange(startDate, endDate, restaurantId);
            } else {
                sales = await repo.findActive(restaurantId, parseInt(limit) || 100);
            }

            // Retornar array directo para compatibilidad con frontend
            res.json(sales.map(s => s.toDTO()));
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/sales/:id
     * Obtiene una venta por ID
     */
    static async getById(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            const sale = await repo.findById(id, restaurantId);

            if (!sale) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Venta no encontrada' }
                });
            }

            res.json({
                success: true,
                data: sale.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/sales/recipe/:recipeId
     * Lista ventas de una receta específica
     */
    static async getByRecipe(req, res, next) {
        try {
            const { recipeId } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            const sales = await repo.findByRecipe(recipeId, restaurantId);

            res.json({
                success: true,
                data: sales.map(s => s.toDTO()),
                count: sales.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/sales
     * Registra una nueva venta
     */
    static async create(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            const sale = await repo.create(req.body, restaurantId);

            res.status(201).json({
                success: true,
                data: sale.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/sales/bulk
     * Registra múltiples ventas
     */
    static async createBulk(req, res, next) {
        try {
            const { sales: salesData } = req.body;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            if (!salesData || !Array.isArray(salesData)) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'INVALID_INPUT', message: 'Se requiere array de ventas' }
                });
            }

            const sales = await repo.createBulk(salesData, restaurantId);

            res.status(201).json({
                success: true,
                data: sales.map(s => s.toDTO()),
                count: sales.length
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/sales/:id
     * Elimina una venta (soft delete)
     */
    static async delete(req, res, next) {
        try {
            const { id } = req.params;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            const deleted = await repo.delete(id, restaurantId);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Venta no encontrada' }
                });
            }

            res.json({
                success: true,
                message: 'Venta eliminada'
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/sales/today
     * Obtiene resumen de ventas del día
     */
    static async getToday(req, res, next) {
        try {
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            const today = new Date().toISOString().split('T')[0];
            const totals = await repo.getTotalByDate(today, restaurantId);
            const sales = await repo.findByDate(today, restaurantId);

            res.json({
                success: true,
                data: {
                    date: today,
                    total: totals.total,
                    count: totals.count,
                    sales: sales.map(s => s.toDTO())
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/sales/stats
     * Obtiene estadísticas de ventas
     */
    static async getStats(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            const restaurantId = req.restauranteId || req.user?.restaurante_id;
            const repo = new SaleRepository(pool);

            const start = startDate || new Date(new Date().setDate(1)).toISOString().split('T')[0];
            const end = endDate || new Date().toISOString().split('T')[0];

            const totals = await repo.getTotalByDateRange(start, end, restaurantId);
            const topRecipes = await repo.getTopRecipes(restaurantId, 10, start, end);

            res.json({
                success: true,
                data: {
                    period: { startDate: start, endDate: end },
                    totalRevenue: totals.total,
                    totalSales: totals.count,
                    averageTicket: totals.count > 0 ? totals.total / totals.count : 0,
                    topRecipes
                }
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = SaleController;
