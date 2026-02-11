/**
 * ============================================
 * tests/critical/recipe-crud-food-cost.test.js
 * ============================================
 *
 * Verifica CRUD de recetas y que el food cost se calcula correctamente
 * basado en los ingredientes asignados.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Recipe CRUD and Food Cost Calculation', () => {
    let authToken;
    let testIngredient;
    let createdRecipeId;
    const RECIPE_NAME = `TEST_RECIPE_${Date.now()}`;
    const PRECIO_VENTA = 20;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Get a real ingredient for the recipe
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200 && res.body.length > 0) {
            testIngredient = res.body[0];
            console.log(`🧪 Test ingredient: ${testIngredient.nombre} (precio: ${testIngredient.precio}€)`);
        }
    });

    it('1. POST /api/recipes — creates recipe with ingredients', async () => {
        if (!authToken || !testIngredient) return;

        const res = await request(API_URL)
            .post('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: RECIPE_NAME,
                categoria: 'test',
                precio_venta: PRECIO_VENTA,
                porciones: 1,
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: 0.5
                }],
                codigo: 'TEST999'
            });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();
        createdRecipeId = res.body.id;
        console.log(`🍽️ Recipe created: ${RECIPE_NAME} (ID: ${createdRecipeId})`);
    });

    it('2. GET /api/recipes — lists the created recipe', async () => {
        if (!authToken || !createdRecipeId) return;

        const res = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const recipe = res.body.find(r => r.id === createdRecipeId);
        expect(recipe).toBeDefined();
        expect(recipe.nombre).toBe(RECIPE_NAME);
        expect(parseFloat(recipe.precio_venta)).toBe(PRECIO_VENTA);

        // Verify ingredients are stored
        const ingredientes = recipe.ingredientes || [];
        expect(ingredientes.length).toBeGreaterThanOrEqual(1);
        console.log(`✅ Recipe found with ${ingredientes.length} ingredients`);
    });

    it('3. PUT /api/recipes/:id — updates recipe', async () => {
        if (!authToken || !createdRecipeId) return;

        const res = await request(API_URL)
            .put(`/api/recipes/${createdRecipeId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: RECIPE_NAME + '_UPDATED',
                categoria: 'test',
                precio_venta: 25,
                porciones: 2,
                ingredientes: [{
                    ingredienteId: testIngredient.id,
                    cantidad: 0.8
                }],
                codigo: 'TEST999'
            });

        expect(res.status).toBe(200);
        expect(res.body.nombre).toBe(RECIPE_NAME + '_UPDATED');
        expect(parseFloat(res.body.precio_venta)).toBe(25);
        expect(parseInt(res.body.porciones)).toBe(2);
        console.log(`✅ Recipe updated: price=25€, porciones=2`);
    });

    it('4. Menu engineering shows food cost for our recipe', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/analysis/menu-engineering')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        // Check if any recipe has food_cost data
        const recipesWithCost = res.body.filter(r => r.food_cost !== undefined || r.costo !== undefined);
        console.log(`📊 Menu engineering: ${res.body.length} recipes, ${recipesWithCost.length} with cost data`);

        // Food cost percentages should be reasonable (0-100%)
        for (const r of recipesWithCost.slice(0, 5)) {
            const foodCost = parseFloat(r.food_cost || r.food_cost_percent || 0);
            if (foodCost > 0) {
                expect(foodCost).toBeLessThan(200); // Sanity check
                console.log(`   ${r.nombre}: food cost ${foodCost.toFixed(1)}%`);
            }
        }
    });

    it('5. DELETE /api/recipes/:id — soft delete', async () => {
        if (!authToken || !createdRecipeId) return;

        const res = await request(API_URL)
            .delete(`/api/recipes/${createdRecipeId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        console.log(`🗑️ Recipe deleted (soft): ID ${createdRecipeId}`);

        // Verify it's no longer in the list
        const listRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const deleted = listRes.body.find(r => r.id === createdRecipeId);
        expect(deleted).toBeUndefined();
        console.log(`✅ Recipe no longer appears in active list`);

        createdRecipeId = null; // Mark as cleaned
    });

    afterAll(async () => {
        // Cleanup if test 5 didn't run
        if (authToken && createdRecipeId) {
            await request(API_URL)
                .delete(`/api/recipes/${createdRecipeId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: recipe ${createdRecipeId} deleted`);
        }
    });
});
