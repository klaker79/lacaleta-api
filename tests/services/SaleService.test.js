/**
 * ============================================
 * tests/services/SaleService.test.js
 * ============================================
 *
 * Tests unitarios para SaleService.
 *
 * @author MindLoopIA
 */

jest.mock('../../src/config/database', () => ({
    pool: {
        query: jest.fn(),
        connect: jest.fn()
    }
}));

jest.mock('../../src/utils/logger', () => ({
    log: jest.fn()
}));

const SaleService = require('../../src/services/SaleService');
const { pool } = require('../../src/config/database');

describe('SaleService', () => {
    let service;
    const mockRestauranteId = 1;

    beforeEach(() => {
        service = new SaleService();
        jest.clearAllMocks();
    });

    describe('registerSale', () => {
        it('should register sale and deduct stock', async () => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // INSERT venta
                    .mockResolvedValueOnce({ rows: [{ ingredientes: [{ ingredienteId: 1, cantidad: 0.5 }] }] }) // SELECT receta
                    .mockResolvedValueOnce({ rows: [] }), // UPDATE stock
                release: jest.fn()
            };

            pool.connect.mockResolvedValueOnce(mockClient);

            const saleData = {
                receta_id: 1,
                cantidad: 2,
                precio_unitario: 10,
                total: 20
            };

            await service.registerSale(saleData, mockRestauranteId);

            expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
            expect(mockClient.release).toHaveBeenCalled();
        });

        it('should rollback on error', async () => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({}) // BEGIN
                    .mockRejectedValueOnce(new Error('DB Error')), // INSERT fails
                release: jest.fn()
            };

            pool.connect.mockResolvedValueOnce(mockClient);

            await expect(
                service.registerSale({ receta_id: 1 }, mockRestauranteId)
            ).rejects.toThrow('DB Error');

            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        });
    });

    describe('registerBulk', () => {
        it('should process multiple sales', async () => {
            // Mock cada venta exitosa
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
                release: jest.fn()
            };
            pool.connect.mockResolvedValue(mockClient);

            const ventas = [
                { receta_id: 1, cantidad: 1, total: 10 },
                { receta_id: 2, cantidad: 2, total: 20 }
            ];

            const result = await service.registerBulk(ventas, mockRestauranteId);

            expect(result.insertados).toBe(2);
            expect(result.errores).toHaveLength(0);
        });

        it('should track errors without stopping', async () => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({}) // BEGIN
                    .mockRejectedValueOnce(new Error('Error 1')), // First fails
                release: jest.fn()
            };
            pool.connect.mockResolvedValue(mockClient);

            const ventas = [{ receta_id: 1, cantidad: 1 }];

            const result = await service.registerBulk(ventas, mockRestauranteId);

            expect(result.errores.length).toBeGreaterThan(0);
        });
    });

    describe('getByDateRange', () => {
        it('should return sales within date range', async () => {
            const mockSales = [
                { id: 1, total: 50, fecha: '2026-01-15' },
                { id: 2, total: 30, fecha: '2026-01-16' }
            ];

            pool.query.mockResolvedValueOnce({ rows: mockSales });

            const result = await service.getByDateRange(
                '2026-01-01',
                '2026-01-31',
                mockRestauranteId
            );

            expect(result).toEqual(mockSales);
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining('BETWEEN'),
                ['2026-01-01', '2026-01-31', mockRestauranteId]
            );
        });
    });

    describe('getDailySummary', () => {
        it('should return daily totals', async () => {
            const mockSummary = {
                total_ventas: 500,
                unidades_vendidas: 25,
                num_transacciones: 10
            };

            pool.query.mockResolvedValueOnce({ rows: [mockSummary] });

            const result = await service.getDailySummary('2026-01-28', mockRestauranteId);

            expect(result[0].total_ventas).toBe(500);
        });
    });
});
