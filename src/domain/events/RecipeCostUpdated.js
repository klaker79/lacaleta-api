/**
 * Evento: RecipeCostUpdated
 * Se emite cuando se recalcula el coste de una receta
 */

class RecipeCostUpdated {
    static TYPE = 'recipe.cost.updated';

    constructor({ recipeId, restaurantId, recipeName, oldCost, newCost, marginPercentage, foodCost }) {
        this.type = RecipeCostUpdated.TYPE;
        this.payload = {
            recipeId,
            restaurantId,
            recipeName,
            oldCost,
            newCost,
            marginPercentage,
            foodCost,
            costChange: newCost - (oldCost || 0)
        };
        this.timestamp = new Date();
    }

    toJSON() {
        return {
            type: this.type,
            payload: this.payload,
            timestamp: this.timestamp.toISOString()
        };
    }
}

module.exports = RecipeCostUpdated;
