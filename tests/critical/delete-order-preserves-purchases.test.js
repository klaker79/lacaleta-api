/**
 * ============================================
 * tests/critical/delete-order-preserves-purchases.test.js
 * ============================================
 *
 * REGRESSION TEST: Verifica que borrar un pedido NO elimina
 * las compras diarias de OTROS pedidos del mismo día.
 *
 * Bug original: DELETE /api/orders/:id borraba TODAS las
 * entradas de precios_compra_diarios del día.
 *
 * Fix (Stabilization v1): Cada pedido tiene su propia fila
 * en precios_compra_diarios (UNIQUE constraint incluye pedido_id).
 * DELETE usa pedido_id para borrar solo las filas del pedido eliminado.
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

    it('3. Verify Diario has purchases from both orders', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .get(`/api/daily/purchases?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            // With the new constraint, there should be SEPARATE entries for each order
            const entries = res.body.filter(e =>
                (e.ingrediente_id || e.ingredienteId) === testIngredientId
            );

            // Sum total across all matching entries
            const totalCantidad = entries.reduce((sum, e) => {
                return sum + parseFloat(e.cantidad_comprada || e.cantidadComprada || 0);
            }, 0);

            console.log(`📊 Diario entries found: ${entries.length}, total qty: ${totalCantidad}kg`);
            // Should be at least 8 (5 from A + 3 from B)
            expect(totalCantidad).toBeGreaterThanOrEqual(8);
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
            const entries = diarioRes.body.filter(e =>
                (e.ingrediente_id || e.ingredienteId) === testIngredientId
            );

            const totalCantidadRestante = entries.reduce((sum, e) => {
                return sum + parseFloat(e.cantidad_comprada || e.cantidadComprada || 0);
            }, 0);

            console.log(`📊 Diario after deleting Order A: ${totalCantidadRestante}kg (entries: ${entries.length})`);

            // CRITICAL ASSERTIONS:
            // 1. Order B's 3kg MUST still exist
            expect(totalCantidadRestante).toBeGreaterThanOrEqual(3);
            // 2. Order A's 5kg should be gone
            expect(totalCantidadRestante).toBeLessThan(8);

            // Verify no entry has the deleted order's pedido_id
            const entriesWithDeletedOrderId = entries.filter(e => e.pedido_id === orderA_Id);
            expect(entriesWithDeletedOrderId.length).toBe(0);
        } else {
            // If Diario endpoint fails, force fail with descriptive message
            expect(diarioRes.status).toBe(200);
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
