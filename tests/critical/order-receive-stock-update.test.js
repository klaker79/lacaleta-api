/**
 * ============================================
 * tests/critical/order-receive-stock-update.test.js
 * ============================================
 *
 * Verifica que recibir un pedido actualiza el stock del ingrediente,
 * y que recibir dos veces NO duplica el stock (BUG-MV-01 fix).
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Order Receive — Stock update and double-receive protection', () => {
    let authToken;
    let testIngredientId;
    let testIngredientName;
    let stockBefore;
    let createdOrderId;
    const testDate = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        // Get a test ingredient
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status === 200 && ingRes.body.length > 0) {
            testIngredientId = ingRes.body[0].id;
            testIngredientName = ingRes.body[0].nombre;
            stockBefore = parseFloat(ingRes.body[0].stock_actual) || 0;
            console.log(`📦 Test ingredient: ${testIngredientName} (ID: ${testIngredientId})`);
            console.log(`📊 Stock before: ${stockBefore}`);
        }
    });

    it('1. Create a pending order', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: testDate,
                estado: 'pendiente',
                total: 10,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 5,
                    precioUnitario: 2
                }]
            });

        expect([200, 201]).toContain(res.status);
        createdOrderId = res.body.id;
        console.log(`📋 Pending order created: ID ${createdOrderId}`);

        // Stock should NOT change for pending orders
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status === 200) {
            const ing = ingRes.body.find(i => i.id === testIngredientId);
            const stockAfterPending = parseFloat(ing?.stock_actual) || 0;
            console.log(`📊 Stock after pending order: ${stockAfterPending} (expected: ${stockBefore})`);
            expect(Math.abs(stockAfterPending - stockBefore)).toBeLessThan(0.01);
        }
    });

    it('2. Receive the order — stock should increase', async () => {
        if (!authToken || !createdOrderId) return;

        const res = await request(API_URL)
            .put(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 5,
                    cantidadRecibida: 5,
                    precioReal: 2,
                    precioUnitario: 2
                }],
                total_recibido: 10
            });

        expect([200, 201]).toContain(res.status);
        console.log(`✅ Order ${createdOrderId} marked as received`);

        // Stock should have increased by 5
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status === 200) {
            const ing = ingRes.body.find(i => i.id === testIngredientId);
            const stockAfterReceive = parseFloat(ing?.stock_actual) || 0;
            console.log(`📊 Stock after receive: ${stockAfterReceive} (expected: ~${stockBefore + 5})`);
            expect(stockAfterReceive).toBeGreaterThanOrEqual(stockBefore + 4.99);
        }
    });

    it('3. ⚡ CRITICAL: Receive again — stock should NOT increase again', async () => {
        if (!authToken || !createdOrderId) return;

        // Capture stock before second receive attempt
        const ingBefore = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const stockBeforeDouble = parseFloat(
            ingBefore.body?.find(i => i.id === testIngredientId)?.stock_actual
        ) || 0;

        // Try to receive again
        const res = await request(API_URL)
            .put(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 5,
                    cantidadRecibida: 5,
                    precioReal: 2,
                    precioUnitario: 2
                }],
                total_recibido: 10
            });

        // Should either succeed (idempotent) or return 400/409
        console.log(`📋 Double-receive attempt status: ${res.status}`);

        // Verify stock did NOT increase again
        const ingAfter = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingAfter.status === 200) {
            const stockAfterDouble = parseFloat(
                ingAfter.body?.find(i => i.id === testIngredientId)?.stock_actual
            ) || 0;
            console.log(`📊 Stock after double-receive: ${stockAfterDouble} (was: ${stockBeforeDouble})`);
            // Stock should NOT have increased
            expect(Math.abs(stockAfterDouble - stockBeforeDouble)).toBeLessThan(0.01);
        }
    });

    afterAll(async () => {
        // Cleanup: delete the order
        if (authToken && createdOrderId) {
            await request(API_URL)
                .delete(`/api/orders/${createdOrderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: Order ${createdOrderId} deleted`);
        }
    });
});
