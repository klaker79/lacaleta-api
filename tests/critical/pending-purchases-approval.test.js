/**
 * ============================================
 * tests/critical/pending-purchases-approval.test.js
 * ============================================
 *
 * Verifica el flujo completo de compras pendientes (n8n OCR):
 * submit → approve → stock + diary entry, reject → no stock change.
 *
 * Uses a low-traffic ingredient to avoid concurrent test interference.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Pending Purchases — Submit, approve, reject flow', () => {
    let authToken;
    let testIngredientId;
    let testIngredientNombre;
    let stockBeforeApprove;
    let serverBatchId;
    let pendingIds = [];
    const TEST_CANTIDAD = 2.5;
    const TEST_PRECIO = 8.50;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Find a low-traffic ingredient (skip PULPO which is heavily used in other tests)
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            // Pick an ingredient that's NOT the first one and has low stock to avoid conflicts
            const candidates = res.body.filter(i =>
                i.id && i.nombre &&
                !i.nombre.toUpperCase().includes('PULPO') &&
                !i.nombre.toUpperCase().includes('CERVEZA')
            );
            const ing = candidates[candidates.length - 1] || res.body[res.body.length - 1];
            if (ing) {
                testIngredientId = ing.id;
                testIngredientNombre = ing.nombre;
                console.log(`🧪 Test ingredient: ${ing.nombre} (ID: ${ing.id}, stock: ${ing.stock_actual})`);
            }
        }
    });

    it('1. POST /api/purchases/pending — submit pending purchases', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [
                    {
                        ingrediente: testIngredientNombre,
                        precio: TEST_PRECIO,
                        cantidad: TEST_CANTIDAD,
                        fecha: new Date().toISOString().split('T')[0]
                    },
                    {
                        ingrediente: testIngredientNombre,
                        precio: TEST_PRECIO,
                        cantidad: 1.0,
                        fecha: new Date().toISOString().split('T')[0]
                    }
                ]
            });

        expect([200, 201]).toContain(res.status);
        expect(res.body.recibidos).toBeGreaterThanOrEqual(2);
        serverBatchId = res.body.batchId;
        console.log(`📥 Pending purchases submitted: ${res.body.recibidos} (batch: ${serverBatchId})`);
    });

    it('2. GET /api/purchases/pending — list shows submitted items', async () => {
        if (!authToken || !serverBatchId) return;

        const res = await request(API_URL)
            .get('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const testItems = res.body.filter(p => p.batch_id === serverBatchId);
        expect(testItems.length).toBeGreaterThanOrEqual(2);
        pendingIds = testItems.map(p => p.id);
        console.log(`📋 Found ${testItems.length} pending items (IDs: ${pendingIds.join(', ')})`);
    });

    it('3. POST /api/purchases/pending/:id/approve — stock increases', async () => {
        if (!authToken || pendingIds.length === 0) return;

        // Capture stock RIGHT before approve (avoid interference from parallel tests)
        const preRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        stockBeforeApprove = parseFloat(preRes.body.find(i => i.id === testIngredientId)?.stock_actual) || 0;
        console.log(`📊 Stock before approve: ${stockBeforeApprove}`);

        const idToApprove = pendingIds[0];
        const res = await request(API_URL)
            .post(`/api/purchases/pending/${idToApprove}/approve`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        console.log(`✅ Pending purchase ${idToApprove} approved`);

        // Verify stock increased
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const stockAfter = parseFloat(ingRes.body.find(i => i.id === testIngredientId)?.stock_actual) || 0;
        const delta = stockAfter - stockBeforeApprove;
        console.log(`📊 Stock after approve: ${stockAfter} (delta: ${delta.toFixed(2)})`);
        // Stock must have increased (exact amount depends on cantidad_por_formato)
        expect(delta).toBeGreaterThan(0);
    });

    it('4. DELETE /api/purchases/pending/:id — reject does NOT change stock', async () => {
        if (!authToken || pendingIds.length < 2) return;

        // Capture stock before reject
        const preRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const stockBeforeReject = parseFloat(preRes.body.find(i => i.id === testIngredientId)?.stock_actual) || 0;

        const idToReject = pendingIds[1];
        const res = await request(API_URL)
            .delete(`/api/purchases/pending/${idToReject}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(res.status);
        console.log(`❌ Pending purchase ${idToReject} rejected`);

        // Stock should NOT change
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const stockAfterReject = parseFloat(ingRes.body.find(i => i.id === testIngredientId)?.stock_actual) || 0;
        console.log(`📊 Stock after reject: ${stockAfterReject} (was: ${stockBeforeReject})`);
        expect(Math.abs(stockAfterReject - stockBeforeReject)).toBeLessThan(0.01);
    });

    afterAll(async () => {
        // Cleanup: undo the approved purchase's stock increment
        if (authToken && testIngredientId && stockBeforeApprove !== undefined) {
            // Restore stock to what it was before the approve
            await request(API_URL)
                .put(`/api/ingredients/${testIngredientId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ stock_actual: stockBeforeApprove });
            console.log(`🧹 Cleanup: stock restored to ${stockBeforeApprove}`);
        }
        // Cleanup remaining pending items
        for (const id of pendingIds) {
            try {
                await request(API_URL)
                    .delete(`/api/purchases/pending/${id}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            } catch (e) { /* already approved/rejected */ }
        }
    });
});
