/**
 * ============================================
 * tests/critical/cross-tenant-validation.test.js
 * ============================================
 *
 * SECURITY: verifica que los endpoints que aceptan IDs de recursos
 * (receta, ingrediente, proveedor) en el body rechazan IDs que no
 * pertenezcan al tenant del token. Es el mismo código-path que bloquea
 * un cross-tenant attack (tenant A con id de recurso del tenant B).
 *
 * No podemos probar el cross-tenant literal con un solo token en el
 * entorno de test, pero usar un id muy alto que no existe cubre el
 * mismo path: si el endpoint no valida, insertaría la asociación/pedido
 * a ciegas en vez de responder 404.
 *
 * Endpoints blindados en 2026-04-24:
 *   - POST /api/orders (proveedorId + ingredientes[].ingredienteId)
 *   - PUT /api/ingredients/:id/suppliers/:supplierId
 *   - DELETE /api/ingredients/:id/suppliers/:supplierId
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';
const IMPOSSIBLY_HIGH_ID = 999999999;

describe('Cross-tenant validation — resources from other tenants should be rejected', () => {
    let authToken;
    let myIngredient;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        if (ingRes.status === 200 && Array.isArray(ingRes.body) && ingRes.body.length > 0) {
            myIngredient = ingRes.body[0];
        }
    });

    describe('POST /api/orders', () => {
        it('rechaza proveedorId que no pertenece al tenant (404)', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/orders')
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    proveedorId: IMPOSSIBLY_HIGH_ID,
                    fecha: new Date().toISOString().split('T')[0],
                    estado: 'pendiente',
                    total: 10,
                    ingredientes: [],
                });

            expect(res.status).toBe(404);
            expect(res.body.error).toMatch(/proveedor/i);
        });

        it('rechaza ingredienteId que no pertenece al tenant (404)', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/orders')
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    proveedorId: null,
                    fecha: new Date().toISOString().split('T')[0],
                    estado: 'recibido',
                    total: 10,
                    ingredientes: [{
                        ingredienteId: IMPOSSIBLY_HIGH_ID,
                        cantidad: 1,
                        cantidadRecibida: 1,
                        precioReal: 10,
                        precioUnitario: 10,
                    }],
                });

            expect(res.status).toBe(404);
            expect(res.body.error).toMatch(/ingrediente/i);
        });

        it('acepta proveedorId null (compra mercado sin proveedor)', async () => {
            if (!authToken || !myIngredient) return;

            const res = await request(API_URL)
                .post('/api/orders')
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    proveedorId: null,
                    fecha: new Date().toISOString().split('T')[0],
                    estado: 'recibido',
                    total: 5,
                    ingredientes: [{
                        ingredienteId: myIngredient.id,
                        cantidad: 1,
                        cantidadRecibida: 1,
                        precioReal: 5,
                        precioUnitario: 5,
                    }],
                });

            expect([200, 201]).toContain(res.status);

            // Cleanup — borrar el pedido recién creado
            if (res.body?.id) {
                await request(API_URL)
                    .delete(`/api/orders/${res.body.id}`)
                    .set('Origin', ORIGIN)
                    .set('Authorization', `Bearer ${authToken}`);
            }
        });
    });

    describe('PUT /api/ingredients/:id/suppliers/:supplierId', () => {
        it('rechaza supplierId que no pertenece al tenant (404)', async () => {
            if (!authToken || !myIngredient) return;

            const res = await request(API_URL)
                .put(`/api/ingredients/${myIngredient.id}/suppliers/${IMPOSSIBLY_HIGH_ID}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ precio: 10, es_proveedor_principal: false });

            expect(res.status).toBe(404);
        });
    });

    describe('DELETE /api/ingredients/:id/suppliers/:supplierId', () => {
        it('rechaza supplierId que no pertenece al tenant (404)', async () => {
            if (!authToken || !myIngredient) return;

            const res = await request(API_URL)
                .delete(`/api/ingredients/${myIngredient.id}/suppliers/${IMPOSSIBLY_HIGH_ID}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);

            expect(res.status).toBe(404);
        });
    });
});
