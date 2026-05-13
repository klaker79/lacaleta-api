/**
 * ============================================
 * tests/critical/order-edit-update-total.test.js
 * ============================================
 *
 * CRITICAL: PUT /orders/:id must persist the `total` field when editing
 * a pending order from the frontend modal.
 *
 * Bug detected 2026-04-29 (incidente Iker auditoría capa 3 staging):
 *   - Pedido pendiente creado con total=70.
 *   - Usuario edita líneas, frontend recalcula y manda total=80 en el PUT.
 *   - Backend ignoraba el campo `total` del body — la columna pedidos.total
 *     se quedaba en 70.
 *
 * Fix verificado en orders.routes.js (línea 194 + 259):
 *   - Destructuring incluye `total`.
 *   - UPDATE usa `total=COALESCE($3, total)` para preservar si llega null.
 *
 * Este test blinda contra regresión.
 *
 * @author MindLoopIA
 * @date 2026-05-13
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

async function getOrderTotal(authToken, orderId) {
    const res = await request(API_URL)
        .get('/api/orders')
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200) return null;
    const order = res.body.find(o => o.id === orderId);
    return order ? parseFloat(order.total) : null;
}

describe('PUT /orders/:id — persistencia de total al editar pendiente', () => {
    let authToken;
    let testIngredientId;
    let createdOrderId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No auth. Tests skipped.');
            return;
        }

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status !== 200 || ingRes.body.length === 0) {
            console.warn('⚠️ No ingredients found. Tests skipped.');
            return;
        }

        testIngredientId = ingRes.body[ingRes.body.length - 1].id;
    });

    afterAll(async () => {
        if (createdOrderId && authToken) {
            await request(API_URL)
                .delete(`/api/orders/${createdOrderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('1. Crear pedido pendiente con total inicial 70', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: new Date().toISOString().split('T')[0],
                estado: 'pendiente',
                total: 70,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 7,
                    precioUnitario: 10
                }]
            });

        expect([200, 201]).toContain(res.status);
        createdOrderId = res.body.id;
        expect(createdOrderId).toBeDefined();

        const totalDb = await getOrderTotal(authToken, createdOrderId);
        expect(totalDb).toBeCloseTo(70, 2);
    });

    it('2. CRITICAL: PUT con nuevo total debe persistir el cambio', async () => {
        if (!authToken || !createdOrderId) return;

        const res = await request(API_URL)
            .put(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'pendiente',
                total: 80,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 8,
                    precioUnitario: 10
                }]
            });

        expect([200, 201]).toContain(res.status);

        const totalDb = await getOrderTotal(authToken, createdOrderId);
        expect(totalDb).toBeCloseTo(80, 2);
        if (Math.abs(totalDb - 80) > 0.01) {
            console.error(`❌ REGRESION: PUT envió total=80 pero DB quedó en ${totalDb}`);
        }
    });

    it('3. PUT sin total en body debe conservar el valor anterior (COALESCE)', async () => {
        if (!authToken || !createdOrderId) return;

        const res = await request(API_URL)
            .put(`/api/orders/${createdOrderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'pendiente',
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 8,
                    precioUnitario: 10
                }]
            });

        expect([200, 201]).toContain(res.status);

        const totalDb = await getOrderTotal(authToken, createdOrderId);
        expect(totalDb).toBeCloseTo(80, 2);
    });
});
