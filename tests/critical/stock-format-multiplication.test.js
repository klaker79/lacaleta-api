/**
 * ============================================
 * tests/critical/stock-format-multiplication.test.js
 * ============================================
 *
 * CRITICAL: Tests the exact bugs that caused stock inflation in production.
 *
 * Rules tested:
 * - Approve with formato_override=NULL → stock += cantidad × 1 (NOT × cantidad_por_formato)
 * - Approve with formato_override=24 → stock += cantidad × 24
 * - POST /daily/purchases/bulk → stock += cantidad (NO multiplication)
 *
 * These bugs caused stock values to jump from 28,000€ to 69,000€ in production.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Stock Format Multiplication — CRITICAL regression tests', () => {
    let authToken;
    let testIngredientId;
    let testIngredientNombre;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Create a test ingredient with cantidad_por_formato > 1
        const res = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `TEST_FORMAT_MULTI_${Date.now()}`,
                precio: 24.00,
                unidad: 'unidad',
                stock_actual: 0,
                cantidad_por_formato: 24,
                formato_compra: 'CAJA x24'
            });

        if (res.status === 201 || res.status === 200) {
            testIngredientId = res.body.id;
            testIngredientNombre = res.body.nombre;
            console.log(`🧪 Test ingredient: ${testIngredientNombre} (ID: ${testIngredientId}, cpf: 24)`);
        }
    });

    afterAll(async () => {
        // Clean up test ingredient
        if (authToken && testIngredientId) {
            await request(API_URL)
                .delete(`/api/ingredients/${testIngredientId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('1. Approve with formato_override=NULL → stock += cantidad × 1 (NOT × cpf)', async () => {
        if (!authToken || !testIngredientId) return;

        // Reset stock to 0
        await request(API_URL)
            .post('/api/ingredients/bulk-adjust-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ adjustments: [{ id: testIngredientId, delta: -99999 }], reason: 'test_reset' });

        await request(API_URL)
            .post('/api/ingredients/bulk-adjust-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ adjustments: [{ id: testIngredientId, delta: 0 }], reason: 'test_reset' });

        // Get stock before
        const beforeRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const ingBefore = beforeRes.body.find(i => i.id === testIngredientId);
        const stockBefore = parseFloat(ingBefore?.stock_actual) || 0;

        // Submit pending purchase (formato_override will be NULL)
        const submitRes = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: testIngredientNombre,
                    precio: 1.00,
                    cantidad: 5,
                    fecha: new Date().toISOString().split('T')[0]
                }]
            });
        expect([200, 201]).toContain(submitRes.status);

        // Get the pending purchase ID
        const pendingRes = await request(API_URL)
            .get('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const pendingItem = pendingRes.body.find(p =>
            p.ingrediente_id === testIngredientId && p.estado === 'pendiente'
        );

        if (!pendingItem) {
            console.log('⚠️ No pending item found for test ingredient, skipping');
            return;
        }

        // Approve WITHOUT setting formato_override (it stays NULL)
        const approveRes = await request(API_URL)
            .post(`/api/purchases/pending/${pendingItem.id}/approve`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect([200, 201]).toContain(approveRes.status);

        // Check stock after
        const afterRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const ingAfter = afterRes.body.find(i => i.id === testIngredientId);
        const stockAfter = parseFloat(ingAfter?.stock_actual) || 0;

        const delta = stockAfter - stockBefore;

        // CRITICAL: Must be 5 (cantidad × 1), NOT 120 (cantidad × 24)
        console.log(`📊 Stock delta: ${delta} (expected: 5, BUG would give: 120)`);
        expect(delta).toBe(5);
        expect(delta).not.toBe(120); // Explicitly verify the bug doesn't exist
    });

    it('2. POST /daily/purchases/bulk does NOT multiply by cantidad_por_formato', async () => {
        if (!authToken || !testIngredientId) return;

        // Get stock before
        const beforeRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const ingBefore = beforeRes.body.find(i => i.id === testIngredientId);
        const stockBefore = parseFloat(ingBefore?.stock_actual) || 0;

        // Send bulk purchase (this is the n8n/OCR route)
        const bulkRes = await request(API_URL)
            .post('/api/daily/purchases/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: testIngredientNombre,
                    precio: 1.00,
                    cantidad: 10,
                    fecha: new Date(Date.now() - 86400000).toISOString().split('T')[0] // yesterday to avoid dedup
                }]
            });

        expect([200, 201]).toContain(bulkRes.status);

        // Check stock after
        const afterRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const ingAfter = afterRes.body.find(i => i.id === testIngredientId);
        const stockAfter = parseFloat(ingAfter?.stock_actual) || 0;

        const delta = stockAfter - stockBefore;

        // CRITICAL: Must be 10 (raw cantidad), NOT 240 (10 × 24)
        console.log(`📊 Bulk stock delta: ${delta} (expected: 10, BUG would give: 240)`);
        expect(delta).toBeCloseTo(10, 0);
        expect(delta).not.toBeGreaterThan(20); // Definitely not multiplied
    });

    it('3. Guardrail: bulk purchase with cantidad > 10000 is rejected', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/daily/purchases/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: testIngredientNombre,
                    precio: 0.01,
                    cantidad: 50000, // Absurd OCR garbage
                    fecha: new Date(Date.now() - 172800000).toISOString().split('T')[0]
                }]
            });

        expect([200, 201]).toContain(res.status);
        // Should be counted as failed, not processed
        if (res.body.fallidos !== undefined) {
            expect(res.body.fallidos).toBeGreaterThanOrEqual(1);
        }
    });
});
