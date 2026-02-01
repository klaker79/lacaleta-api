/**
 * Entidad de dominio: Recipe
 * Representa una receta con su escandallo
 */

class Recipe {
    constructor(data) {
        this.id = data.id;
        this.restaurantId = data.restaurant_id || data.restaurantId;
        this.name = data.nombre || data.name;
        this.description = data.descripcion || data.description;
        this.categoryId = data.categoria_id || data.categoryId;
        this.portions = data.raciones || data.portions || 1;
        this.salePrice = parseFloat(data.precio_venta || data.salePrice || 0);

        // Costes calculados
        this.calculatedCost = data.coste_calculado || data.calculatedCost;
        this.costPerPortion = data.coste_por_racion || data.costPerPortion;
        this.marginPercentage = data.margen_porcentaje || data.marginPercentage;
        this.foodCostPercentage = data.food_cost || data.foodCostPercentage;
        this.lastCostCalculation = data.last_cost_calculation || data.lastCostCalculation;

        // Componentes (ingredientes)
        this.components = this.parseComponents(data.ingredientes || data.components || []);

        // Metadata
        this.preparationTime = data.tiempo_preparacion || data.preparationTime;
        this.allergens = data.alergenos || data.allergens || [];
        this.active = data.activo !== false && data.active !== false;
        this.createdAt = data.created_at || data.createdAt;
        this.updatedAt = data.updated_at || data.updatedAt;
    }

    parseComponents(components) {
        if (typeof components === 'string') {
            try {
                components = JSON.parse(components);
            } catch (e) {
                return [];
            }
        }
        return (components || []).map(c => {
            const id = c.ingrediente_id || c.ingredienteId || c.ingredientId;
            return {
                ingrediente_id: id,
                ingredientId: id,
                ingredienteId: id,  // Frontend español espera este campo
                cantidad: parseFloat(c.cantidad || c.quantity || 0),
                quantity: parseFloat(c.cantidad || c.quantity || 0),
                unidad: c.unidad || c.unit || 'g',
                unit: c.unidad || c.unit || 'g'
            };
        });
    }



    /**
     * Actualiza los costes calculados
     */
    updateCosts(breakdown) {
        this.calculatedCost = breakdown.totalCost;
        this.costPerPortion = breakdown.costPerPortion;
        this.marginPercentage = breakdown.marginPercentage;
        this.foodCostPercentage = breakdown.foodCostPercentage;
        this.lastCostCalculation = new Date();
    }

    /**
     * Verifica si el margen está por debajo del umbral
     */
    isMarginBelowThreshold(threshold = 60) {
        return this.marginPercentage !== null && this.marginPercentage < threshold;
    }

    /**
     * Convierte a DTO para respuesta de API
     */
    toDTO() {
        return {
            id: this.id,
            nombre: this.name,
            descripcion: this.description,
            categoria_id: this.categoryId,
            raciones: this.portions,
            precio_venta: this.salePrice,
            coste_calculado: this.calculatedCost,
            coste_por_racion: this.costPerPortion,
            margen_porcentaje: this.marginPercentage,
            food_cost: this.foodCostPercentage,
            ingredientes: this.components,
            activo: this.active,
            restaurante_id: this.restaurantId
        };
    }
}

module.exports = Recipe;
