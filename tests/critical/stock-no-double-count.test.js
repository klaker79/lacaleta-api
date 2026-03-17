/**
 * ============================================
 * tests/critical/stock-no-double-count.test.js
 * ============================================
 *
 * CRITICAL: Verifies that stock is NOT double-counted when receiving orders.
 *
 * The frontend flow for receiving a pedido is:
 *   1. bulkAdjustStock(delta) — delta = cantidadRecibida × cantidad_por_formato
 *   2. PUT /orders/:id with estado='recibido'
 *
 * The backend PUT must NOT also add stock (that would double it).
 * The backend only records Diario (precios_compra_diarios).
 *
 * Similarly for compra mercado (POST /orders with estado='recibido'):
 *   1. POST /orders (records Diario, but must NOT add stock)
 *   2. bulkAdjustStock(delta) — delta = raw cantidad (base units)
 *
 * This test was written after a production bug where stock was inflated 2x
 * on every received order (worse for items with cantidad_por_formato > 1).
 *
 * @author MindLoopIA
 * @date 2026-02-24
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

// Helper: get fresh stock for an ingredient
async function getStock(authToken, ingredientId) {
    const res = await request(API_URL)
        .get('/api/ingredients')
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200) return null;
    const ing = res.body.find(i => i.id === ingredientId);
    return ing ? parseFloat(ing.stock_actual) || 0 : null;
}

describe('Stock No Double Count — Order Reception', () => {
    let authToken;
    let testIngredient; // { id, nombre, cantidad_por_formato, stock_actual }
    let createdOrderId;
    let stockBeforeAll;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No auth. Tests skipped.');
            return;
        }

        // Find an ingredient with cantidad_por_formato > 1 (the most vulnerable case)
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status !== 200 || ingRes.body.length === 0) {
            console.warn('⚠️ No ingredients found. Tests skipped.');
            return;
        }

        // Prefer ingredient with formato > 1 to make the bug obvious
        const withFormato = ingRes.body.find(i =>
            parseFloat(i.cantidad_por_formato) > 1
        );
        const fallback = ingRes.body[ingRes.body.length - 1]; // last = least-used
        const chosen = withFormato || fallback;

        testIngredient = {
            id: chosen.id,
            nombre: chosen.nombre,
            cantidad_por_formato: parseFloat(chosen.cantidad_por_formato) || 1,
            stock_actual: parseFloat(chosen.stock_actual) || 0
        };
        stockBeforeAll = testIngredient.stock_actual;

        console.log(`📦 Test ingredient: ${testIngredient.nombre} (ID: ${testIngredient.id})`);
        console.log(`   cantidad_por_formato: ${testIngredient.cantidad_por_formato}`);
        console.log(`   stock_actual: ${testIngredient.stock_actual}`);
    });

    // ─── TEST 1: PUT /orders/:id does NOT add stock ───────────────────

    it('1. Create a pending order', async () => {
        if (!authToken || !testIngredient) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: new Date().toISOString().split('T')[0],
                estado: 'pendiente',
                total: 20,
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: 5,
                    precioUnitario: 4
                }]
            });

        expect([200, 201]).toContain(res.status);
        createdOrderId = res.body.id;
        console.log(`📋 Pending order created: ID ${createdOrderId}`);
    });

    it('2. Pending order should NOT change stock', async () => {
        if (!authToken || !testIngredient) return;

        const stockNow = await getStock(authToken, testIngredient.id);
        expect(stockNow).toBeCloseTo(stockBeforeAll, 1);
        console.log(`✅ Stock after pending order: ${stockNow} (unchanged from ${stockBeforeAll})`);
    });

    it('3. Simulate frontend: bulkAdjustStock with pre-multiplied delta', async () => {
        if (!authToken || !testIngredient) return;

        // Frontend multiplies: cantidadRecibida × cantidad_por_formato
        const cantidadRecibida = 5;
        const delta = cantidadRecibida * testIngredient.cantidad_por_formato;

        const res = await request(API_URL)
            .post('/api/ingredients/bulk-adjust-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                adjustments: [{ id: testIngredient.id, delta }],
                reason: 'test_recepcion_pedido'
            });

        expect(res.status).toBe(200);
        const result = res.body.results.find(r => r.id === testIngredient.id);
        expect(result).toBeDefined();
        expect(result.stock_actual).toBeCloseTo(stockBeforeAll + delta, 1);
        console.log(`✅ bulkAdjustStock +${delta}: stock = ${result.stock_actual}`);
    });

    it('4. CRITICAL: PUT /orders/:id to recibido must NOT add stock again', async () => {
        if (!authToken || !testIngredient || !createdOrderId) return;

        const stockBeforePut = await getStock(authToken, testIngredient.id);
        const expectedDelta = 5 * testIngredient.cantidad_por_formato;
        // Stock should already reflect the bulkAdjustStock call
        expect(stockBeforePut).toBeCloseTo(stockBeforeAll + expectedDelta, 1);

        // Now mark order as received (backend should only record Diario, NOT stock)
        const res = await request(API_URL)
            .put(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: 5,
                    cantidadRecibida: 5,
                    precioReal: 4,
                    precioUnitario: 4
                }],
                total_recibido: 20
            });

        expect([200, 201]).toContain(res.status);

        // CRITICAL CHECK: Stock must be the same as before PUT
        const stockAfterPut = await getStock(authToken, testIngredient.id);
        expect(stockAfterPut).toBeCloseTo(stockBeforePut, 1);
        console.log(`✅ Stock after PUT: ${stockAfterPut} (same as ${stockBeforePut} — no double count)`);

        // If this fails, the bug is back: backend is adding stock on PUT
        if (Math.abs(stockAfterPut - stockBeforePut) > 1) {
            console.error(`❌ DOUBLE COUNT DETECTED: stock went from ${stockBeforePut} to ${stockAfterPut}`);
            console.error(`   Expected delta: 0 (frontend already adjusted)`);
            console.error(`   Actual delta: ${stockAfterPut - stockBeforePut}`);
        }
    });

    it('5. DELETE order should revert stock correctly', async () => {
        if (!authToken || !testIngredient || !createdOrderId) return;

        const stockBeforeDelete = await getStock(authToken, testIngredient.id);

        const res = await request(API_URL)
            .delete(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(res.status);

        const stockAfterDelete = await getStock(authToken, testIngredient.id);
        const expectedRevert = 5 * testIngredient.cantidad_por_formato;

        // Stock should decrease by exactly the same amount that was added
        expect(stockAfterDelete).toBeCloseTo(stockBeforeDelete - expectedRevert, 1);
        console.log(`✅ DELETE reverted: ${stockBeforeDelete} → ${stockAfterDelete} (delta: -${expectedRevert})`);

        createdOrderId = null; // Already deleted, skip afterAll cleanup
    });

    it('6. Stock should be back to original value', async () => {
        if (!authToken || !testIngredient) return;

        const stockFinal = await getStock(authToken, testIngredient.id);
        expect(stockFinal).toBeCloseTo(stockBeforeAll, 1);
        console.log(`✅ Final stock: ${stockFinal} ≈ original ${stockBeforeAll}`);
    });

    afterAll(async () => {
        // Cleanup if order wasn't deleted during tests
        if (authToken && createdOrderId) {
            await request(API_URL)
                .delete(`/api/orders/${createdOrderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: Order ${createdOrderId} deleted`);
        }
        // Restore stock to original if tests left it different
        if (authToken && testIngredient) {
            const finalStock = await getStock(authToken, testIngredient.id);
            if (finalStock !== null && Math.abs(finalStock - stockBeforeAll) > 0.5) {
                const correction = stockBeforeAll - finalStock;
                await request(API_URL)
                    .post(`/api/ingredients/${testIngredient.id}/adjust-stock`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({ delta: correction, reason: 'test_cleanup_restore' });
                console.log(`🧹 Stock restored: ${finalStock} → ${stockBeforeAll} (delta: ${correction})`);
            }
        }
    });
});

describe('Stock No Double Count — Compra Mercado (POST as recibido)', () => {
    let authToken;
    let testIngredient;
    let createdOrderId;
    let stockBeforeAll;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status !== 200 || ingRes.body.length === 0) return;

        // Use last ingredient to minimize impact on real data
        const chosen = ingRes.body[ingRes.body.length - 1];
        testIngredient = {
            id: chosen.id,
            nombre: chosen.nombre,
            cantidad_por_formato: parseFloat(chosen.cantidad_por_formato) || 1,
            stock_actual: parseFloat(chosen.stock_actual) || 0
        };
        stockBeforeAll = testIngredient.stock_actual;
        console.log(`📦 Compra mercado test: ${testIngredient.nombre} (ID: ${testIngredient.id}), stock: ${stockBeforeAll}`);
    });

    it('7. CRITICAL: POST /orders with estado=recibido must NOT add stock', async () => {
        if (!authToken || !testIngredient) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: new Date().toISOString().split('T')[0],
                estado: 'recibido',
                total: 15,
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: 3,
                    precioUnitario: 5
                }]
            });

        expect([200, 201]).toContain(res.status);
        createdOrderId = res.body.id;

        // CRITICAL: Stock should NOT have changed — frontend will do bulkAdjustStock
        const stockAfterPost = await getStock(authToken, testIngredient.id);
        expect(stockAfterPost).toBeCloseTo(stockBeforeAll, 1);
        console.log(`✅ POST recibido: stock ${stockAfterPost} (unchanged from ${stockBeforeAll})`);

        if (Math.abs(stockAfterPost - stockBeforeAll) > 1) {
            console.error(`❌ BACKEND ADDED STOCK on POST: ${stockBeforeAll} → ${stockAfterPost}`);
        }
    });

    it('8. Frontend bulkAdjustStock adds correct raw delta (no formato multiplication)', async () => {
        if (!authToken || !testIngredient) return;

        // For compra mercado, frontend sends raw delta (base units, no formato multiplication)
        const rawDelta = 3;

        const res = await request(API_URL)
            .post('/api/ingredients/bulk-adjust-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                adjustments: [{ id: testIngredient.id, delta: rawDelta }],
                reason: 'test_compra_mercado'
            });

        expect(res.status).toBe(200);
        const result = res.body.results.find(r => r.id === testIngredient.id);
        expect(result.stock_actual).toBeCloseTo(stockBeforeAll + rawDelta, 1);
        console.log(`✅ bulkAdjustStock +${rawDelta}: stock = ${result.stock_actual}`);
    });

    it('9. Total stock delta should be exactly the raw cantidad (no double, no formato multiply)', async () => {
        if (!authToken || !testIngredient) return;

        const stockNow = await getStock(authToken, testIngredient.id);
        const totalDelta = stockNow - stockBeforeAll;

        // For compra mercado with cantidad=3, the total delta should be exactly 3
        // NOT 3 × cantidad_por_formato, and NOT 3 + 3 × cantidad_por_formato
        expect(totalDelta).toBeCloseTo(3, 1);
        console.log(`✅ Total delta: ${totalDelta} (expected: 3)`);

        if (testIngredient.cantidad_por_formato > 1) {
            const wrongDouble = 3 + 3 * testIngredient.cantidad_por_formato;
            const wrongBackendOnly = 3 * testIngredient.cantidad_por_formato;
            if (Math.abs(totalDelta - wrongDouble) < 1) {
                console.error(`❌ DOUBLE COUNT: delta=${totalDelta} matches wrong value ${wrongDouble}`);
            }
            if (Math.abs(totalDelta - wrongBackendOnly) < 1) {
                console.error(`❌ BACKEND MULTIPLIED: delta=${totalDelta} matches wrong value ${wrongBackendOnly}`);
            }
        }
    });

    afterAll(async () => {
        if (authToken && createdOrderId) {
            await request(API_URL)
                .delete(`/api/orders/${createdOrderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: Order ${createdOrderId} deleted`);
        }
        // Restore stock
        if (authToken && testIngredient) {
            const finalStock = await getStock(authToken, testIngredient.id);
            if (finalStock !== null && Math.abs(finalStock - stockBeforeAll) > 0.5) {
                const correction = stockBeforeAll - finalStock;
                await request(API_URL)
                    .post(`/api/ingredients/${testIngredient.id}/adjust-stock`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({ delta: correction, reason: 'test_cleanup_restore' });
                console.log(`🧹 Stock restored: ${finalStock} → ${stockBeforeAll}`);
            }
        }
    });
});

describe('Stock No Double Count — DELETE reversal accuracy', () => {
    let authToken;
    let testIngredient;
    let createdOrderId;
    let stockBeforeAll;
    const CANTIDAD = 4;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status !== 200 || ingRes.body.length === 0) return;

        // Find one with formato > 1
        const withFormato = ingRes.body.find(i => parseFloat(i.cantidad_por_formato) > 1);
        const chosen = withFormato || ingRes.body[ingRes.body.length - 1];
        testIngredient = {
            id: chosen.id,
            nombre: chosen.nombre,
            cantidad_por_formato: parseFloat(chosen.cantidad_por_formato) || 1
        };
        stockBeforeAll = parseFloat(chosen.stock_actual) || 0;
        console.log(`📦 DELETE test: ${testIngredient.nombre}, formato: ${testIngredient.cantidad_por_formato}, stock: ${stockBeforeAll}`);
    });

    it('10. Full cycle: create → bulkAdjust → receive → delete → stock restored', async () => {
        if (!authToken || !testIngredient) return;

        const cantFormato = testIngredient.cantidad_por_formato;
        const expectedDelta = CANTIDAD * cantFormato;

        // Step 1: Create pending order
        const createRes = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: new Date().toISOString().split('T')[0],
                estado: 'pendiente',
                total: CANTIDAD * 3,
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: CANTIDAD,
                    precioUnitario: 3
                }]
            });
        expect([200, 201]).toContain(createRes.status);
        createdOrderId = createRes.body.id;

        // Step 2: Frontend bulkAdjustStock (simulating recepción)
        const adjustRes = await request(API_URL)
            .post('/api/ingredients/bulk-adjust-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                adjustments: [{ id: testIngredient.id, delta: expectedDelta }],
                reason: 'test_full_cycle'
            });
        expect(adjustRes.status).toBe(200);
        const stockAfterAdjust = adjustRes.body.results.find(r => r.id === testIngredient.id)?.stock_actual;

        // Step 3: PUT to mark as received
        const putRes = await request(API_URL)
            .put(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: CANTIDAD,
                    cantidadRecibida: CANTIDAD,
                    precioReal: 3,
                    precioUnitario: 3
                }],
                total_recibido: CANTIDAD * 3
            });
        expect([200, 201]).toContain(putRes.status);

        // Verify stock didn't change from PUT
        const stockAfterPut = await getStock(authToken, testIngredient.id);
        expect(stockAfterPut).toBeCloseTo(stockAfterAdjust, 1);

        // Step 4: DELETE order
        const delRes = await request(API_URL)
            .delete(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        expect([200, 204]).toContain(delRes.status);
        createdOrderId = null;

        // Step 5: Verify stock is back to original
        const stockFinal = await getStock(authToken, testIngredient.id);
        expect(stockFinal).toBeCloseTo(stockBeforeAll, 1);

        console.log(`✅ Full cycle: ${stockBeforeAll} → +${expectedDelta} → PUT(no change) → DELETE(-${expectedDelta}) → ${stockFinal}`);

        if (Math.abs(stockFinal - stockBeforeAll) > 1) {
            console.error(`❌ Stock drift after full cycle: started=${stockBeforeAll}, ended=${stockFinal}, drift=${stockFinal - stockBeforeAll}`);
        }
    });

    afterAll(async () => {
        if (authToken && createdOrderId) {
            await request(API_URL)
                .delete(`/api/orders/${createdOrderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
        if (authToken && testIngredient) {
            const finalStock = await getStock(authToken, testIngredient.id);
            if (finalStock !== null && Math.abs(finalStock - stockBeforeAll) > 0.5) {
                const correction = stockBeforeAll - finalStock;
                await request(API_URL)
                    .post(`/api/ingredients/${testIngredient.id}/adjust-stock`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({ delta: correction, reason: 'test_cleanup_restore' });
                console.log(`🧹 Stock restored: ${finalStock} → ${stockBeforeAll}`);
            }
        }
    });
});
