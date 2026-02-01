/**
 * Controller: RecipeController
 * Maneja requests HTTP para recetas
 */

const CostCalculationService = require('../../../application/services/CostCalculationService');
const RecipeRepository = require('../../../infrastructure/repositories/RecipeRepository');
const pool = require('../../../infrastructure/database/connection');

class RecipeController {
    /**
     * GET /api/recipes
     */
    static async list(req, res, next) {
        try {
            const restaurante_id = req.restauranteId;
            const repo = new RecipeRepository(pool);

            const recipes = await repo.findActive(restaurante_id);

            // Retornar array directo para compatibilidad con frontend
            res.json(recipes.map(r => r.toDTO()));
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/recipes/:id
     */
    static async getById(req, res, next) {
        try {
            const { id } = req.params;
            const restaurante_id = req.restauranteId;
            const repo = new RecipeRepository(pool);

            const recipe = await repo.findById(id, restaurante_id);

            if (!recipe) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Receta no encontrada' }
                });
            }

            res.json({
                success: true,
                data: recipe.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/recipes/:id/calculate-cost
     * Calcula y persiste el coste de una receta
     */
    static async calculateCost(req, res, next) {
        try {
            const { id } = req.params;
            const restaurante_id = req.restauranteId;

            const costService = new CostCalculationService({ pool });
            const result = await costService.calculateRecipeCost(id, restaurante_id);

            res.json({
                success: true,
                data: {
                    recipe: result.recipe,
                    breakdown: result.breakdown
                }
            });
        } catch (error) {
            if (error.message.includes('not found')) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: error.message }
                });
            }
            next(error);
        }
    }

    /**
     * POST /api/recipes/recalculate-all
     * Recalcula todas las recetas (admin)
     */
    static async recalculateAll(req, res, next) {
        try {
            const restaurante_id = req.restauranteId;
            const repo = new RecipeRepository(pool);
            const costService = new CostCalculationService({ pool });

            const recipes = await repo.findActive(restaurante_id);
            const results = [];

            for (const recipe of recipes) {
                try {
                    const result = await costService.calculateRecipeCost(recipe.id, restaurante_id);
                    results.push({ id: recipe.id, success: true, cost: result.breakdown.totalCost });
                } catch (err) {
                    results.push({ id: recipe.id, success: false, error: err.message });
                }
            }

            res.json({
                success: true,
                data: {
                    total: recipes.length,
                    successful: results.filter(r => r.success).length,
                    failed: results.filter(r => !r.success).length,
                    results
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/recipes/stats
     * Obtiene estadísticas de costes
     */
    static async getStats(req, res, next) {
        try {
            const restaurante_id = req.restauranteId;
            const costService = new CostCalculationService({ pool });

            const stats = await costService.getCostStatistics(restaurante_id);

            res.json({
                success: true,
                data: stats
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/recipes
     */
    static async create(req, res, next) {
        try {
            const restaurante_id = req.restauranteId;
            const repo = new RecipeRepository(pool);

            const recipe = await repo.create(req.body, restaurante_id);

            // Calcular coste inicial si tiene ingredientes
            if (req.body.ingredientes && req.body.ingredientes.length > 0) {
                const costService = new CostCalculationService({ pool });
                try {
                    await costService.calculateRecipeCost(recipe.id, restaurante_id);
                } catch (e) {
                    console.warn('Could not calculate initial cost:', e.message);
                }
            }

            res.status(201).json({
                success: true,
                data: recipe.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PUT /api/recipes/:id
     */
    static async update(req, res, next) {
        try {
            const { id } = req.params;
            const restaurante_id = req.restauranteId;
            const repo = new RecipeRepository(pool);

            const recipe = await repo.update(id, req.body, restaurante_id);

            if (!recipe) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Receta no encontrada' }
                });
            }

            // Recalcular coste si cambiaron ingredientes o precio
            if (req.body.ingredientes || req.body.precio_venta) {
                const costService = new CostCalculationService({ pool });
                try {
                    await costService.calculateRecipeCost(recipe.id, restaurante_id);
                } catch (e) {
                    console.warn('Could not recalculate cost:', e.message);
                }
            }

            res.json({
                success: true,
                data: recipe.toDTO()
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * DELETE /api/recipes/:id
     */
    static async delete(req, res, next) {
        try {
            const { id } = req.params;
            const restaurante_id = req.restauranteId;
            const repo = new RecipeRepository(pool);

            const deleted = await repo.delete(id, restaurante_id);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Receta no encontrada' }
                });
            }

            res.json({
                success: true,
                message: 'Receta eliminada'
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = RecipeController;
