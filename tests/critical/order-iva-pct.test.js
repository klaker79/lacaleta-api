/**
 * ============================================
 * tests/critical/order-iva-pct.test.js
 * ============================================
 *
 * CRITICAL (Migración 015, 2026-06-27): el IVA del albarán se PERSISTE por
 * pedido (pedidos.iva_pct) y viaja crear → editar → recibir, PERO:
 *   - NO entra en `total` (que es la BASE sin IVA → gasto/P&L).
 *   - NO afecta a precio_medio_compra, food cost ni stock.
 *
 * Contrato blindado por este test:
 *   1. POST con iva_pct=21 y total=100 → iva_pct=21 guardado, total sigue 100.
 *   2. PUT con iva_pct=10 → se actualiza a 10, total intacto.
 *   3. PUT sin iva_pct (recepción no lo manda) → COALESCE conserva el anterior.
 *   4. POST sin iva_pct → null (no rompe el flujo histórico sin IVA).
 *
 * @date 2026-06-27
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

describe('Pedidos — IVA del albarán persistente (Migración 015)', () => {
    let authToken;
    let testIngredientId;
    let orderWithIva;
    let orderNoIva;

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
        for (const id of [orderWithIva, orderNoIva]) {
            if (id && authToken) {
                await request(API_URL)
                    .delete(`/api/orders/${id}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            }
        }
    });

    it('1. POST con iva_pct=21 y total=100 → iva_pct=21, total SIGUE 100 (base sin IVA)', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: new Date().toISOString().split('T')[0],
                estado: 'pendiente',
                total: 100,
                iva_pct: 21,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 1, precioUnitario: 100 }]
            });

        expect([200, 201]).toContain(res.status);
        orderWithIva = res.body.id;
        expect(orderWithIva).toBeDefined();

        const order = await getOrder(authToken, orderWithIva);
        expect(order).not.toBeNull();
        expect(parseFloat(order.iva_pct)).toBeCloseTo(21, 2);
        // CLAVE: el IVA NO infla el total. total = base = 100, no 121.
        expect(parseFloat(order.total)).toBeCloseTo(100, 2);
    });

    it('2. PUT con iva_pct=10 → se actualiza; total intacto', async () => {
        if (!authToken || !orderWithIva) return;

        const res = await request(API_URL)
            .put(`/api/orders/${orderWithIva}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'pendiente',
                total: 100,
                iva_pct: 10,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 1, precioUnitario: 100 }]
            });

        expect([200, 201]).toContain(res.status);

        const order = await getOrder(authToken, orderWithIva);
        expect(parseFloat(order.iva_pct)).toBeCloseTo(10, 2);
        expect(parseFloat(order.total)).toBeCloseTo(100, 2);
    });

    it('3. PUT sin iva_pct en body → COALESCE conserva el anterior (10)', async () => {
        if (!authToken || !orderWithIva) return;

        const res = await request(API_URL)
            .put(`/api/orders/${orderWithIva}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'pendiente',
                total: 100,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 1, precioUnitario: 100 }]
            });

        expect([200, 201]).toContain(res.status);

        const order = await getOrder(authToken, orderWithIva);
        expect(parseFloat(order.iva_pct)).toBeCloseTo(10, 2);
    });

    it('4. POST sin iva_pct → null (flujo histórico sin IVA no se rompe)', async () => {
        if (!authToken || !testIngredientId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: new Date().toISOString().split('T')[0],
                estado: 'pendiente',
                total: 50,
                ingredientes: [{ ingredienteId: testIngredientId, cantidad: 5, precioUnitario: 10 }]
            });

        expect([200, 201]).toContain(res.status);
        orderNoIva = res.body.id;

        const order = await getOrder(authToken, orderNoIva);
        expect(order.iva_pct === null || order.iva_pct === undefined).toBe(true);
        expect(parseFloat(order.total)).toBeCloseTo(50, 2);
    });
});
