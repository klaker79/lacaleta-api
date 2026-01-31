/**
 * Entidad de dominio: StockMovement (Ajuste de Inventario / Merma)
 * 
 * Cubre las tablas:
 * - inventory_adjustments_v2: ajustes de stock
 * - mermas: pérdidas registradas
 */

class StockMovement {
    // Tipos de movimiento
    static TYPE = {
        ADJUSTMENT: 'adjustment',      // Ajuste manual
        WASTE: 'waste',                // Merma/pérdida
        SALE: 'sale',                  // Descuento por venta
        PURCHASE: 'purchase',          // Ingreso por compra
        PRODUCTION: 'production',      // Uso en producción
        CORRECTION: 'correction'       // Corrección de inventario
    };

    // Motivos comunes de merma
    static WASTE_REASONS = {
        EXPIRED: 'caducado',
        DAMAGED: 'dañado',
        THEFT: 'robo',
        PREPARATION: 'preparacion',
        SPILLAGE: 'derrame',
        OTHER: 'otro'
    };

    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurante_id || data.restaurantId;
        this.ingredientId = data.ingrediente_id || data.ingredientId;
        this.ingredientName = data.ingrediente_nombre || data.ingredientName || null;
        this.quantity = parseFloat(data.cantidad || data.quantity) || 0;
        this.unit = data.unidad || data.unit || null;
        this.type = data.tipo || data.type || StockMovement.TYPE.ADJUSTMENT;
        this.reason = data.motivo || data.reason || '';
        this.notes = data.notas || data.nota || data.notes || '';
        this.valueLost = data.valor_perdida ? parseFloat(data.valor_perdida) : null;
        this.userId = data.usuario_id || data.responsable_id || data.userId || null;
        this.date = data.fecha || data.date || new Date();
    }

    /**
     * Verifica si es un movimiento negativo (salida de stock)
     */
    isNegative() {
        return this.quantity < 0 ||
            this.type === StockMovement.TYPE.WASTE ||
            this.type === StockMovement.TYPE.SALE;
    }

    /**
     * Verifica si es un movimiento positivo (entrada de stock)
     */
    isPositive() {
        return this.quantity > 0 &&
            (this.type === StockMovement.TYPE.PURCHASE ||
                this.type === StockMovement.TYPE.CORRECTION);
    }

    /**
     * Verifica si es una merma
     */
    isWaste() {
        return this.type === StockMovement.TYPE.WASTE;
    }

    /**
     * Verifica si es un ajuste manual
     */
    isAdjustment() {
        return this.type === StockMovement.TYPE.ADJUSTMENT;
    }

    /**
     * Obtiene el valor absoluto de la cantidad
     */
    getAbsoluteQuantity() {
        return Math.abs(this.quantity);
    }

    /**
     * Obtiene la cantidad con signo correcto según el tipo
     */
    getSignedQuantity() {
        if (this.isWaste() || this.type === StockMovement.TYPE.SALE) {
            return -Math.abs(this.quantity);
        }
        if (this.type === StockMovement.TYPE.PURCHASE) {
            return Math.abs(this.quantity);
        }
        return this.quantity;
    }

    /**
     * Verifica si tiene valor de pérdida registrado
     */
    hasValueLost() {
        return this.valueLost !== null && this.valueLost > 0;
    }

    /**
     * Obtiene la fecha formateada
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
            ingredientId: this.ingredientId,
            ingredientName: this.ingredientName,
            quantity: this.quantity,
            absoluteQuantity: this.getAbsoluteQuantity(),
            signedQuantity: this.getSignedQuantity(),
            unit: this.unit,
            type: this.type,
            reason: this.reason,
            notes: this.notes,
            valueLost: this.valueLost,
            userId: this.userId,
            date: this.date,
            formattedDate: this.getFormattedDate(),
            isWaste: this.isWaste(),
            isNegative: this.isNegative()
        };
    }

    /**
     * Convierte a formato de tabla inventory_adjustments_v2
     */
    toAdjustmentDB() {
        return {
            ingrediente_id: this.ingredientId,
            cantidad: this.quantity,
            motivo: this.reason,
            notas: this.notes,
            usuario_id: this.userId,
            restaurante_id: this.restaurantId
        };
    }

    /**
     * Convierte a formato de tabla mermas
     */
    toWasteDB() {
        return {
            ingrediente_id: this.ingredientId,
            ingrediente_nombre: this.ingredientName,
            cantidad: Math.abs(this.quantity),
            unidad: this.unit,
            valor_perdida: this.valueLost || 0,
            motivo: this.reason,
            nota: this.notes,
            responsable_id: this.userId,
            restaurante_id: this.restaurantId
        };
    }
}

module.exports = StockMovement;
