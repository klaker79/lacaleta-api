/**
 * ============================================
 * tests/critical/transfer-stock-validation.test.js
 * ============================================
 *
 * CRITICAL: Tests that transfers do not create phantom stock.
 *
 * Bug fixed: origin deducted min(stock, cantidad) via GREATEST(0, ...),
 * but destination received full cantidad. If origin had 3 and transfer was 10,
 * origin lost 3 but destination gained 10 = 7 phantom units created.
 *
 * Fix: transfer is REJECTED if origin has insufficient stock.
 *
 * NOTE: Transfer tests require owner role across 2 restaurants.
 * These tests are skipped if the test user doesn't have multi-restaurant access.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Transfer Stock Validation', () => {
    let authToken;
    let restaurants = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Check if user has multiple restaurants
        const res = await request(API_URL)
            .get('/api/auth/my-restaurants')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200 && Array.isArray(res.body)) {
            restaurants = res.body;
        }
    });

    it('1. Transfer endpoint exists and requires auth', async () => {
        const res = await request(API_URL)
            .get('/api/transfers')
            .set('Origin', 'http://localhost:3001');

        // Should be 401 without auth, not 404
        expect(res.status).toBe(401);
    });

    it('2. Transfer with insufficient stock is rejected (no phantom stock)', async () => {
        if (!authToken || restaurants.length < 2) {
            console.log('⚠️ Skipping: need 2+ restaurants for transfer test');
            return;
        }

        const origenId = restaurants[0].id;
        const destinoId = restaurants[1].id;

        // Get an ingredient from origin
        await request(API_URL)
            .post('/api/auth/switch-restaurant')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ restauranteId: origenId });

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const testIng = ingRes.body?.find(i => parseFloat(i.stock_actual) > 0 && parseFloat(i.stock_actual) < 5);

        if (!testIng) {
            console.log('⚠️ Skipping: no ingredient with 0 < stock < 5 found');
            return;
        }

        const stockActual = parseFloat(testIng.stock_actual);
        const cantidadExcesiva = stockActual + 100; // Way more than available

        // Try transfer with excessive cantidad
        const transferRes = await request(API_URL)
            .post('/api/transfers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                ingrediente_id: testIng.id,
                origen_restaurante_id: origenId,
                destino_restaurante_id: destinoId,
                cantidad: cantidadExcesiva
            });

        // Should be rejected (400 or 403)
        console.log(`📊 Transfer ${cantidadExcesiva} units (stock: ${stockActual}): status ${transferRes.status}`);
        expect([400, 403]).toContain(transferRes.status);
    });

    it('3. Transfer endpoint returns proper error structure', async () => {
        if (!authToken) return;

        // Try with invalid data
        const res = await request(API_URL)
            .post('/api/transfers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        // Should return error, not crash
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });
});
