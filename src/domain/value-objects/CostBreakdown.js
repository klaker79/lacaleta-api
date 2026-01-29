/**
 * Value Object: CostBreakdown
 * Representa el desglose de costes de una receta
 */

class CostBreakdown {
    constructor(recipeId) {
        this.recipeId = recipeId;
        this.lines = [];
        this.missingIngredients = [];
        this.totalCost = 0;
        this.costPerPortion = 0;
        this.marginPercentage = 0;
        this.foodCostPercentage = 0;
        this.calculatedAt = new Date();
    }

    addLine(line) {
        this.lines.push({
            ...line,
            lineCost: Math.round(line.lineCost * 10000) / 10000
        });
    }

    addMissingIngredient(ingredientId) {
        this.missingIngredients.push(ingredientId);
    }

    calculateTotals(portions, salePrice) {
        this.totalCost = this.lines.reduce((sum, line) => sum + line.lineCost, 0);
        this.totalCost = Math.round(this.totalCost * 100) / 100;

        this.costPerPortion = portions > 0
            ? Math.round((this.totalCost / portions) * 100) / 100
            : this.totalCost;

        if (salePrice > 0) {
            this.marginPercentage = Math.round(
                ((salePrice - this.costPerPortion) / salePrice) * 1000
            ) / 10;

            this.foodCostPercentage = Math.round(
                (this.costPerPortion / salePrice) * 1000
            ) / 10;
        }

        return this;
    }

    isComplete() {
        return this.missingIngredients.length === 0;
    }

    toDTO() {
        return {
            recipeId: this.recipeId,
            lines: this.lines,
            totalCost: this.totalCost,
            costPerPortion: this.costPerPortion,
            marginPercentage: this.marginPercentage,
            foodCostPercentage: this.foodCostPercentage,
            isComplete: this.isComplete(),
            missingIngredients: this.missingIngredients,
            calculatedAt: this.calculatedAt.toISOString()
        };
    }
}

module.exports = CostBreakdown;
