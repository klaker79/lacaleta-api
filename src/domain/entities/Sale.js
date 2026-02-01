/**
 * Entidad de dominio: Sale (Venta)
 * 
 * Campos de la tabla ventas:
 * - id, receta_id, cantidad, precio_unitario, total
 * - fecha, restaurante_id, deleted_at
 */

class Sale {
    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurante_id || data.restaurantId;
        this.recipeId = data.receta_id || data.recipeId;
        this.recipeName = data.receta_nombre || data.recipeName || null;
        this.quantity = parseInt(data.cantidad || data.quantity) || 0;
        this.unitPrice = parseFloat(data.precio_unitario || data.unitPrice) || 0;
        this.total = parseFloat(data.total) || 0;
        this.date = data.fecha || data.date || new Date();
        this.deletedAt = data.deleted_at || data.deletedAt;
    }

    /**
     * Verifica si la venta está activa (no eliminada)
     */
    isActive() {
        return !this.deletedAt;
    }

    /**
     * Calcula el total basado en cantidad y precio unitario
     */
    calculateTotal() {
        return this.quantity * this.unitPrice;
    }

    /**
     * Verifica si el total calculado coincide con el total guardado
     */
    isTotalCorrect() {
        const calculated = this.calculateTotal();
        return Math.abs(calculated - this.total) < 0.01;
    }

    /**
     * Obtiene el margen si se conoce el coste de la receta
     */
    getMargin(recipeCost) {
        if (!recipeCost || recipeCost <= 0) return null;
        const totalCost = recipeCost * this.quantity;
        return this.total - totalCost;
    }

    /**
     * Obtiene el porcentaje de margen
     */
    getMarginPercentage(recipeCost) {
        if (!recipeCost || recipeCost <= 0 || this.total <= 0) return null;
        const margin = this.getMargin(recipeCost);
        return (margin / this.total) * 100;
    }

    /**
     * Verifica si es una venta del día actual
     */
    isToday() {
        const today = new Date();
        const saleDate = new Date(this.date);
        return today.toDateString() === saleDate.toDateString();
    }

    /**
     * Obtiene la fecha formateada (YYYY-MM-DD)
     */
    getFormattedDate() {
        const d = new Date(this.date);
        return d.toISOString().split('T')[0];
    }

    /**
     * Convierte a DTO para respuestas HTTP
     */
    toDTO() {
        return {
            id: this.id,
            receta_id: this.recipeId,
            receta_nombre: this.recipeName,
            cantidad: this.quantity,
            precio_unitario: this.unitPrice,
            total: this.total,
            fecha: this.date,
            restaurante_id: this.restaurantId
        };
    }

    /**
     * Convierte a formato de base de datos
     */
    toDB() {
        return {
            receta_id: this.recipeId,
            cantidad: this.quantity,
            precio_unitario: this.unitPrice,
            total: this.total,
            fecha: this.date,
            restaurante_id: this.restaurantId
        };
    }
}

module.exports = Sale;
