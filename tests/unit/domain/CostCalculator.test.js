const CostCalculator = require('../../../src/domain/services/CostCalculator');
const Recipe = require('../../../src/domain/entities/Recipe');
const Ingredient = require('../../../src/domain/entities/Ingredient');

describe('CostCalculator', () => {
    let calculator;

    beforeEach(() => {
        calculator = new CostCalculator();
    });

    describe('calculate', () => {
        it('should calculate correct total cost', () => {
            const recipe = new Recipe({
                id: 1,
                nombre: 'Test Recipe',
                precio_venta: 10,
                raciones: 1,
                ingredientes: [
                    { ingrediente_id: 1, cantidad: 200, unidad: 'g' },
                    { ingrediente_id: 2, cantidad: 100, unidad: 'g' }
                ]
            });

            const ingredients = new Map([
                [1, new Ingredient({ id: 1, nombre: 'Ing 1', precio_kg: 5, unidad: 'kg' })],
                [2, new Ingredient({ id: 2, nombre: 'Ing 2', precio_kg: 10, unidad: 'kg' })]
            ]);

            const breakdown = calculator.calculate(recipe, ingredients);

            // Ing 1: 0.2kg * 5 = 1.00
            // Ing 2: 0.1kg * 10 = 1.00
            // Total: 2.00
            expect(breakdown.totalCost).toBe(2);
            expect(breakdown.costPerPortion).toBe(2);
            // Margen: (10 - 2) / 10 = 80%
            expect(breakdown.marginPercentage).toBe(80);
            // Food cost: 2 / 10 = 20%
            expect(breakdown.foodCostPercentage).toBe(20);
        });

        it('should track missing ingredients', () => {
            const recipe = new Recipe({
                id: 1,
                nombre: 'Test',
                precio_venta: 10,
                ingredientes: [
                    { ingrediente_id: 999, cantidad: 100, unidad: 'g' }
                ]
            });

            const ingredients = new Map();
            const breakdown = calculator.calculate(recipe, ingredients);

            expect(breakdown.isComplete()).toBe(false);
            expect(breakdown.missingIngredients).toContain(999);
        });

        it('should handle unit conversions', () => {
            const recipe = new Recipe({
                id: 1,
                nombre: 'Test',
                precio_venta: 10,
                raciones: 1,
                ingredientes: [
                    { ingrediente_id: 1, cantidad: 500, unidad: 'g' }
                ]
            });

            const ingredients = new Map([
                [1, new Ingredient({ id: 1, nombre: 'Ing', precio_kg: 10, unidad: 'kg' })]
            ]);

            const breakdown = calculator.calculate(recipe, ingredients);

            // 500g = 0.5kg * 10 = 5.00
            expect(breakdown.totalCost).toBe(5);
        });

        it('should calculate cost per portion for multiple portions', () => {
            const recipe = new Recipe({
                id: 1,
                nombre: 'Test',
                precio_venta: 20,
                raciones: 4,
                ingredientes: [
                    { ingrediente_id: 1, cantidad: 1000, unidad: 'g' }
                ]
            });

            const ingredients = new Map([
                [1, new Ingredient({ id: 1, nombre: 'Ing', precio_kg: 8, unidad: 'kg' })]
            ]);

            const breakdown = calculator.calculate(recipe, ingredients);

            // 1000g = 1kg * 8 = 8.00 total
            // 8 / 4 portions = 2.00 per portion
            expect(breakdown.totalCost).toBe(8);
            expect(breakdown.costPerPortion).toBe(2);
            // Margen: (20 - 2) / 20 = 90%
            expect(breakdown.marginPercentage).toBe(90);
        });
    });

    describe('normalizeQuantity', () => {
        it('should convert g to kg', () => {
            expect(calculator.normalizeQuantity(1000, 'g', 'kg')).toBe(1);
        });

        it('should convert ml to l', () => {
            expect(calculator.normalizeQuantity(500, 'ml', 'l')).toBe(0.5);
        });

        it('should return same value for same units', () => {
            expect(calculator.normalizeQuantity(100, 'kg', 'kg')).toBe(100);
        });

        it('should return original value for unknown conversions', () => {
            expect(calculator.normalizeQuantity(100, 'oz', 'kg')).toBe(100);
        });
    });
});
