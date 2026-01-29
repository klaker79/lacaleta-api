/**
 * Entidad de dominio: Ingredient
 */

class Ingredient {
    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurant_id || data.restaurantId;
        this.name = data.nombre || data.name;
        this.familyId = data.familia_id || data.familyId;
        this.unit = data.unidad || data.unit || 'kg';
        this.pricePerUnit = parseFloat(data.precio_kg || data.precio || data.pricePerUnit || 0);
        this.currentStock = parseFloat(data.stock_actual || data.currentStock || 0);
        this.minStock = parseFloat(data.stock_minimo || data.minStock || 0);
        this.primarySupplierId = data.proveedor_id || data.primarySupplierId;
        this.active = data.activo !== false && data.active !== false;
    }

    /**
     * Obtiene el precio actual por unidad base
     */
    getCurrentPrice() {
        return this.pricePerUnit;
    }

    /**
     * Verifica si el stock está bajo
     */
    isLowStock() {
        return this.currentStock < this.minStock;
    }

    /**
     * Actualiza el stock
     */
    adjustStock(quantity) {
        this.currentStock += quantity;
        if (this.currentStock < 0) {
            this.currentStock = 0;
        }
    }

    /**
     * Actualiza el precio
     */
    updatePrice(newPrice) {
        const oldPrice = this.pricePerUnit;
        this.pricePerUnit = parseFloat(newPrice);
        return { oldPrice, newPrice: this.pricePerUnit };
    }

    toDTO() {
        return {
            id: this.id,
            name: this.name,
            familyId: this.familyId,
            unit: this.unit,
            pricePerUnit: this.pricePerUnit,
            currentStock: this.currentStock,
            minStock: this.minStock,
            isLowStock: this.isLowStock(),
            active: this.active
        };
    }
}

module.exports = Ingredient;
