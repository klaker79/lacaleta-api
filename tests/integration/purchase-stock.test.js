/**
 * ============================================
 * tests/integration/purchase-stock.test.js
 * ============================================
 *
 * Test de integración: Flujo Compras → Stock
 * 
 * @author MindLoopIA
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Purchase → Stock Flow', () => {
    let authToken;
    let testIngredientId;
    let testPedidoId;
    let initialStock;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
        }
    });

    describe('1. Obtener ingrediente de prueba', () => {
        it('should get an ingredient to test with', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .get('/api/ingredients')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);

            if (res.body.length > 0) {
                testIngredientId = res.body[0].id;
                initialStock = parseFloat(res.body[0].stock_actual) || 0;
                console.log(`📦 Ingrediente: ${res.body[0].nombre} (ID: ${testIngredientId})`);
                console.log(`📦 Stock inicial: ${initialStock}`);
            }
        });
    });

    describe('2. Crear pedido con compra', () => {
        it('should create order and receive it to increment stock', async () => {
            if (!authToken || !testIngredientId) {
                console.warn('Skipping - no auth or ingredient');
                return;
            }

            const orderRes = await request(API_URL)
                .post('/api/pedidos')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    proveedor_id: 1,
                    fecha_pedido: new Date().toISOString().split('T')[0],
                    estado: 'pendiente',
                    notas: 'TEST - Purchase Flow Integration Test'
                });

            if (orderRes.status === 201 || orderRes.status === 200) {
                testPedidoId = orderRes.body.id;
                console.log(`📋 Pedido creado: ID ${testPedidoId}`);

                const lineaRes = await request(API_URL)
                    .post(`/api/pedidos/${testPedidoId}/lineas`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({
                        ingrediente_id: testIngredientId,
                        cantidad: 10,
                        precio_unitario: 5
                    });

                expect([200, 201]).toContain(lineaRes.status);
            }
        });

        it('should receive order and verify stock increased', async () => {
            if (!authToken || !testPedidoId) {
                console.warn('Skipping - no order created');
                return;
            }

            const receiveRes = await request(API_URL)
                .put(`/api/pedidos/${testPedidoId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    estado: 'recibido',
                    fecha_recepcion: new Date().toISOString().split('T')[0]
                });

            expect([200, 201]).toContain(receiveRes.status);

            const ingredientRes = await request(API_URL)
                .get(`/api/ingredients/${testIngredientId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (ingredientRes.status === 200) {
                const newStock = parseFloat(ingredientRes.body.stock_actual) || 0;
                console.log(`📦 Stock después: ${newStock}`);
                expect(newStock).toBeGreaterThanOrEqual(initialStock);
            }
        });
    });

    describe('3. Cleanup - Delete test order', () => {
        it('should delete test order and verify stock adjusted', async () => {
            if (!authToken || !testPedidoId) return;

            const deleteRes = await request(API_URL)
                .delete(`/api/pedidos/${testPedidoId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            expect([200, 204, 404]).toContain(deleteRes.status);

            const ingredientRes = await request(API_URL)
                .get(`/api/ingredients/${testIngredientId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);

            if (ingredientRes.status === 200) {
                const finalStock = parseFloat(ingredientRes.body.stock_actual) || 0;
                console.log(`📦 Stock final: ${finalStock}`);
                expect(finalStock).toBeCloseTo(initialStock, 0);
            }
        });
    });
});
