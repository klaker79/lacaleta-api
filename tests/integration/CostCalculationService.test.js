/**
 * Tests de integración: CostCalculationService
 */

const CostCalculationService = require('../../src/application/services/CostCalculationService');

// Mock del pool de base de datos
const mockPool = {
    query: jest.fn()
};

describe('CostCalculationService Integration', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new CostCalculationService({ pool: mockPool });
    });

    describe('calculateRecipeCost', () => {
        it('should calculate cost correctly for a simple recipe', async () => {
            // Mock de receta
            mockPool.query
                .mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        nombre: 'Test Recipe',
                        precio_venta: 15,
                        raciones: 1,
                        ingredientes: JSON.stringify([
                            { ingrediente_id: 1, cantidad: 200, unidad: 'g' },
                            { ingrediente_id: 2, cantidad: 100, unidad: 'g' }
                        ])
                    }]
                })
                // Mock de ingredientes
                .mockResolvedValueOnce({
                    rows: [
                        { id: 1, nombre: 'Tomate', precio_kg: 3, unidad: 'kg' },
                        { id: 2, nombre: 'Queso', precio_kg: 12, unidad: 'kg' }
                    ]
                })
                // Mock de update
                .mockResolvedValueOnce({ rowCount: 1 });

            const result = await service.calculateRecipeCost(1, 1);

            expect(result.breakdown.totalCost).toBeCloseTo(1.8, 1);
            // Tomate: 0.2kg * 3 = 0.6
            // Queso: 0.1kg * 12 = 1.2
            // Total: 1.8

            expect(result.breakdown.marginPercentage).toBeGreaterThan(80);
        });

        it('should handle missing recipe', async () => {
            mockPool.query.mockResolvedValueOnce({ rows: [] });

            await expect(service.calculateRecipeCost(999, 1))
                .rejects.toThrow('Recipe 999 not found');
        });

        it('should track missing ingredients', async () => {
            mockPool.query
                .mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        nombre: 'Test',
                        precio_venta: 10,
                        ingredientes: JSON.stringify([
                            { ingrediente_id: 999, cantidad: 100, unidad: 'g' }
                        ])
                    }]
                })
                .mockResolvedValueOnce({ rows: [] }) // No ingredients found
                .mockResolvedValueOnce({ rowCount: 1 });

            const result = await service.calculateRecipeCost(1, 1);

            expect(result.breakdown.isComplete).toBe(false);
            expect(result.breakdown.missingIngredients).toContain(999);
        });
    });

    describe('recalculateByIngredient', () => {
        it('should recalculate all affected recipes', async () => {
            // Mock: encontrar recetas que usan ingrediente 1
            mockPool.query
                .mockResolvedValueOnce({
                    rows: [{ id: 1 }, { id: 2 }]
                });

            // Mock para calculateRecipeCost de cada receta
            const calculateSpy = jest.spyOn(service, 'calculateRecipeCost')
                .mockResolvedValue({ breakdown: { totalCost: 5 } });

            const result = await service.recalculateByIngredient(1, 1);

            expect(result.updatedCount).toBe(2);
            expect(calculateSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe('getCostStatistics', () => {
        it('should return aggregated statistics', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [{
                    total_recipes: '10',
                    avg_margin: '72.5',
                    avg_food_cost: '27.5',
                    low_margin_count: '2',
                    high_food_cost_count: '1'
                }]
            });

            const stats = await service.getCostStatistics(1);

            expect(stats.totalRecipes).toBe(10);
            expect(stats.avgMargin).toBeCloseTo(72.5, 1);
            expect(stats.avgFoodCost).toBeCloseTo(27.5, 1);
            expect(stats.lowMarginCount).toBe(2);
            expect(stats.highFoodCostCount).toBe(1);
        });
    });
});
