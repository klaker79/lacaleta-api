/**
 * Evento: SaleRegistered
 * Se emite cuando se registra una venta
 */

class SaleRegistered {
    static TYPE = 'sale.registered';

    constructor({ saleId, restaurantId, items, total, date }) {
        this.type = SaleRegistered.TYPE;
        this.payload = {
            saleId,
            restaurantId,
            items, // [{ recipeId, quantity }]
            total,
            date: date || new Date()
        };
        this.timestamp = new Date();
    }
}

module.exports = SaleRegistered;
