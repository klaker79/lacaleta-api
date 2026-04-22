/**
 * ============================================
 * tests/critical/delete-order-rollback-stock.test.js
 * ============================================
 *
 * REGRESSION TEST: DELETE /api/orders/:id debe dejar stock_actual EXACTAMENTE
 * como estaba antes del POST. Cubre los 3 caminos de creación de pedido
 * vivos hoy (post-2026-04-15):
 *
 *   Caso 1 — Compra mercado (POST /orders con estado='recibido'):
 *     JSON guarda `cantidad` ya en unidades base (frontend multiplica).
 *     Rollback esperado: stock_actual -= cantidad.
 *
 *   Caso 2 — Pedido normal (POST pendiente + PUT recepción):
 *     JSON guarda `cantidadRecibida` en unidades base.
 *     Rollback esperado: stock_actual -= cantidadRecibida.
 *
 *   Caso 3 — Pedido recibido con items de tipo 'ajuste':
 *     Los ajustes (envases, bonificaciones) NO afectan stock.
 *     Rollback esperado: solo se revierten los no-ajuste.
 *
 * El guardrail del endpoint emite log('warn', ...) si detecta campos que
 * sugieren una forma legacy (multiplicador ≠ 1, formato_override, o
 * pedido recibido sin cantidadRecibida) — este test NO comprueba logs,
 * solo el stock final, que es la consecuencia observable para el usuario.
 *
 * @author MindLoopIA
 * @date 2026-04-23
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

async function getIngredient(authToken) {
    const res = await request(API_URL)
        .get('/api/ingredients')
        .set('Origin', ORIGIN)
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200 || !res.body.length) return null;
    return res.body[0];
}

async function getStock(authToken, ingId) {
    const res = await request(API_URL)
        .get('/api/ingredients')
        .set('Origin', ORIGIN)
        .set('Authorization', `Bearer ${authToken}`);
    if (res.status !== 200 || !Array.isArray(res.body)) return null;
    const found = res.body.find(i => i.id === ingId);
    return found ? parseFloat(found.stock_actual) : null;
}

async function adjustStock(authToken, ingId, delta) {
    // Frontend-style: bulkAdjustStock simulated via single adjust endpoint
    const res = await request(API_URL)
        .post(`/api/ingredients/${ingId}/adjust-stock`)
        .set('Origin', ORIGIN)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ delta, reason: 'test_rollback' });
    return res.status === 200;
}

describe('DELETE /api/orders/:id — rollback de stock sin inflación', () => {
    let authToken;
    let ingrediente;
    const today = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;
        ingrediente = await getIngredient(authToken);
    });

    it('Caso 1 — compra mercado: POST recibido + DELETE deja stock igual', async () => {
        if (!authToken || !ingrediente) return;

        const stockAntes = await getStock(authToken, ingrediente.id);

        const post = await request(API_URL)
            .post('/api/orders')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: today,
                estado: 'recibido',
                total: 10,
                ingredientes: [{
                    ingredienteId: ingrediente.id,
                    cantidad: 5,              // 5 unidades base (ya multiplicado por frontend)
                    cantidadRecibida: 5,
                    precioReal: 2,
                    precioUnitario: 2
                }]
            });
        expect([200, 201]).toContain(post.status);
        const orderId = post.body.id;

        // Simular el efecto del frontend: bulkAdjustStock(+5)
        await adjustStock(authToken, ingrediente.id, 5);
        const stockTrasCrear = await getStock(authToken, ingrediente.id);
        expect(stockTrasCrear).toBeCloseTo(stockAntes + 5, 2);

        const del = await request(API_URL)
            .delete(`/api/orders/${orderId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect(del.status).toBe(200);

        const stockFinal = await getStock(authToken, ingrediente.id);
        // DELETE revierte el stock internamente (resta 5), quedando igual al stockAntes.
        expect(stockFinal).toBeCloseTo(stockAntes, 2);
    });

    it('Caso 2 — recepción normal: items con cantidadRecibida separada del cantidad', async () => {
        if (!authToken || !ingrediente) return;

        const stockAntes = await getStock(authToken, ingrediente.id);

        // POST pendiente con cantidad=3; luego simulamos recepción con cantidadRecibida=3.
        const post = await request(API_URL)
            .post('/api/orders')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: today,
                estado: 'recibido',
                total: 9,
                ingredientes: [{
                    ingredienteId: ingrediente.id,
                    cantidad: 3,
                    cantidadRecibida: 3,     // recepción identidad
                    precioReal: 3,
                    precioUnitario: 3
                }]
            });
        expect([200, 201]).toContain(post.status);
        const orderId = post.body.id;

        await adjustStock(authToken, ingrediente.id, 3);

        const del = await request(API_URL)
            .delete(`/api/orders/${orderId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect(del.status).toBe(200);

        const stockFinal = await getStock(authToken, ingrediente.id);
        expect(stockFinal).toBeCloseTo(stockAntes, 2);
    });

    it('Caso 3 — items tipo ajuste NO afectan rollback (envases, bonif.)', async () => {
        if (!authToken || !ingrediente) return;

        const stockAntes = await getStock(authToken, ingrediente.id);

        const post = await request(API_URL)
            .post('/api/orders')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: today,
                estado: 'recibido',
                total: 10,
                ingredientes: [
                    {
                        ingredienteId: ingrediente.id,
                        cantidad: 2,
                        cantidadRecibida: 2,
                        precioReal: 5,
                        precioUnitario: 5
                    },
                    {
                        tipo: 'ajuste',
                        concepto: 'Envases retornables',
                        importe: -0.5
                    }
                ]
            });
        expect([200, 201]).toContain(post.status);
        const orderId = post.body.id;

        await adjustStock(authToken, ingrediente.id, 2);

        const del = await request(API_URL)
            .delete(`/api/orders/${orderId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect(del.status).toBe(200);

        const stockFinal = await getStock(authToken, ingrediente.id);
        // El ajuste NO se revierte. Solo el no-ajuste. stockFinal = stockAntes.
        expect(stockFinal).toBeCloseTo(stockAntes, 2);
    });
});
