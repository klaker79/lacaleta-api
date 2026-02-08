/**
 * ============================================
 * tests/critical/delete-order-preserves-purchases.test.js
 * ============================================
 *
 * REGRESSION TEST: Verifica que borrar un pedido NO elimina
 * las compras diarias de OTROS pedidos del mismo día.
 *
 * Bug original: DELETE /api/orders/:id borraba TODAS las
 * entradas de precios_compra_diarios del día, no solo las
 * del pedido borrado.
 *
 * Fix: Ahora usa UPDATE-subtract + DELETE-if-≤0, protegiendo
 * las compras de otros pedidos.
 *
 * @author MindLoopIA
 * @date 2026-02-08
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('DELETE /api/orders — Preserves other orders purchases', () => {
    let authToken;
    let testIngredientId;
    let testIngredientName;
    let orderA_Id;
    let orderB_Id;
    const today = new Date().toISOString().split('T')[0];

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
            testIngredientId = res.body[0].id;
            testIngredientName = res.body[0].nombre;
            console.log(`📦 Test ingredient: ${testIngredientName} (ID: ${testIngredientId})`);
        }
    });

    it('1. Create Order A (compra mercado, recibido) for 5kg', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: today,
                estado: 'recibido',
                total: 25,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 5,
                    cantidadRecibida: 5,
                    precioReal: 5,
                    precioUnitario: 5
                }]
            });

        expect([200, 201]).toContain(res.status);
        orderA_Id = res.body.id;
        console.log(`📋 Order A created: ID ${orderA_Id}`);
    });

    it('2. Create Order B (compra mercado, recibido) for 3kg', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: today,
                estado: 'recibido',
                total: 15,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 3,
                    cantidadRecibida: 3,
                    precioReal: 5,
                    precioUnitario: 5
                }]
            });

        expect([200, 201]).toContain(res.status);
        orderB_Id = res.body.id;
        console.log(`📋 Order B created: ID ${orderB_Id}`);
    });

    it('3. Verify Diario has combined purchases (8kg total)', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .get(`/api/daily/purchases?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            const entry = res.body.find(e =>
                (e.ingrediente_id || e.ingredienteId) === testIngredientId
            );

            if (entry) {
                const cantidad = parseFloat(entry.cantidad_comprada || entry.cantidadComprada || 0);
                console.log(`📊 Diario before delete: ${cantidad}kg`);
                // Should be 5 + 3 = 8 (or at least > 5)
                expect(cantidad).toBeGreaterThanOrEqual(8);
            }
        }
    });

    it('4. ⚡ CRITICAL: Delete Order A — Order B purchases must SURVIVE', async () => {
        if (!authToken || !orderA_Id) return;

        // Delete order A (5kg)
        const deleteRes = await request(API_URL)
            .delete(`/api/orders/${orderA_Id}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(deleteRes.status);
        console.log(`🗑️ Order A deleted (ID: ${orderA_Id})`);

        // Check Diario — Order B's 3kg MUST still be there
        const diarioRes = await request(API_URL)
            .get(`/api/daily/purchases?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (diarioRes.status === 200) {
            const entry = diarioRes.body.find(e =>
                (e.ingrediente_id || e.ingredienteId) === testIngredientId
            );

            if (entry) {
                const cantidadRestante = parseFloat(entry.cantidad_comprada || entry.cantidadComprada || 0);
                console.log(`📊 Diario after deleting Order A: ${cantidadRestante}kg`);

                // CRITICAL ASSERTION:
                // If the old buggy code ran, this would be 0 (all purchases deleted)
                // With the fix, it should be 3 (only Order A's 5kg subtracted)
                expect(cantidadRestante).toBeGreaterThanOrEqual(3);
                expect(cantidadRestante).toBeLessThan(8); // Should not still be 8
            } else {
                // If no entry found, the bug is back — all purchases were deleted
                console.error('❌ BUG REGRESSION: All daily purchases were deleted!');
                expect(entry).toBeTruthy(); // Force fail
            }
        }
    });

    afterAll(async () => {
        // Cleanup: delete Order B
        if (authToken && orderB_Id) {
            await request(API_URL)
                .delete(`/api/orders/${orderB_Id}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🧹 Cleanup: Order B deleted (ID: ${orderB_Id})`);
        }
    });
});
