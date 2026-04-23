/**
 * tests/critical/sales-variante-obligatoria.test.js
 *
 * Verifica el fix de 2026-04-23: si la receta tiene variantes registradas,
 * POST /api/sales DEBE rechazar con 400 cuando no llega varianteId (ni un
 * precioVariante que matchee alguna variante).
 *
 * Historia: 274 ventas de vinos en La Nave 5 en 90 dias se guardaron con
 * factor_variante=1 (botella entera) porque el dropdown del frontend
 * dejaba "Sin variante" como opcion por defecto. El backend caia en un
 * fallback a factor=1 silencioso. Ahora cerramos el agujero.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

describe('POST /api/sales — variante obligatoria cuando la receta la tiene', () => {
    let authToken;
    let recetaConVariantesId;
    let variantePrimeraId;
    let variantePrimeraPrecio;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Busca una receta que tenga variantes configuradas
        const recipesRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        if (recipesRes.status !== 200 || !Array.isArray(recipesRes.body)) return;

        for (const r of recipesRes.body) {
            const variantesRes = await request(API_URL)
                .get(`/api/recipes/${r.id}/variants`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
            if (variantesRes.status === 200 && Array.isArray(variantesRes.body) && variantesRes.body.length > 0) {
                recetaConVariantesId = r.id;
                variantePrimeraId = variantesRes.body[0].id;
                variantePrimeraPrecio = parseFloat(variantesRes.body[0].precio_venta);
                break;
            }
        }
    });

    it('rechaza 400 si receta tiene variantes y no llega varianteId ni precioVariante', async () => {
        if (!authToken || !recetaConVariantesId) return;

        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ recetaId: recetaConVariantesId, cantidad: 1 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/variante/i);
        expect(Array.isArray(res.body.variantes)).toBe(true);
    });

    it('rechaza 400 si precioVariante no matchea ninguna variante', async () => {
        if (!authToken || !recetaConVariantesId) return;

        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                recetaId: recetaConVariantesId,
                cantidad: 1,
                precioVariante: 99999.99, // precio imposible, no matchea
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/variante/i);
    });

    it('rechaza 404 si varianteId no existe o no pertenece a la receta', async () => {
        if (!authToken || !recetaConVariantesId) return;

        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                recetaId: recetaConVariantesId,
                cantidad: 1,
                varianteId: 999999999,
            });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/variante/i);
    });

    it('acepta 201 con varianteId valido', async () => {
        if (!authToken || !recetaConVariantesId || !variantePrimeraId) return;

        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                recetaId: recetaConVariantesId,
                cantidad: 1,
                varianteId: variantePrimeraId,
            });

        expect([200, 201]).toContain(res.status);
        expect(res.body.variante_id).toBe(variantePrimeraId);

        // Cleanup — borra la venta creada
        if (res.body?.id) {
            await request(API_URL)
                .delete(`/api/sales/${res.body.id}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('acepta 201 con precioVariante que matchea una variante (factor inferido)', async () => {
        if (!authToken || !recetaConVariantesId || !Number.isFinite(variantePrimeraPrecio)) return;

        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                recetaId: recetaConVariantesId,
                cantidad: 1,
                precioVariante: variantePrimeraPrecio,
            });

        expect([200, 201]).toContain(res.status);

        if (res.body?.id) {
            await request(API_URL)
                .delete(`/api/sales/${res.body.id}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
        }
    });
});
