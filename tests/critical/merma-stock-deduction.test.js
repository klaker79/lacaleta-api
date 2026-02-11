/**
 * ============================================
 * tests/critical/merma-stock-deduction.test.js
 * ============================================
 *
 * Verifica que registrar una merma guarda el registro correctamente
 * y que borrarla restaura el stock del ingrediente.
 *
 * NOTA: POST /api/mermas NO descuenta stock (lo hace el frontend).
 * DELETE /api/mermas/:id SÍ restaura stock.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Merma — Registration and stock restoration on delete', () => {
    let authToken;
    let testIngredientId;
    let testIngredientNombre;
    let stockBefore;
    let createdMermaId;
    const MERMA_CANTIDAD = 0.5;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Find an ingredient with stock > 1 to test merma
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            const ing = res.body.find(i => parseFloat(i.stock_actual) > 1);
            if (ing) {
                testIngredientId = ing.id;
                testIngredientNombre = ing.nombre;
                stockBefore = parseFloat(ing.stock_actual);
                console.log(`🧪 Test ingredient: ${ing.nombre} (ID: ${ing.id}, stock: ${stockBefore})`);
            }
        }
    });

    it('1. POST /api/mermas — creates merma record', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/mermas')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                mermas: [{
                    ingredienteId: testIngredientId,
                    ingredienteNombre: testIngredientNombre,
                    cantidad: MERMA_CANTIDAD,
                    unidad: 'kg',
                    valorPerdida: 5.00,
                    motivo: 'Caducado',
                    nota: 'Test automático — se borrará'
                }]
            });

        expect([200, 201]).toContain(res.status);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(1);
        console.log(`🗑️ Merma creada (count: ${res.body.count})`);

        // Get the merma ID for cleanup
        const mermasRes = await request(API_URL)
            .get('/api/mermas')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (mermasRes.status === 200 && Array.isArray(mermasRes.body)) {
            const testMerma = mermasRes.body.find(m =>
                m.ingrediente_id === testIngredientId &&
                (m.nota === 'Test automático — se borrará' || m.ingrediente_nombre === testIngredientNombre)
            );
            if (testMerma) {
                createdMermaId = testMerma.id;
                console.log(`   Merma ID: ${createdMermaId}`);
            }
        }
    });

    it('2. POST /api/mermas does NOT deduct stock (frontend handles it)', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const ing = res.body.find(i => i.id === testIngredientId);
        expect(ing).toBeDefined();

        const stockAfterMerma = parseFloat(ing.stock_actual);
        console.log(`📊 Stock after merma POST: ${stockAfterMerma} (was: ${stockBefore})`);
        // POST merma should NOT change stock (that's the frontend's job)
        expect(Math.abs(stockAfterMerma - stockBefore)).toBeLessThan(0.01);
    });

    it('3. DELETE /api/mermas/:id — restores stock', async () => {
        if (!authToken || !createdMermaId) {
            console.warn('⚠️ No merma ID available, skipping');
            return;
        }

        const deleteRes = await request(API_URL)
            .delete(`/api/mermas/${createdMermaId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.success).toBe(true);
        console.log(`🗑️ Merma ${createdMermaId} eliminada`);

        // Stock should have INCREASED by merma amount (restore)
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const ing = ingRes.body.find(i => i.id === testIngredientId);
        const stockAfterDelete = parseFloat(ing.stock_actual);
        console.log(`📊 Stock after merma delete: ${stockAfterDelete} (expected: ~${stockBefore + MERMA_CANTIDAD})`);
        // Stock should be original + merma cantidad (since POST didn't deduct, but DELETE does restore)
        expect(stockAfterDelete).toBeGreaterThanOrEqual(stockBefore + MERMA_CANTIDAD - 0.01);

        createdMermaId = null; // Mark as cleaned
    });

    afterAll(async () => {
        // Cleanup: restore stock to original if needed
        if (authToken && createdMermaId) {
            await request(API_URL)
                .delete(`/api/mermas/${createdMermaId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: merma ${createdMermaId} deleted`);
        }
        // Fix stock back to original (undo the restore from DELETE)
        if (authToken && testIngredientId && stockBefore !== undefined) {
            await request(API_URL)
                .put(`/api/ingredients/${testIngredientId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ stock_actual: stockBefore });
            console.log(`🧹 Cleanup: stock restored to ${stockBefore}`);
        }
    });
});
