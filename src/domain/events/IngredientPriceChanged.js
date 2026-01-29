/**
 * Evento: IngredientPriceChanged
 * Se emite cuando cambia el precio de un ingrediente
 */

class IngredientPriceChanged {
    static TYPE = 'ingredient.price.changed';

    constructor({ ingredientId, restaurantId, oldPrice, newPrice, ingredientName }) {
        this.type = IngredientPriceChanged.TYPE;
        this.payload = {
            ingredientId,
            restaurantId,
            oldPrice,
            newPrice,
            ingredientName,
            priceChange: newPrice - oldPrice,
            priceChangePercent: oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0
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

module.exports = IngredientPriceChanged;
