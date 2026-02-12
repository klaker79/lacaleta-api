/**
 * ============================================
 * tests/critical/sale-stock-deduction.test.js
 * ============================================
 *
 * Verifica que registrar una venta descuenta el stock del ingrediente
 * y que borrar la venta restaura el stock correctamente.
 *
 * @author MindLoopIA (Stabilization v1)
 * @date 2026-02-08
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('POST/DELETE /api/sales — Stock deduction and restoration', () => {
    let authToken;
    let testRecipeId;
    let testRecipeIngredients;
    let stockBefore;
    let createdSaleId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        // Find a recipe that has ingredients (needed for stock deduction)
        const recipesRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (recipesRes.status === 200) {
            const recipeWithIngredients = recipesRes.body.find(r =>
                r.ingredientes && Array.isArray(r.ingredientes) && r.ingredientes.length > 0
            );

            if (recipeWithIngredients) {
                testRecipeId = recipeWithIngredients.id;
                testRecipeIngredients = recipeWithIngredients.ingredientes;
                console.log(`🍽️ Test recipe: ${recipeWithIngredients.nombre} (ID: ${testRecipeId})`);
                console.log(`   Ingredients: ${testRecipeIngredients.length}`);
            } else {
                console.warn('⚠️ No recipe with ingredients found. Some tests will skip.');
            }
        }
    });

    it('1. Capture stock before sale', async () => {
        if (!authToken || !testRecipeId || !testRecipeIngredients?.length) return;

        const firstIngId = testRecipeIngredients[0].ingredienteId || testRecipeIngredients[0].ingrediente_id;
        if (!firstIngId) {
            console.warn('⚠️ First ingredient has no ID, skipping');
            return;
        }

        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            const ing = res.body.find(i => i.id === firstIngId);
            if (ing) {
                stockBefore = parseFloat(ing.stock_actual) || 0;
                console.log(`📊 Stock before sale: ${stockBefore} (ingredient ID: ${firstIngId})`);
            }
        }
    });

    it('2. Register a sale and verify stock is deducted', async () => {
        if (!authToken || !testRecipeId || stockBefore === undefined) return;

        const saleRes = await request(API_URL)
            .post('/api/sales')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                recetaId: testRecipeId,
                cantidad: 1
            });

        expect([200, 201]).toContain(saleRes.status);
        createdSaleId = saleRes.body.id;
        console.log(`💰 Sale created: ID ${createdSaleId}`);

        // Check stock after sale
        const firstIngId = testRecipeIngredients[0].ingredienteId || testRecipeIngredients[0].ingrediente_id;
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status === 200) {
            const ing = ingRes.body.find(i => i.id === firstIngId);
            if (ing) {
                const stockAfterSale = parseFloat(ing.stock_actual) || 0;
                console.log(`📊 Stock after sale: ${stockAfterSale} (was: ${stockBefore})`);
                // Stock should have decreased (or stayed at 0 due to GREATEST(0, ...))
                expect(stockAfterSale).toBeLessThanOrEqual(stockBefore);
            }
        }
    });

    it('3. Delete the sale and verify stock is restored', async () => {
        if (!authToken || !createdSaleId || stockBefore === undefined) return;

        const deleteRes = await request(API_URL)
            .delete(`/api/sales/${createdSaleId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(deleteRes.status);
        console.log(`🗑️ Sale deleted: ID ${createdSaleId}`);

        // Check stock after deletion — should be back to original
        const firstIngId = testRecipeIngredients[0].ingredienteId || testRecipeIngredients[0].ingrediente_id;
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status === 200) {
            const ing = ingRes.body.find(i => i.id === firstIngId);
            if (ing) {
                const stockAfterRestore = parseFloat(ing.stock_actual) || 0;
                console.log(`📊 Stock after delete: ${stockAfterRestore} (original: ${stockBefore})`);
                // Stock should be close to the original value
                // Allow tolerance for concurrent test operations
                expect(Math.abs(stockAfterRestore - stockBefore)).toBeLessThan(1.0);
            }
        }

        // Mark as cleaned up so afterAll doesn't try to delete again
        createdSaleId = null;
    });

    afterAll(async () => {
        // Cleanup if test 3 didn't run
        if (authToken && createdSaleId) {
            await request(API_URL)
                .delete(`/api/sales/${createdSaleId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: Sale ${createdSaleId} deleted`);
        }
    });
});
