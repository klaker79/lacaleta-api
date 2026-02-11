/**
 * ═══════════════════════════════════════════════════
 * 🔗 INGREDIENT-SUPPLIER RELATIONS — Multi-supplier management
 * ═══════════════════════════════════════════════════
 * Tests the many-to-many relationship between ingredients and suppliers:
 * 1. GET /api/ingredients-suppliers — lists all relations
 * 2. POST /api/ingredients/:id/suppliers — creates relation with validation
 * 3. POST without required fields → 400
 * 4. GET /api/ingredients/:id/suppliers — lists suppliers for ingredient
 * 5. DELETE /api/ingredients/:id/suppliers/:supplierId — removes relation
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Ingredient-Supplier Relations — Multi-supplier management', () => {
    let authToken;
    let testIngredientId;
    let testSupplierId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Get an existing ingredient to test with
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.body.length > 0) {
            testIngredientId = ingRes.body[0].id;
            console.log(`📦 Using ingredient #${testIngredientId}: ${ingRes.body[0].nombre}`);
        }

        // Get an existing supplier to test with
        const supRes = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (supRes.body.length > 0) {
            // Find a supplier NOT already associated, or just use first
            testSupplierId = supRes.body[supRes.body.length - 1].id;
            console.log(`🏢 Using supplier #${testSupplierId}: ${supRes.body[supRes.body.length - 1].nombre}`);
        }
    });

    afterAll(async () => {
        // Cleanup: remove the test relation if created
        if (authToken && testIngredientId && testSupplierId) {
            await request(API_URL)
                .delete(`/api/ingredients/${testIngredientId}/suppliers/${testSupplierId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('1. GET /api/ingredients-suppliers — lists all relations', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/ingredients-suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        console.log(`✅ ${res.body.length} ingredient-supplier relations found`);
    });

    it('2. POST /api/ingredients/:id/suppliers — creates relation', async () => {
        if (!authToken || !testIngredientId || !testSupplierId) return;

        const res = await request(API_URL)
            .post(`/api/ingredients/${testIngredientId}/suppliers`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedor_id: testSupplierId,
                precio: 12.50,
                es_proveedor_principal: false
            });

        expect(res.status).toBe(201);
        expect(res.body.ingrediente_id).toBe(testIngredientId);
        expect(res.body.proveedor_id).toBe(testSupplierId);
        console.log(`✅ Created relation: ingredient #${testIngredientId} → supplier #${testSupplierId} @ ${res.body.precio}€`);
    });

    it('3. POST without required fields → 400', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post(`/api/ingredients/${testIngredientId}/suppliers`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({}); // Missing proveedor_id and precio

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Missing fields → ${res.status}: ${res.body.error}`);
    });

    it('4. GET /api/ingredients/:id/suppliers — lists suppliers for ingredient', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .get(`/api/ingredients/${testIngredientId}/suppliers`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        console.log(`✅ Ingredient #${testIngredientId} has ${res.body.length} suppliers`);

        if (testSupplierId) {
            const found = res.body.find(r => r.proveedor_id === testSupplierId);
            expect(found).toBeDefined();
            console.log(`   Found test supplier in list`);
        }
    });

    it('5. DELETE /api/ingredients/:id/suppliers/:supplierId — removes relation', async () => {
        if (!authToken || !testIngredientId || !testSupplierId) return;

        const res = await request(API_URL)
            .delete(`/api/ingredients/${testIngredientId}/suppliers/${testSupplierId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        console.log(`✅ Relation removed`);
    });
});
