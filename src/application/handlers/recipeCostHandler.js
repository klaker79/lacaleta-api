/**
 * Handler: Cuando se actualiza coste de receta
 * Verifica alertas de margen y food cost
 */

const AlertService = require('../services/AlertService');

async function handleRecipeCostUpdated(event) {
    const { recipeId, restaurantId, recipeName, marginPercentage, foodCost, totalCost } = event.payload;

    console.log(`[Handler] Recipe ${recipeId} cost updated. Margin: ${marginPercentage?.toFixed(1)}%`);

    const alertService = new AlertService();

    try {
        const breakdown = {
            marginPercentage: marginPercentage || 0,
            foodCostPercentage: foodCost || 0,
            totalCost: totalCost || 0
        };

        const alerts = await alertService.checkRecipeCostAlerts(
            recipeId,
            restaurantId,
            breakdown,
            recipeName || `Receta #${recipeId}`
        );

        if (alerts.length > 0) {
            console.log(`[Handler] ${alerts.length} alerts created for recipe ${recipeId}`);
        }

        return { alerts };
    } catch (error) {
        console.error('[Handler] Error checking recipe cost alerts:', error);
        throw error;
    }
}

module.exports = handleRecipeCostUpdated;
