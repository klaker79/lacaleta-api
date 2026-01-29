/**
 * Domain Service: CostCalculator
 * Cálculo de costes de recetas
 */

const CostBreakdown = require('../value-objects/CostBreakdown');

class CostCalculator {
    /**
     * Convierte cantidad entre unidades
     */
    static UNIT_CONVERSIONS = {
        'g_to_kg': 0.001,
        'kg_to_g': 1000,
        'ml_to_l': 0.001,
        'l_to_ml': 1000
    };

    /**
     * Calcula el coste de una receta
     * @param {Recipe} recipe
     * @param {Map<number, Ingredient>} ingredientPrices
     * @returns {CostBreakdown}
     */
    calculate(recipe, ingredientPrices) {
        const breakdown = new CostBreakdown(recipe.id);

        for (const component of recipe.components) {
            const ingredient = ingredientPrices.get(component.ingredientId);

            if (!ingredient) {
                breakdown.addMissingIngredient(component.ingredientId);
                continue;
            }

            const normalizedQty = this.normalizeQuantity(
                component.quantity,
                component.unit,
                ingredient.unit
            );

            const unitCost = ingredient.getCurrentPrice();
            const lineCost = normalizedQty * unitCost;

            breakdown.addLine({
                ingredientId: ingredient.id,
                ingredientName: ingredient.name,
                quantity: component.quantity,
                unit: component.unit,
                normalizedQuantity: normalizedQty,
                unitCost,
                lineCost
            });
        }

        breakdown.calculateTotals(recipe.portions, recipe.salePrice);

        return breakdown;
    }

    /**
     * Normaliza cantidad a unidad base
     */
    normalizeQuantity(quantity, fromUnit, toUnit) {
        if (fromUnit === toUnit) return quantity;

        const conversionKey = `${fromUnit}_to_${toUnit}`;
        const factor = CostCalculator.UNIT_CONVERSIONS[conversionKey];

        return factor ? quantity * factor : quantity;
    }
}

module.exports = CostCalculator;
