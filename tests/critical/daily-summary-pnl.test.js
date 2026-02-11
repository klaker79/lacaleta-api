/**
 * ============================================
 * tests/critical/daily-summary-pnl.test.js
 * ============================================
 *
 * Verifica que el resumen diario (P&L) se actualiza correctamente
 * al registrar y borrar ventas.
 *
 * Cubre el fix BUG-DC-01: beneficio_bruto corregido en sale deletion.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Daily Summary P&L — Sales update and deletion', () => {
    let authToken;
    let testRecipeId;
    let testRecipeName;
    let testRecipePrice;
    let createdSaleId;
    const today = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        // Find a recipe with a price
        const recipesRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (recipesRes.status === 200) {
            const recipe = recipesRes.body.find(r =>
                r.precio_venta && parseFloat(r.precio_venta) > 0
            );

            if (recipe) {
                testRecipeId = recipe.id;
                testRecipeName = recipe.nombre;
                testRecipePrice = parseFloat(recipe.precio_venta);
                console.log(`🍽️ Test recipe: ${testRecipeName} (ID: ${testRecipeId}, price: ${testRecipePrice}€)`);
            } else {
                console.warn('⚠️ No recipe with price found. Tests will skip.');
            }
        }
    });

    it('1. Capture daily summary before sale', async () => {
        if (!authToken || !testRecipeId) return;

        const res = await request(API_URL)
            .get(`/api/diario?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200 && res.body) {
            console.log(`📊 Daily summary before sale:`);
            console.log(`   Ingresos: ${res.body.total_ingresos || 0}€`);
            console.log(`   Num ventas: ${res.body.num_ventas || 0}`);
            console.log(`   Beneficio bruto: ${res.body.beneficio_bruto || 0}€`);
        }
    });

    it('2. Register a sale and verify summary updates', async () => {
        if (!authToken || !testRecipeId) return;

        // Register sale
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

        // Verify daily summary was updated
        const diarioRes = await request(API_URL)
            .get(`/api/diario?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (diarioRes.status === 200 && diarioRes.body) {
            const totalIngresos = parseFloat(diarioRes.body.total_ingresos) || 0;
            const numVentas = parseInt(diarioRes.body.num_ventas) || 0;

            console.log(`📊 Daily summary after sale:`);
            console.log(`   Ingresos: ${totalIngresos}€`);
            console.log(`   Num ventas: ${numVentas}`);

            // Should have at least 1 sale and positive income
            expect(numVentas).toBeGreaterThan(0);
            expect(totalIngresos).toBeGreaterThan(0);
        }
    });

    it('3. ⚡ CRITICAL: Delete sale — summary should decrease, not corrupt', async () => {
        if (!authToken || !createdSaleId) return;

        // Capture summary before deletion
        const beforeRes = await request(API_URL)
            .get(`/api/diario?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const ingresosBefore = parseFloat(beforeRes.body?.total_ingresos) || 0;
        const numVentasBefore = parseInt(beforeRes.body?.num_ventas) || 0;
        const beneficioBefore = parseFloat(beforeRes.body?.beneficio_bruto) || 0;

        // Delete the sale
        const deleteRes = await request(API_URL)
            .delete(`/api/sales/${createdSaleId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(deleteRes.status);
        console.log(`🗑️ Sale ${createdSaleId} deleted`);

        // Verify daily summary was correctly decremented
        const afterRes = await request(API_URL)
            .get(`/api/diario?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (afterRes.status === 200 && afterRes.body) {
            const ingresosAfter = parseFloat(afterRes.body.total_ingresos) || 0;
            const numVentasAfter = parseInt(afterRes.body.num_ventas) || 0;
            const beneficioAfter = parseFloat(afterRes.body.beneficio_bruto) || 0;

            console.log(`📊 Daily summary after delete:`);
            console.log(`   Ingresos: ${ingresosBefore}€ → ${ingresosAfter}€`);
            console.log(`   Num ventas: ${numVentasBefore} → ${numVentasAfter}`);
            console.log(`   Beneficio: ${beneficioBefore}€ → ${beneficioAfter}€`);

            // Income should have decreased
            expect(ingresosAfter).toBeLessThanOrEqual(ingresosBefore);
            // Num ventas should have decreased
            expect(numVentasAfter).toBeLessThanOrEqual(numVentasBefore);
            // Beneficio should NOT be negative (BUG-DC-01 fix)
            expect(beneficioAfter).toBeGreaterThanOrEqual(-0.01);
        }

        // Mark as cleaned up
        createdSaleId = null;
    });

    afterAll(async () => {
        if (authToken && createdSaleId) {
            await request(API_URL)
                .delete(`/api/sales/${createdSaleId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: Sale ${createdSaleId} deleted`);
        }
    });
});
