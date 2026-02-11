/**
 * ═══════════════════════════════════════════════════
 * 🍷 RECIPE VARIANTS — Variant CRUD lifecycle
 * ═══════════════════════════════════════════════════
 * Tests variants (botella/copa, ración/media ración):
 * 1. POST /api/recipes/:id/variants — creates variant
 * 2. GET /api/recipes/:id/variants — lists variants
 * 3. PUT /api/recipes/:id/variants/:variantId — updates variant
 * 4. POST without required fields → 400
 * 5. DELETE /api/recipes/:id/variants/:variantId — deletes variant
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Recipe Variants — CRUD lifecycle', () => {
    let authToken;
    let testRecipeId;
    let createdVariantId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Create a test recipe to attach variants to
        const res = await request(API_URL)
            .post('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: '_TEST_VINO_VARIANTES_' + Date.now(),
                categoria: 'bebidas',
                precio_venta: 25.00,
                ingredientes: []
            });

        if (res.status === 201 && res.body.id) {
            testRecipeId = res.body.id;
            console.log(`📝 Created test recipe #${testRecipeId}`);
        }
    });

    afterAll(async () => {
        if (!authToken) return;
        // Cleanup variant
        if (testRecipeId && createdVariantId) {
            await request(API_URL)
                .delete(`/api/recipes/${testRecipeId}/variants/${createdVariantId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
        // Cleanup recipe
        if (testRecipeId) {
            await request(API_URL)
                .delete(`/api/recipes/${testRecipeId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🗑️ Cleaned up test recipe #${testRecipeId}`);
        }
    });

    it('1. POST /api/recipes/:id/variants — creates variant', async () => {
        if (!authToken || !testRecipeId) return;

        const res = await request(API_URL)
            .post(`/api/recipes/${testRecipeId}/variants`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: 'Botella',
                factor: 1,
                precio_venta: 25.00,
                codigo: 'V001'
            });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();
        expect(res.body.nombre).toBe('Botella');
        expect(parseFloat(res.body.precio_venta)).toBeCloseTo(25.00, 1);

        createdVariantId = res.body.id;
        console.log(`✅ Created variant #${createdVariantId}: Botella → ${res.body.precio_venta}€`);
    });

    it('2. GET /api/recipes/:id/variants — lists variants', async () => {
        if (!authToken || !testRecipeId || !createdVariantId) return;

        const res = await request(API_URL)
            .get(`/api/recipes/${testRecipeId}/variants`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const found = res.body.find(v => v.id === createdVariantId);
        expect(found).toBeDefined();
        console.log(`✅ Found variant in list (${res.body.length} variants for recipe)`);
    });

    it('3. PUT /api/recipes/:id/variants/:variantId — updates variant', async () => {
        if (!authToken || !testRecipeId || !createdVariantId) return;

        const res = await request(API_URL)
            .put(`/api/recipes/${testRecipeId}/variants/${createdVariantId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ precio_venta: 30.00, nombre: 'Botella Premium' });

        expect(res.status).toBe(200);
        expect(parseFloat(res.body.precio_venta)).toBeCloseTo(30.00, 1);
        console.log(`✅ Updated variant: precio_venta → ${res.body.precio_venta}€`);
    });

    it('4. POST without required fields → 400', async () => {
        if (!authToken || !testRecipeId) return;

        const res = await request(API_URL)
            .post(`/api/recipes/${testRecipeId}/variants`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ factor: 0.5 }); // Missing nombre and precio_venta

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Missing required fields → ${res.status}: ${res.body.error}`);
    });

    it('5. DELETE /api/recipes/:id/variants/:variantId — deletes variant', async () => {
        if (!authToken || !testRecipeId || !createdVariantId) return;

        const deleteRes = await request(API_URL)
            .delete(`/api/recipes/${testRecipeId}/variants/${createdVariantId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(deleteRes.status).toBe(200);

        // Verify no longer in list
        const listRes = await request(API_URL)
            .get(`/api/recipes/${testRecipeId}/variants`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const found = listRes.body.find(v => v.id === createdVariantId);
        expect(found).toBeUndefined();
        console.log(`✅ Variant deleted, no longer in list`);
        createdVariantId = null;
    });
});
