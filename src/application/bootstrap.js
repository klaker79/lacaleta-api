/**
 * Bootstrap de la aplicación
 * Registra event handlers y configura servicios
 */

const eventBus = require('../shared/events/EventBus');
const { IngredientPriceChanged, RecipeCostUpdated } = require('../domain/events');
const SaleRegistered = require('../domain/events/SaleRegistered');
const handleIngredientPriceChanged = require('./handlers/ingredientPriceHandler');
const handleRecipeCostUpdated = require('./handlers/recipeCostHandler');
const handleSaleRegistered = require('./handlers/saleHandler');

function setupEventHandlers() {
    console.log('[Bootstrap] Registering event handlers...');

    // Cuando cambia precio de ingrediente → recalcular recetas
    eventBus.subscribe(IngredientPriceChanged.TYPE, handleIngredientPriceChanged);

    // Cuando se actualiza coste de receta → verificar alertas
    eventBus.subscribe(RecipeCostUpdated.TYPE, handleRecipeCostUpdated);

    // Cuando se registra venta → descontar stock
    eventBus.subscribe(SaleRegistered.TYPE, handleSaleRegistered);

    console.log('[Bootstrap] Event handlers registered (3 handlers)');
}

function shutdown() {
    console.log('[Bootstrap] Shutting down...');
    eventBus.clear();
}

module.exports = {
    setupEventHandlers,
    shutdown
};
