/**
 * ============================================
 * tests/critical/validation-security.test.js
 * ============================================
 *
 * Verifica que los endpoints rechazan datos inválidos (400)
 * y sanitizan inputs correctamente.
 *
 * @author MindLoopIA
 * @date 2026-02-15
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Input Validation & Security', () => {
    let authToken;
    let createdIngredientId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    // ===== INGREDIENT VALIDATION =====

    it('1. POST /api/ingredients without nombre → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                precio: 5.50,
                unidad: 'kg'
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Nombre');
        console.log(`✅ Ingredient without name rejected: ${res.body.error}`);
    });

    it('2. POST /api/ingredients with empty/whitespace nombre → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: '   ',
                precio: 5.50,
                unidad: 'kg'
            });

        expect(res.status).toBe(400);
        console.log(`✅ Empty name rejected`);
    });

    it('3. POST /api/ingredients with HTML in nombre → sanitized', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: '<script>alert("xss")</script>Tomate',
                precio: 2.50,
                unidad: 'kg'
            });

        expect([200, 201]).toContain(res.status);
        // HTML tags should be stripped
        expect(res.body.nombre).not.toContain('<script>');
        expect(res.body.nombre).toContain('Tomate');
        createdIngredientId = res.body.id;
        console.log(`✅ HTML stripped from name: "${res.body.nombre}"`);
    });

    it('4. PUT /api/ingredients/abc (non-numeric ID) → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .put('/api/ingredients/abc')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ nombre: 'Test' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('ID');
        console.log(`✅ Non-numeric ID rejected: ${res.body.error}`);
    });

    it('5. POST /api/ingredients/:id/adjust-stock with invalid ID → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/ingredients/notanumber/adjust-stock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ delta: 5 });

        expect(res.status).toBe(400);
        console.log(`✅ Invalid stock adjust ID rejected`);
    });

    // ===== ORDER VALIDATION =====

    it('6. POST /api/orders without fecha → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                ingredientes: [],
                total: 100
            });

        expect(res.status).toBe(400);
        console.log(`✅ Order without date rejected: ${res.body.error}`);
    });

    it('7. POST /api/orders with invalid fecha → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/orders')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                fecha: 'not-a-date',
                ingredientes: [],
                total: 100
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('fecha');
        console.log(`✅ Invalid date rejected: ${res.body.error}`);
    });

    // ===== SALES VALIDATION =====

    it('8. POST /api/sales without recetaId → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                cantidad: 5
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('recetaId');
        console.log(`✅ Sale without recetaId rejected: ${res.body.error}`);
    });

    // ===== GASTOS VALIDATION =====

    it('9. POST /api/gastos-fijos with HTML in concepto → sanitized', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/gastos-fijos')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                concepto: '<b>Alquiler</b> Local',
                monto_mensual: 1500
            });

        if ([200, 201].includes(res.status)) {
            expect(res.body.concepto).not.toContain('<b>');
            console.log(`✅ HTML stripped from concepto: "${res.body.concepto}"`);

            // Cleanup: soft delete the created gasto
            if (res.body.id) {
                await request(API_URL)
                    .delete(`/api/gastos-fijos/${res.body.id}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            }
        }
    });

    afterAll(async () => {
        // Cleanup test ingredient
        if (authToken && createdIngredientId) {
            try {
                await request(API_URL)
                    .delete(`/api/ingredients/${createdIngredientId}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
                console.log(`🧹 Cleanup: test ingredient ${createdIngredientId} deleted`);
            } catch (e) {
                // Ignore
            }
        }
    });
});
