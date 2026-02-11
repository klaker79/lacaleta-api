/**
 * ═══════════════════════════════════════════════════
 * 📦 INVENTORY BULK UPDATE + TOGGLE ACTIVE
 * ═══════════════════════════════════════════════════
 * Tests:
 * 1. PUT /api/inventory/bulk-update-stock — updates multiple stocks at once
 * 2. PATCH /api/ingredients/:id/toggle-active — deactivates ingredient
 * 3. PATCH /api/ingredients/:id/toggle-active — reactivates ingredient
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Inventory Bulk Update + Toggle Active', () => {
    let authToken;
    let testIngredients = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Get ingredients for testing
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.body.length >= 2) {
            testIngredients = res.body.slice(0, 2);
            console.log(`📦 Using ingredients: ${testIngredients.map(i => `#${i.id} ${i.nombre}`).join(', ')}`);
        }
    });

    afterAll(async () => {
        // Restore any toggled ingredients
        if (authToken && testIngredients.length > 0) {
            await request(API_URL)
                .patch(`/api/ingredients/${testIngredients[0].id}/toggle-active`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ activo: true });
        }
    });

    it('1. PUT /api/inventory/bulk-update-stock — updates multiple stocks at once', async () => {
        if (!authToken || testIngredients.length < 2) return;

        // Save original stock values for restoration
        const originalStocks = testIngredients.map(i => ({
            id: i.id,
            stock_real: i.stock_real || 0
        }));

        const res = await request(API_URL)
            .put('/api/inventory/bulk-update-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                stocks: [
                    { id: testIngredients[0].id, stock_real: 99.9 },
                    { id: testIngredients[1].id, stock_real: 88.8 }
                ]
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.updated).toBe(2);
        console.log(`✅ Bulk updated ${res.body.updated} ingredients`);

        // Restore original values
        await request(API_URL)
            .put('/api/inventory/bulk-update-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ stocks: originalStocks });
    });

    it('2. PATCH /api/ingredients/:id/toggle-active — deactivates ingredient', async () => {
        if (!authToken || testIngredients.length === 0) return;

        const res = await request(API_URL)
            .patch(`/api/ingredients/${testIngredients[0].id}/toggle-active`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ activo: false });

        expect(res.status).toBe(200);
        expect(res.body.activo).toBe(false);
        console.log(`✅ Deactivated ingredient #${testIngredients[0].id}: ${res.body.nombre}`);
    });

    it('3. PATCH /api/ingredients/:id/toggle-active — reactivates ingredient', async () => {
        if (!authToken || testIngredients.length === 0) return;

        const res = await request(API_URL)
            .patch(`/api/ingredients/${testIngredients[0].id}/toggle-active`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ activo: true });

        expect(res.status).toBe(200);
        expect(res.body.activo).toBe(true);
        console.log(`✅ Reactivated ingredient #${testIngredients[0].id}: ${res.body.nombre}`);
    });
});
