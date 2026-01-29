/**
 * Handler: Cuando se registra una venta
 * Descuenta stock de ingredientes
 */

const InventoryService = require('../services/InventoryService');

async function handleSaleRegistered(event) {
    const { saleId, restaurantId, items } = event.payload;

    console.log(`[Handler] Sale ${saleId} registered with ${items?.length || 0} items`);

    if (!items || items.length === 0) {
        return { success: true, message: 'No items to process' };
    }

    const inventoryService = new InventoryService();

    try {
        const result = await inventoryService.deductStockFromSale(restaurantId,
            items.map(i => ({ ...i, saleId }))
        );
        console.log(`[Handler] Deducted stock for ${result.totalMovements} ingredients`);
        return result;
    } catch (error) {
        console.error('[Handler] Error deducting stock from sale:', error);
        throw error;
    }
}

module.exports = handleSaleRegistered;
