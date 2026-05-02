/**
 * ============================================
 * tests/critical/order-recalcula-precio-ponderado.test.js
 * ============================================
 *
 * REGRESSION TEST — bugs detectados y desplegados 2026-05-02:
 *
 *   1. POST /orders con estado=recibido debe llamar a recalcularPrecioPonderado
 *      para que ingredientes.precio refleje la media ponderada de TODAS las
 *      compras en precios_compra_diarios (no solo la última).
 *
 *   2. DELETE /orders debe recalcular precio TRAS borrar las filas de
 *      precios_compra_diarios asociadas — sin esto el precio queda fantasma
 *      con el valor anterior (bug 2026-05-02 detectado en La Nave 5).
 *
 * El test crea un ingrediente con precio inicial, hace 2 pedidos a precios
 * distintos, verifica la media ponderada, elimina uno, verifica que vuelve
 * a la media SIN el pedido eliminado.
 *
 * @author MindLoopIA
 * @date 2026-05-03
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

describe('Recalculo precio ponderado al recibir/eliminar pedido', () => {
    let authToken;
    let proveedorId;
    let ingredienteId;
    const createdOrderIds = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        const provRes = await request(API_URL)
            .get('/api/proveedores')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        proveedorId = provRes.body?.[0]?.id;

        const fechaSuffix = Date.now();
        const ingRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `TEST_PMC_${fechaSuffix}`,
                precio: 10,
                unidad: 'kg',
                stock_actual: 0,
                stock_minimo: 0,
                cantidad_por_formato: 1,
            });

        ingredienteId = ingRes.body?.id;
    });

    afterAll(async () => {
        if (!authToken) return;
        for (const orderId of createdOrderIds) {
            await request(API_URL)
                .delete(`/api/orders/${orderId}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .catch(() => {});
        }
        if (ingredienteId) {
            await request(API_URL)
                .delete(`/api/ingredients/${ingredienteId}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .catch(() => {});
        }
    });

    it('1. POST /orders recibido → precio del ingrediente = pmc ponderada', async () => {
        if (!authToken || !ingredienteId || !proveedorId) {
            console.log('⚠️ Sin auth/ingrediente/proveedor — skip');
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId,
                fecha: today,
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId, ingrediente_id: ingredienteId,
                    cantidad: 10, cantidadRecibida: 10,
                    precio_unitario: 20, precioUnitario: 20, precioReal: 20,
                }],
                total: 200,
            });

        expect(res.status).toBeLessThan(400);
        if (res.body?.id) createdOrderIds.push(res.body.id);

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        const ing = ingRes.body.find(i => i.id === ingredienteId);
        // Compra única de 10 ud × 20€ → pmc = 20 → precio = 20 × cpf(1) = 20
        expect(parseFloat(ing.precio)).toBeCloseTo(20, 1);
    });

    it('2. Segundo pedido a precio distinto → pmc ponderada', async () => {
        if (!authToken || !ingredienteId || !proveedorId) return;

        const today = new Date().toISOString().split('T')[0];
        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId,
                fecha: today,
                estado: 'recibido',
                ingredientes: [{
                    ingredienteId, ingrediente_id: ingredienteId,
                    cantidad: 5, cantidadRecibida: 5,
                    precio_unitario: 30, precioUnitario: 30, precioReal: 30,
                }],
                total: 150,
            });

        expect(res.status).toBeLessThan(400);
        if (res.body?.id) createdOrderIds.push(res.body.id);

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        const ing = ingRes.body.find(i => i.id === ingredienteId);
        // pmc = (10×20 + 5×30) / 15 = 350/15 = 23.33
        expect(parseFloat(ing.precio)).toBeCloseTo(23.33, 1);
    });

    it('3. DELETE del segundo pedido → precio vuelve a la pmc SIN ese pedido', async () => {
        if (!authToken || !ingredienteId || createdOrderIds.length < 2) return;

        const orderToDelete = createdOrderIds.pop();
        const delRes = await request(API_URL)
            .delete(`/api/orders/${orderToDelete}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        expect(delRes.status).toBeLessThan(400);

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        const ing = ingRes.body.find(i => i.id === ingredienteId);
        // Tras borrar el segundo pedido, solo queda 10 ud × 20€ → pmc = 20
        // Si el bug del 2026-05-02 reaparece, el precio quedará en 23.33 (fantasma).
        expect(parseFloat(ing.precio)).toBeCloseTo(20, 1);
    });
});
