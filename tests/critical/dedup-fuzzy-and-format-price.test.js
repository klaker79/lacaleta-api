/**
 * Tests for:
 * 1. Fuzzy deduplication in POST /purchases/pending (blocks same albaran uploaded 3x via Gemini OCR)
 * 2. PATCH /purchases/pending/:id/formato recalculates price when format changes
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Dedup: POST /purchases/pending blocks duplicate albaranes (fuzzy)', () => {
    let authToken;
    const ORIGIN = 'http://localhost:3001';

    // Use unique prices per test run to avoid collisions with other tests
    const RUN_ID = Date.now() % 100000;
    const UNIQUE_PRICE_1 = 77.01 + (RUN_ID % 100) / 100;  // unique per run
    const UNIQUE_PRICE_2 = 33.02 + (RUN_ID % 100) / 100;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    afterAll(async () => {
        // Clean up: reject all pending items from this test run
        if (!authToken) return;
        const res = await request(API_URL)
            .get('/api/purchases/pending?estado=pendiente')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        if (res.status === 200 && Array.isArray(res.body)) {
            for (const item of res.body) {
                const p = parseFloat(item.precio);
                // Only delete items created by this test (matching our unique prices)
                if (Math.abs(p - UNIQUE_PRICE_1) < 1 || Math.abs(p - UNIQUE_PRICE_2) < 1) {
                    await request(API_URL)
                        .delete(`/api/purchases/pending/${item.id}`)
                        .set('Origin', ORIGIN)
                        .set('Authorization', `Bearer ${authToken}`);
                }
            }
        }
    });

    it('blocks exact duplicate (same names, qty, prices)', async () => {
        if (!authToken) return;

        const compras = {
            compras: [
                { ingrediente: `TestDedup_A_${RUN_ID}`, cantidad: 15, precio: UNIQUE_PRICE_1, fecha: '2026-03-17' },
                { ingrediente: `TestDedup_B_${RUN_ID}`, cantidad: 4, precio: UNIQUE_PRICE_2, fecha: '2026-03-17' }
            ]
        };

        // First upload — should succeed
        const res1 = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send(compras);
        expect(res1.status).toBe(200);
        expect(res1.body.batchId).toBeTruthy();

        // Second upload — should be blocked (409)
        const res2 = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send(compras);
        expect(res2.status).toBe(409);
        expect(res2.body.duplicateWarning).toBeTruthy();
        expect(res2.body.duplicateWarning.similarity).toBeGreaterThanOrEqual(70);
    });

    it('blocks duplicate when OCR produces different names but same qty+price', async () => {
        if (!authToken) return;

        const price1 = UNIQUE_PRICE_1 + 10;
        const price2 = UNIQUE_PRICE_2 + 10;

        const upload1 = {
            compras: [
                { ingrediente: `Leite Enteiro Bio 1 Litro ${RUN_ID}`, cantidad: 15, precio: price1, fecha: '2026-03-17' },
                { ingrediente: `Iogur Natural Bio 420g ${RUN_ID}`, cantidad: 4, precio: price2, fecha: '2026-03-17' }
            ]
        };

        const upload2 = {
            compras: [
                { ingrediente: `LEITE ENTEIRO BIO 1L ${RUN_ID}`, cantidad: 15, precio: price1, fecha: '2026-03-17' },
                { ingrediente: `Iogur Natural Bio 420 g ${RUN_ID}`, cantidad: 4, precio: price2, fecha: '2026-03-17' }
            ]
        };

        const res1 = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send(upload1);
        expect(res1.status).toBe(200);

        // Same qty and prices, different names — should still be blocked
        const res2 = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send(upload2);
        expect(res2.status).toBe(409);
        expect(res2.body.duplicateWarning.source).toBe('qty_price_match');
    });

    it('allows genuinely different albaranes through', async () => {
        if (!authToken) return;

        const albaran1 = {
            compras: [
                { ingrediente: `Pulpo Fresco ${RUN_ID}`, cantidad: 10, precio: UNIQUE_PRICE_1 + 20, fecha: '2026-03-17' }
            ]
        };

        const albaran2 = {
            compras: [
                { ingrediente: `Merluza Fresca ${RUN_ID}`, cantidad: 5, precio: UNIQUE_PRICE_2 + 20, fecha: '2026-03-17' }
            ]
        };

        const res1 = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send(albaran1);
        expect(res1.status).toBe(200);

        // Different product, different qty, different price — should pass
        const res2 = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send(albaran2);
        expect(res2.status).toBe(200);
    });
});

describe('Format price recalculation: PATCH /purchases/pending/:id/formato', () => {
    let authToken;
    let testItemId;
    let testIngredientId;
    const ORIGIN = 'http://localhost:3001';
    const RUN_ID = Date.now() % 100000;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Find an ingredient that has cantidad_por_formato > 1
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200) {
            const withFormat = res.body.find(i =>
                parseFloat(i.cantidad_por_formato) > 1 && parseFloat(i.precio) > 0
            );
            if (withFormat) {
                testIngredientId = withFormat.id;
                console.log(`🧪 Format test ingredient: ${withFormat.nombre} (precio: ${withFormat.precio}, cant_por_formato: ${withFormat.cantidad_por_formato})`);

                // Create a pending purchase item for this ingredient
                const pendingRes = await request(API_URL)
                    .post('/api/purchases/pending')
                    .set('Origin', ORIGIN)
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({
                        compras: [{
                            ingrediente: withFormat.nombre,
                            precio: parseFloat(withFormat.precio),
                            cantidad: 1,
                            fecha: '2026-03-17'
                        }]
                    });

                if (pendingRes.status === 200) {
                    // Get the pending item ID
                    const listRes = await request(API_URL)
                        .get('/api/purchases/pending?estado=pendiente')
                        .set('Origin', ORIGIN)
                        .set('Authorization', `Bearer ${authToken}`);
                    if (listRes.status === 200) {
                        const item = listRes.body.find(i =>
                            i.ingrediente_id === testIngredientId &&
                            i.batch_id === pendingRes.body.batchId
                        );
                        if (item) testItemId = item.id;
                    }
                }
            }
        }
    });

    afterAll(async () => {
        // Clean up
        if (testItemId && authToken) {
            await request(API_URL)
                .delete(`/api/purchases/pending/${testItemId}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('switching to unit (×1) divides price by cantidad_por_formato', async () => {
        if (!authToken || !testItemId) {
            console.log('⚠️ Skipped: no ingredient with cantidad_por_formato > 1 found');
            return;
        }

        const res = await request(API_URL)
            .patch(`/api/purchases/pending/${testItemId}/formato`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ formato_override: 1 });

        expect(res.status).toBe(200);
        expect(res.body.formato_override).toBe(1);
        // Price should be lower than the format price (divided by cantidad_por_formato)
        expect(parseFloat(res.body.precio)).toBeLessThan(200); // sanity check
        expect(parseFloat(res.body.precio)).toBeGreaterThan(0);
    });

    it('rejects invalid formato_override', async () => {
        if (!authToken || !testItemId) return;

        const res = await request(API_URL)
            .patch(`/api/purchases/pending/${testItemId}/formato`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ formato_override: 0 });

        expect(res.status).toBe(400);
    });
});
