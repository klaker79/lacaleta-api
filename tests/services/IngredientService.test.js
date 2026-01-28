/**
 * ============================================
 * tests/services/IngredientService.test.js
 * ============================================
 *
 * Tests unitarios para IngredientService.
 *
 * @author MindLoopIA
 */

// Mock database
jest.mock('../../src/config/database', () => ({
    pool: {
        query: jest.fn(),
        connect: jest.fn()
    }
}));

jest.mock('../../src/utils/logger', () => ({
    log: jest.fn()
}));

const IngredientService = require('../../src/services/IngredientService');
const { pool } = require('../../src/config/database');

describe('IngredientService', () => {
    let service;
    const mockRestauranteId = 1;

    beforeEach(() => {
        service = new IngredientService();
        jest.clearAllMocks();
    });

    describe('getAll', () => {
        it('should return all active ingredients', async () => {
            const mockIngredients = [
                { id: 1, nombre: 'Tomate', activo: true },
                { id: 2, nombre: 'Cebolla', activo: true }
            ];

            pool.query.mockResolvedValueOnce({ rows: mockIngredients });

            const result = await service.getAll(mockRestauranteId);

            expect(result).toEqual(mockIngredients);
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('FROM ingredientes'),
                [mockRestauranteId]
            );
        });

        it('should include inactive when requested', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });

            await service.getAll(mockRestauranteId, true);

            expect(pool.query).toHaveBeenCalledWith(
                expect.not.stringContaining('AND activo = true'),
                expect.any(Array)
            );
        });
    });

    describe('create', () => {
        it('should create ingredient with validated data', async () => {
            const inputData = {
                nombre: 'Ajo',
                familia: 'verdura',
                precio: 2.5,
                stock_actual: 10
            };

            const mockCreated = { id: 1, ...inputData };
            pool.query.mockResolvedValueOnce({ rows: [mockCreated] });

            const result = await service.create(inputData, mockRestauranteId);

            expect(result.id).toBe(1);
            expect(pool.query).toHaveBeenCalled();
        });

        it('should use defaults for missing fields', async () => {
            pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

            await service.create({ nombre: 'Test' }, mockRestauranteId);

            const queryCall = pool.query.mock.calls[0];
            expect(queryCall[0]).toContain('INSERT INTO');
        });
    });

    describe('updateStock', () => {
        it('should add stock correctly', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ id: 1, stock_actual: 15 }]
            });

            const result = await service.updateStock(1, 5, 'sumar', mockRestauranteId);

            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('stock_actual + $1'),
                [5, 1, mockRestauranteId]
            );
        });

        it('should subtract stock correctly', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ id: 1, stock_actual: 5 }]
            });

            await service.updateStock(1, 3, 'restar', mockRestauranteId);

            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('stock_actual - $1'),
                expect.any(Array)
            );
        });

        it('should not allow negative stock', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ id: 1, stock_actual: 0 }]
            });

            const result = await service.updateStock(1, 100, 'restar', mockRestauranteId);

            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('GREATEST(0,'),
                expect.any(Array)
            );
        });
    });

    describe('getLowStockAlerts', () => {
        it('should return low stock items', async () => {
            const mockAlerts = [
                { id: 1, nombre: 'Tomate', stock_actual: 2, stock_minimo: 5 }
            ];

            pool.query.mockResolvedValueOnce({ rows: mockAlerts });

            const result = await service.getLowStockAlerts(mockRestauranteId);

            expect(result).toEqual(mockAlerts);
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('stock_actual <= stock_minimo'),
                [mockRestauranteId]
            );
        });
    });

    describe('toggleActive', () => {
        it('should toggle active status', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ id: 1, activo: false }]
            });

            const result = await service.toggleActive(1, mockRestauranteId);

            expect(result.activo).toBe(false);
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('activo = NOT activo'),
                [1, mockRestauranteId]
            );
        });
    });
});
