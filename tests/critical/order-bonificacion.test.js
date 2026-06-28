/**
 * ============================================
 * tests/critical/order-bonificacion.test.js
 * ============================================
 *
 * Migración 016 (2026-06-28): la BONIFICACIÓN del albarán se persiste por pedido.
 * A diferencia del IVA, el efecto en el coste lo aplica el FRONTEND (reparte la
 * bonificación bajando el precioReal de cada línea); el backend solo guarda el
 * importe para mostrarlo. Este test blinda que la columna acepta y devuelve el
 * valor, y que NO se inventa nada cuando no llega.
 *
 * @date 2026-06-28
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

async function getOrder(authToken, orderId) {
    const res = await request(API_URL)
        .get('/api/orders')
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200) return null;
    return res.body.find(o => o.id === orderId) || null;
}

describe('Pedidos — bonificación del albarán persistente (Migración 016)', () => {
    let authToken;
    let testIngredientId;
    let orderId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) { console.warn('⚠️ No auth. Tests skipped.'); return; }
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (ingRes.status !== 200 || ingRes.body.length === 0) { console.warn('⚠️ No ingredients. Skipped.'); return; }
        testIngredientId = ingRes.body[ingRes.body.length - 1].id;
    });

    afterAll(async () => {
        if (orderId && authToken) {
            await request(API_URL)
                .delete(`/api/orders/${orderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('1. POST sin bonificación → null (flujo histórico no se rompe)', async () => {
        if (!authToken || !testIngredientId) return;
        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ proveedorId: null, fecha: new Date().toISOString().split('T')[0], estado: 'pendiente', total: 100,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 1, precioUnitario: 100 }] });
        expect([200, 201]).toContain(res.status);
        orderId = res.body.id;
        const order = await getOrder(authToken, orderId);
        expect(order.bonificacion === null || order.bonificacion === undefined).toBe(true);
    });

    it('2. PUT con bonificación=36.50 → se persiste', async () => {
        if (!authToken || !orderId) return;
        const res = await request(API_URL)
            .put(`/api/orders/${orderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ estado: 'pendiente', total: 67.78, bonificacion: 36.50,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 1, precioUnitario: 67.78 }] });
        expect([200, 201]).toContain(res.status);
        const order = await getOrder(authToken, orderId);
        expect(parseFloat(order.bonificacion)).toBeCloseTo(36.50, 2);
    });

    it('3. PUT sin bonificación → COALESCE conserva la anterior (36.50)', async () => {
        if (!authToken || !orderId) return;
        const res = await request(API_URL)
            .put(`/api/orders/${orderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ estado: 'pendiente', total: 67.78,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 1, precioUnitario: 67.78 }] });
        expect([200, 201]).toContain(res.status);
        const order = await getOrder(authToken, orderId);
        expect(parseFloat(order.bonificacion)).toBeCloseTo(36.50, 2);
    });
});
