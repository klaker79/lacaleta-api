/**
 * ============================================
 * tests/critical/order-personal-line-excluded.test.js
 * ============================================
 *
 * COMIDA PERSONAL — garantía de aislamiento.
 *
 * Una línea de pedido marcada `personal: true` (comida del equipo) NO debe
 * afectar a ningún número del restaurante: en concreto NO debe escribirse en
 * `precios_compra_diarios` (la tabla que alimenta el food cost / precio medio).
 *
 * Este test crea un pedido recibido con DOS líneas:
 *   - una NORMAL  → debe aparecer en compras diarias (food cost).
 *   - una PERSONAL → NO debe aparecer en compras diarias.
 * Y verifica que el flag `personal` persiste en el pedido.
 *
 * Mismo mecanismo que las líneas de tipo 'ajuste' (envases), que ya se excluían.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('POST /api/orders — línea personal excluida de compras diarias (food cost)', () => {
    let authToken;
    let ingNormal;   // entra en food cost
    let ingPersonal; // NO entra
    let orderId;
    const testDate = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (res.status === 200 && res.body.length >= 2) {
            ingNormal = res.body[0].id;
            ingPersonal = res.body[1].id;
        }
    });

    it('1. Crea pedido recibido con una línea normal y una marcada personal', async () => {
        if (!authToken || !ingNormal || !ingPersonal) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: testDate,
                estado: 'recibido',
                total: 100,
                ingredientes: [
                    { ingredienteId: ingNormal, cantidad: 10, cantidadRecibida: 10, precioReal: 5, precioUnitario: 5 },
                    { ingredienteId: ingPersonal, cantidad: 8, cantidadRecibida: 8, precioReal: 6, precioUnitario: 6, personal: true }
                ]
            });

        expect([200, 201]).toContain(res.status);
        expect(res.body.id).toBeDefined();
        orderId = res.body.id;
    });

    it('2. La línea NORMAL sí está en compras diarias; la PERSONAL NO', async () => {
        if (!authToken || !orderId) return;

        const res = await request(API_URL)
            .get(`/api/daily/purchases?fecha=${testDate}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);

        const idOf = e => (e.ingrediente_id || e.ingredienteId);

        // Normal: debe existir una fila de ESTE pedido para el ingrediente normal.
        const normalDeEstePedido = res.body.find(e =>
            idOf(e) === ingNormal && e.pedido_id === orderId
        );
        expect(normalDeEstePedido).toBeDefined();

        // Personal: NO debe existir NINGUNA fila de este pedido para el ingrediente personal.
        const personalDeEstePedido = res.body.find(e =>
            idOf(e) === ingPersonal && e.pedido_id === orderId
        );
        expect(personalDeEstePedido).toBeUndefined();
    });

    it('3. El flag personal persiste en el pedido guardado', async () => {
        if (!authToken || !orderId) return;

        const res = await request(API_URL)
            .get('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);

        const order = res.body.find(o => o.id === orderId);
        expect(order).toBeDefined();
        const lineas = typeof order.ingredientes === 'string'
            ? JSON.parse(order.ingredientes)
            : order.ingredientes;
        const lineaPersonal = lineas.find(l =>
            (l.ingredienteId || l.ingrediente_id) === ingPersonal
        );
        expect(lineaPersonal).toBeDefined();
        expect(lineaPersonal.personal).toBe(true);
    });

    afterAll(async () => {
        if (authToken && orderId) {
            await request(API_URL)
                .delete(`/api/orders/${orderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });
});

/**
 * REGRESIÓN: dividir una línea (producción + personal) repite el MISMO
 * ingredienteId en el array. La validación cross-tenant cuenta IDs únicos; antes
 * comparaba la longitud cruda contra filas distintas y devolvía 404 "Uno o más
 * ingredientes no encontrados" al guardar un pedido dividido (bug 2026-06-10).
 */
describe('POST/PUT /api/orders — línea dividida (ingredienteId duplicado) no rompe la validación', () => {
    let authToken;
    let ingId;
    let orderId;
    const testDate = new Date().toISOString().split('T')[0];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (res.status === 200 && res.body.length >= 1) ingId = res.body[0].id;
    });

    it('1. POST con el mismo ingrediente en dos líneas (producción + personal) → no 404', async () => {
        if (!authToken || !ingId) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedorId: null,
                fecha: testDate,
                estado: 'pendiente',
                total: 30,
                ingredientes: [
                    { ingredienteId: ingId, cantidad: 2, precio_unitario: 7.5, personal: false },
                    { ingredienteId: ingId, cantidad: 2, precio_unitario: 7.5, personal: true }
                ]
            });

        expect([200, 201]).toContain(res.status);
        expect(res.body.id).toBeDefined();
        orderId = res.body.id;
    });

    it('2. PUT del mismo pedido dividido (estado recibido) → no 404 y persiste el split', async () => {
        if (!authToken || !orderId) return;

        const res = await request(API_URL)
            .put(`/api/orders/${orderId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                estado: 'recibido',
                total: 30,
                ingredientes: [
                    { ingredienteId: ingId, cantidad: 2, cantidadRecibida: 2, precio_unitario: 7.5, precioUnitario: 7.5, personal: false },
                    { ingredienteId: ingId, cantidad: 2, cantidadRecibida: 2, precio_unitario: 7.5, precioUnitario: 7.5, personal: true }
                ]
            });

        expect(res.status).toBe(200);
        const lineas = typeof res.body.ingredientes === 'string'
            ? JSON.parse(res.body.ingredientes)
            : res.body.ingredientes;
        expect(lineas.filter(l => (l.ingredienteId || l.ingrediente_id) === ingId).length).toBe(2);
        expect(lineas.some(l => l.personal === true)).toBe(true);
    });

    afterAll(async () => {
        if (authToken && orderId) {
            await request(API_URL)
                .delete(`/api/orders/${orderId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });
});
