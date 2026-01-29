/**
 * Handler: Cuando cambia precio de ingrediente
 * Recalcula todas las recetas afectadas
 */

const CostCalculationService = require('../services/CostCalculationService');

async function handleIngredientPriceChanged(event) {
    const { ingredientId, restaurantId, priceChangePercent } = event.payload;

    console.log(`[Handler] Ingredient ${ingredientId} price changed by ${priceChangePercent.toFixed(1)}%`);

    const costService = new CostCalculationService();

    try {
        const result = await costService.recalculateByIngredient(ingredientId, restaurantId);
        console.log(`[Handler] Recalculated ${result.updatedCount} recipes`);
        return result;
    } catch (error) {
        console.error('[Handler] Error recalculating recipes:', error);
        throw error;
    }
}

module.exports = handleIngredientPriceChanged;
