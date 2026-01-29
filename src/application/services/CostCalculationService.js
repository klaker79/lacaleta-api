/**
 * Application Service: CostCalculationService
 * Orquesta el cálculo de costes de recetas
 */

const CostCalculator = require('../../domain/services/CostCalculator');
const Recipe = require('../../domain/entities/Recipe');
const Ingredient = require('../../domain/entities/Ingredient');

class CostCalculationService {
    constructor(dependencies = {}) {
        this.pool = dependencies.pool || require('../../infrastructure/database/connection');
        this.costCalculator = new CostCalculator();
        this.eventBus = dependencies.eventBus || null;
    }

    /**
     * Calcula y persiste el coste de una receta
     * @param {number} recipeId
     * @param {number} restaurantId
     * @returns {Promise<Object>} Breakdown de costes
     */
    async calculateRecipeCost(recipeId, restaurantId) {
        // 1. Obtener receta con ingredientes
        const recipeData = await this.getRecipeWithIngredients(recipeId, restaurantId);

        if (!recipeData) {
            throw new Error(`Recipe ${recipeId} not found`);
        }

        const recipe = new Recipe(recipeData);

        // 2. Obtener precios actuales de ingredientes
        const ingredientIds = recipe.components.map(c => c.ingredientId);
        const ingredientPrices = await this.getIngredientPrices(ingredientIds, restaurantId);

        // 3. Calcular costes con domain service
        const breakdown = this.costCalculator.calculate(recipe, ingredientPrices);

        // 4. Persistir resultado
        await this.updateRecipeCost(recipeId, breakdown);

        // 5. Emitir evento si hay event bus
        if (this.eventBus) {
            this.eventBus.emit({
                type: 'RecipeCostUpdated',
                payload: {
                    recipeId,
                    restaurantId,
                    totalCost: breakdown.totalCost,
                    marginPercentage: breakdown.marginPercentage
                },
                timestamp: new Date()
            });
        }

        return {
            recipe: recipe.toDTO(),
            breakdown: breakdown.toDTO()
        };
    }

    /**
     * Recalcula todas las recetas que usan un ingrediente
     * @param {number} ingredientId
     * @param {number} restaurantId
     * @returns {Promise<Array>} Recetas actualizadas
     */
    async recalculateByIngredient(ingredientId, restaurantId) {
        // Buscar recetas que usan este ingrediente
        const query = `
            SELECT DISTINCT r.id
            FROM recetas r
            WHERE r.restaurante_id = $1
              AND r.activo = true
              AND r.deleted_at IS NULL
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(r.ingredientes) AS ing
                  WHERE (ing->>'ingrediente_id')::int = $2
              )
        `;

        const result = await this.pool.query(query, [restaurantId, ingredientId]);
        const recipeIds = result.rows.map(r => r.id);

        // Recalcular cada una
        const updates = [];
        for (const recipeId of recipeIds) {
            try {
                const update = await this.calculateRecipeCost(recipeId, restaurantId);
                updates.push(update);
            } catch (error) {
                console.error(`Error recalculating recipe ${recipeId}:`, error.message);
            }
        }

        return {
            updatedCount: updates.length,
            recipes: updates
        };
    }

    /**
     * Obtiene receta con sus ingredientes
     * @private
     */
    async getRecipeWithIngredients(recipeId, restaurantId) {
        const query = `
            SELECT
                id,
                restaurante_id,
                nombre,
                descripcion,
                categoria_id,
                raciones,
                precio_venta,
                ingredientes,
                coste_calculado,
                margen_porcentaje,
                food_cost,
                activo,
                created_at
            FROM recetas
            WHERE id = $1
              AND restaurante_id = $2
              AND deleted_at IS NULL
        `;

        const result = await this.pool.query(query, [recipeId, restaurantId]);
        return result.rows[0] || null;
    }

    /**
     * Obtiene precios actuales de ingredientes
     * @private
     */
    async getIngredientPrices(ingredientIds, restaurantId) {
        if (!ingredientIds.length) return new Map();

        const query = `
            SELECT
                id,
                nombre,
                precio_kg,
                unidad,
                stock_actual,
                stock_minimo,
                activo
            FROM ingredientes
            WHERE id = ANY($1)
              AND restaurante_id = $2
              AND deleted_at IS NULL
        `;

        const result = await this.pool.query(query, [ingredientIds, restaurantId]);

        const priceMap = new Map();
        for (const row of result.rows) {
            priceMap.set(row.id, new Ingredient(row));
        }

        return priceMap;
    }

    /**
     * Actualiza los costes calculados en la receta
     * @private
     */
    async updateRecipeCost(recipeId, breakdown) {
        const query = `
            UPDATE recetas
            SET
                coste_calculado = $1,
                coste_por_racion = $2,
                margen_porcentaje = $3,
                food_cost = $4,
                last_cost_calculation = NOW(),
                updated_at = NOW()
            WHERE id = $5
        `;

        await this.pool.query(query, [
            breakdown.totalCost,
            breakdown.costPerPortion,
            breakdown.marginPercentage,
            breakdown.foodCostPercentage,
            recipeId
        ]);
    }

    /**
     * Obtiene estadísticas de costes de todas las recetas
     * @param {number} restaurantId
     * @returns {Promise<Object>}
     */
    async getCostStatistics(restaurantId) {
        const query = `
            SELECT
                COUNT(*) as total_recipes,
                AVG(margen_porcentaje) as avg_margin,
                AVG(food_cost) as avg_food_cost,
                COUNT(*) FILTER (WHERE margen_porcentaje < 60) as low_margin_count,
                COUNT(*) FILTER (WHERE food_cost > 35) as high_food_cost_count
            FROM recetas
            WHERE restaurante_id = $1
              AND activo = true
              AND deleted_at IS NULL
              AND coste_calculado IS NOT NULL
        `;

        const result = await this.pool.query(query, [restaurantId]);
        const stats = result.rows[0];

        return {
            totalRecipes: parseInt(stats.total_recipes),
            avgMargin: parseFloat(stats.avg_margin) || 0,
            avgFoodCost: parseFloat(stats.avg_food_cost) || 0,
            lowMarginCount: parseInt(stats.low_margin_count),
            highFoodCostCount: parseInt(stats.high_food_cost_count)
        };
    }
}

module.exports = CostCalculationService;
