/**
 * ============================================
 * tests/critical/inventory-consolidation.test.js
 * ============================================
 *
 * Verifica que la consolidación de inventario actualiza stock_actual
 * al valor stock_real y que el cálculo de valor_stock es correcto.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Inventory Consolidation — stock_real overwrites stock_actual', () => {
    let authToken;
    let testIngredientId;
    let originalStock;
    const TEST_STOCK_REAL = 99.77; // Distinctive value to verify

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Find an ingredient to test consolidation
        const res = await request(API_URL)
            .get('/api/inventory/complete')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200 && res.body.length > 0) {
            const ing = res.body.find(i => i.id && i.nombre);
            if (ing) {
                testIngredientId = ing.id;
                originalStock = parseFloat(ing.stock_virtual) || 0;
                console.log(`🧪 Test ingredient: ${ing.nombre} (ID: ${ing.id}, stock: ${originalStock})`);
            }
        }
    });

    it('1. PUT /api/inventory/:id/stock-real — sets stock_real value', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .put(`/api/inventory/${testIngredientId}/stock-real`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ stock_real: TEST_STOCK_REAL });

        expect([200, 201]).toContain(res.status);
        console.log(`📋 stock_real set to ${TEST_STOCK_REAL}`);
    });

    it('2. POST /api/inventory/consolidate — stock_actual becomes stock_real', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/inventory/consolidate')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                finalStock: [{
                    id: testIngredientId,
                    stock_real: TEST_STOCK_REAL
                }],
                snapshots: [{
                    id: testIngredientId,
                    stock_real: TEST_STOCK_REAL,
                    stock_virtual: originalStock
                }],
                adjustments: []
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.updated).toBeGreaterThanOrEqual(1);
        console.log(`✅ Consolidation: ${res.body.updated} items updated`);
    });

    it('3. GET /api/inventory/complete — verify stock_actual = stock_real after consolidation', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .get('/api/inventory/complete')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const ing = res.body.find(i => i.id === testIngredientId);
        expect(ing).toBeDefined();

        const stockVirtual = parseFloat(ing.stock_virtual);
        const valorStock = parseFloat(ing.valor_stock);
        const precioMedio = parseFloat(ing.precio_medio);

        console.log(`📊 After consolidation: stock_virtual=${stockVirtual}, precio_medio=${precioMedio}, valor_stock=${valorStock}`);

        // stock_actual should now equal the value we set during consolidation
        expect(Math.abs(stockVirtual - TEST_STOCK_REAL)).toBeLessThan(0.01);

        // valor_stock should equal stock * precio_medio
        if (precioMedio > 0) {
            const expectedValor = stockVirtual * precioMedio;
            expect(Math.abs(valorStock - expectedValor)).toBeLessThan(0.1);
            console.log(`📊 Valor Stock math check: ${valorStock} ≈ ${stockVirtual} × ${precioMedio} = ${expectedValor} ✅`);
        }
    });

    afterAll(async () => {
        // Restore original stock
        if (authToken && testIngredientId && originalStock !== undefined) {
            await request(API_URL)
                .post('/api/inventory/consolidate')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    finalStock: [{ id: testIngredientId, stock_real: originalStock }],
                    snapshots: [],
                    adjustments: []
                });
            console.log(`🧹 Cleanup: stock restored to ${originalStock}`);
        }
    });
});
