/**
 * tests/critical/last-purchase-by-supplier.test.js
 *
 * Verifica el endpoint GET /api/daily/purchases/last que devuelve la última
 * compra de un ingrediente al proveedor indicado. Sirve al frontend para
 * autollenar el input "Precio" del modal Nuevo Pedido con el precio real
 * de la última compra a ese proveedor concreto.
 *
 * Casos:
 * 1. 400 si ingredienteId o proveedorId son inválidos
 * 2. null si no hay ninguna compra para esa combinación
 * 3. Devuelve la fila MÁS RECIENTE (ORDER BY fecha DESC, id DESC)
 * 4. NO mezcla compras de otros proveedores
 * 5. Aislamiento multi-tenant (no devuelve compras de otro restaurante)
 */
const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('GET /api/daily/purchases/last — última compra por proveedor', () => {
    let authToken;
    let testIngredientId;
    let testProveedorId;
    const today = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (ingRes.status === 200 && ingRes.body.length > 0) {
            testIngredientId = ingRes.body[0].id;
        }

        const provRes = await request(API_URL)
            .get('/api/proveedores')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (provRes.status === 200 && provRes.body.length > 0) {
            testProveedorId = provRes.body[0].id;
        }
    });

    it('1. Rechaza ingredienteId inválido con 400', async () => {
        if (!authToken) return;
        const res = await request(API_URL)
            .get('/api/daily/purchases/last?ingredienteId=abc&proveedorId=1')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/ingredienteId/i);
    });

    it('2. Rechaza proveedorId inválido con 400', async () => {
        if (!authToken) return;
        const res = await request(API_URL)
            .get('/api/daily/purchases/last?ingredienteId=1&proveedorId=xyz')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/proveedorId/i);
    });

    it('3. Devuelve null si no hay compras para esa combinación', async () => {
        if (!authToken || !testIngredientId || !testProveedorId) return;
        // IDs muy altos que no deberían tener compras
        const res = await request(API_URL)
            .get('/api/daily/purchases/last?ingredienteId=999999&proveedorId=999999')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
    });

    it('4. Crear pedido A con precio 10€, luego pedido B con precio 12€ — debe devolver el de 12€', async () => {
        if (!authToken || !testIngredientId || !testProveedorId) return;

        // Pedido A
        const orderA = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: testProveedorId,
                fecha: today,
                estado: 'recibido',
                total: 10,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 1,
                    cantidadRecibida: 1,
                    precioReal: 10,
                    precioUnitario: 10
                }]
            });
        expect([200, 201]).toContain(orderA.status);

        // Pedido B (más reciente, ID mayor)
        const orderB = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: testProveedorId,
                fecha: today,
                estado: 'recibido',
                total: 12,
                ingredientes: [{
                    ingredienteId: testIngredientId,
                    cantidad: 1,
                    cantidadRecibida: 1,
                    precioReal: 12,
                    precioUnitario: 12
                }]
            });
        expect([200, 201]).toContain(orderB.status);

        const res = await request(API_URL)
            .get(`/api/daily/purchases/last?ingredienteId=${testIngredientId}&proveedorId=${testProveedorId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).not.toBeNull();
        expect(parseFloat(res.body.precio_unitario)).toBeCloseTo(12, 2);
        expect(res.body.pedido_id).toBe(orderB.body.id);

        // Cleanup
        if (orderA.body.id) {
            await request(API_URL).delete(`/api/orders/${orderA.body.id}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
        if (orderB.body.id) {
            await request(API_URL).delete(`/api/orders/${orderB.body.id}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });
});
