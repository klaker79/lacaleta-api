/**
 * ============================================
 * tests/critical/atomic-stock-api.test.js
 * ============================================
 *
 * Verifica los endpoints atómicos de stock:
 * - POST /api/ingredients/:id/adjust-stock (delta unitario)
 * - POST /api/ingredients/bulk-adjust-stock (delta múltiple)
 *
 * Estos endpoints REEMPLAZAN el patrón read-modify-write
 * que causaba sobreescrituras de stock con datos stale.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Atomic Stock Endpoints', () => {
    let authToken;
    let testIngredientId;
    let testIngredientName;
    let initialStock;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        // Get a test ingredient
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200 && res.body.length > 0) {
            // Use the last ingredient to avoid touching real data like Pulpo
            const ing = res.body[res.body.length - 1];
            testIngredientId = ing.id;
            testIngredientName = ing.nombre;
            initialStock = parseFloat(ing.stock_actual) || 0;
            console.log(`📦 Test ingredient: ${testIngredientName} (ID: ${testIngredientId}), stock: ${initialStock}`);
        }
    });

    // ── Single Adjust ────────────────────────────────────────

    describe('POST /api/ingredients/:id/adjust-stock', () => {

        it('1. should add positive delta to stock', async () => {
            if (!authToken || !testIngredientId) return;

            const res = await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: 10, reason: 'test_positive_delta' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.delta).toBe(10);
            expect(res.body.stock_actual).toBeCloseTo(initialStock + 10, 1);
            console.log(`✅ Stock: ${initialStock} → ${res.body.stock_actual} (delta +10)`);
        });

        it('2. should subtract negative delta from stock', async () => {
            if (!authToken || !testIngredientId) return;

            const res = await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: -10, reason: 'test_negative_delta' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.delta).toBe(-10);
            // Should be back to initial (within floating point tolerance)
            expect(res.body.stock_actual).toBeCloseTo(initialStock, 1);
            console.log(`✅ Stock: ${initialStock + 10} → ${res.body.stock_actual} (delta -10)`);
        });

        it('3. should handle delta=0 (no-op verification)', async () => {
            if (!authToken || !testIngredientId) return;

            const res = await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: 0, reason: 'test_zero_delta' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.stock_actual).toBeCloseTo(initialStock, 1);
            console.log(`✅ Stock unchanged with delta=0: ${res.body.stock_actual}`);
        });

        it('4. ⚡ CRITICAL: stock should floor at 0 (never negative)', async () => {
            if (!authToken || !testIngredientId) return;

            // Try to subtract way more than current stock
            const hugeNegative = -(initialStock + 9999);
            const res = await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: hugeNegative, reason: 'test_floor_zero' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.stock_actual).toBe(0);
            console.log(`✅ Stock floored at 0: delta=${hugeNegative} → stock=${res.body.stock_actual}`);

            // Restore stock
            await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: initialStock, reason: 'test_restore' });
        });

        it('5. should reject missing delta', async () => {
            if (!authToken || !testIngredientId) return;

            const res = await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ reason: 'no_delta_sent' });

            expect(res.status).toBe(400);
            console.log(`✅ Rejected missing delta: ${res.body.error}`);
        });

        it('6. should reject string delta', async () => {
            if (!authToken || !testIngredientId) return;

            const res = await request(API_URL)
                .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: 'abc', reason: 'test_invalid' });

            expect(res.status).toBe(400);
            console.log(`✅ Rejected string delta: ${res.body.error}`);
        });

        it('7. should return 404 for non-existent ingredient', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/ingredients/999999/adjust-stock')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ delta: 5, reason: 'test_not_found' });

            expect(res.status).toBe(404);
            console.log(`✅ 404 for non-existent ingredient`);
        });
    });

    // ── Bulk Adjust ──────────────────────────────────────────

    describe('POST /api/ingredients/bulk-adjust-stock', () => {

        it('8. should handle multiple adjustments', async () => {
            if (!authToken || !testIngredientId) return;

            // Get a second ingredient
            const ingRes = await request(API_URL)
                .get('/api/ingredients')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            const ingredients = ingRes.body;
            if (ingredients.length < 2) {
                console.warn('⚠️ Need at least 2 ingredients for bulk test');
                return;
            }

            const ing1 = ingredients[ingredients.length - 1];
            const ing2 = ingredients[ingredients.length - 2];
            const stock1Before = parseFloat(ing1.stock_actual) || 0;
            const stock2Before = parseFloat(ing2.stock_actual) || 0;

            const res = await request(API_URL)
                .post('/api/ingredients/bulk-adjust-stock')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    adjustments: [
                        { id: ing1.id, delta: 5 },
                        { id: ing2.id, delta: -3 }
                    ],
                    reason: 'test_bulk_mixed'
                });

            expect(res.status).toBe(200);
            expect(res.body.results).toBeDefined();
            expect(res.body.results.length).toBeGreaterThanOrEqual(1);
            console.log(`✅ Bulk adjust: ${res.body.results.length} success, ${(res.body.errors || []).length} errors`);

            // Restore
            await request(API_URL)
                .post('/api/ingredients/bulk-adjust-stock')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    adjustments: [
                        { id: ing1.id, delta: -5 },
                        { id: ing2.id, delta: 3 }
                    ],
                    reason: 'test_bulk_restore'
                });
        });

        it('9. should reject empty adjustments array', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/ingredients/bulk-adjust-stock')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ adjustments: [], reason: 'test_empty' });

            expect(res.status).toBe(400);
            console.log(`✅ Rejected empty adjustments: ${res.body.error}`);
        });

        it('10. should handle partial failures gracefully', async () => {
            if (!authToken || !testIngredientId) return;

            const res = await request(API_URL)
                .post('/api/ingredients/bulk-adjust-stock')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    adjustments: [
                        { id: testIngredientId, delta: 0 },  // Valid
                        { id: 999999, delta: 5 }              // Non-existent
                    ],
                    reason: 'test_partial_failure'
                });

            expect(res.status).toBe(200);
            // Should have 1 success and 1 error
            expect(res.body.results.length).toBe(1);
            expect(res.body.errors.length).toBe(1);
            console.log(`✅ Partial failure handled: ${res.body.results.length} ok, ${res.body.errors.length} errors`);
        });
    });
});
