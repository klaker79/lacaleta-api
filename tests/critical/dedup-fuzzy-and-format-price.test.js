/**
 * Tests for:
 * 1. Fuzzy deduplication in POST /purchases/pending (blocks same albaran uploaded 3x via Gemini OCR)
 * 2. PATCH /purchases/pending/:id/formato recalculates price when format changes
 */

const { pool, server, getAuthHeaders } = require('../setup');

describe('Dedup: POST /purchases/pending blocks duplicate albaranes (fuzzy)', () => {
    let authHeaders;

    beforeAll(async () => {
        authHeaders = await getAuthHeaders();
    });

    afterEach(async () => {
        // Clean up test data
        await pool.query("DELETE FROM compras_pendientes WHERE restaurante_id = (SELECT restaurante_id FROM usuarios WHERE email = 'test@test.com' LIMIT 1)");
    });

    test('blocks exact duplicate (same names, qty, prices)', async () => {
        const compras = {
            compras: [
                { ingrediente: 'Leite Enteiro Bio 1 Litro', cantidad: 15, precio: 1.65, fecha: '2026-03-17' },
                { ingrediente: 'Iogur Natural Bio 420g', cantidad: 4, precio: 1.95, fecha: '2026-03-17' }
            ]
        };

        // First upload — should succeed
        const res1 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(compras);
        expect(res1.status).toBe(200);
        expect(res1.body.batchId).toBeTruthy();

        // Second upload — should be blocked
        const res2 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(compras);
        expect(res2.status).toBe(409);
        expect(res2.body.duplicateWarning).toBeTruthy();
        expect(res2.body.duplicateWarning.similarity).toBeGreaterThanOrEqual(70);
    });

    test('blocks duplicate when Gemini OCR produces slightly different names but same qty+price', async () => {
        // Simulates Gemini producing different text for same photo
        const upload1 = {
            compras: [
                { ingrediente: 'Leite Enteiro Bio 1 Litro', cantidad: 15, precio: 1.65, fecha: '2026-03-17' },
                { ingrediente: 'Iogur Natural Bio 420g', cantidad: 4, precio: 1.95, fecha: '2026-03-17' },
                { ingrediente: 'Fontelas Do S. Simon', cantidad: 1, precio: 15.38, fecha: '2026-03-17' }
            ]
        };

        const upload2 = {
            compras: [
                { ingrediente: 'LEITE ENTEIRO BIO 1L', cantidad: 15, precio: 1.65, fecha: '2026-03-17' },        // different name
                { ingrediente: 'Iogur Natural Bio 420 g', cantidad: 4.0, precio: 1.95, fecha: '2026-03-17' },     // extra space
                { ingrediente: 'Fontelas Do San Simón', cantidad: 1, precio: 15.38, fecha: '2026-03-17' }          // different abbreviation
            ]
        };

        const res1 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(upload1);
        expect(res1.status).toBe(200);

        // Same quantities and prices, different names — should still be blocked
        const res2 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(upload2);
        expect(res2.status).toBe(409);
        expect(res2.body.duplicateWarning.source).toBe('qty_price_match');
    });

    test('blocks duplicate even with ±10% price variation from OCR', async () => {
        const upload1 = {
            compras: [
                { ingrediente: 'Vino Tinto Rioja', cantidad: 6, precio: 12.50, fecha: '2026-03-17' },
                { ingrediente: 'Aceite Oliva 5L', cantidad: 2, precio: 18.90, fecha: '2026-03-17' }
            ]
        };

        const upload2 = {
            compras: [
                { ingrediente: 'Vino Tinto Rioja Reserva', cantidad: 6, precio: 12.80, fecha: '2026-03-17' },  // price +2.4%
                { ingrediente: 'Aceite de Oliva 5 Litros', cantidad: 2, precio: 18.50, fecha: '2026-03-17' }   // price -2.1%
            ]
        };

        const res1 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(upload1);
        expect(res1.status).toBe(200);

        const res2 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(upload2);
        expect(res2.status).toBe(409);
    });

    test('allows genuinely different albaranes through', async () => {
        const albaran1 = {
            compras: [
                { ingrediente: 'Pulpo Fresco', cantidad: 10, precio: 26.00, fecha: '2026-03-17' }
            ]
        };

        const albaran2 = {
            compras: [
                { ingrediente: 'Merluza Fresca', cantidad: 5, precio: 14.50, fecha: '2026-03-17' }
            ]
        };

        const res1 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(albaran1);
        expect(res1.status).toBe(200);

        // Different product, different qty, different price — should pass
        const res2 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(albaran2);
        expect(res2.status).toBe(200);
    });

    test('allows albaran with different item count (pre-filter)', async () => {
        const albaran1 = {
            compras: [
                { ingrediente: 'Producto A', cantidad: 10, precio: 5.00, fecha: '2026-03-17' },
                { ingrediente: 'Producto B', cantidad: 20, precio: 3.00, fecha: '2026-03-17' },
                { ingrediente: 'Producto C', cantidad: 15, precio: 8.00, fecha: '2026-03-17' },
                { ingrediente: 'Producto D', cantidad: 5, precio: 12.00, fecha: '2026-03-17' }
            ]
        };

        const albaran2 = {
            compras: [
                { ingrediente: 'Producto A', cantidad: 10, precio: 5.00, fecha: '2026-03-18' }
            ]
        };

        const res1 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(albaran1);
        expect(res1.status).toBe(200);

        // Only 1 item vs 4 — should pass (diff > 1)
        const res2 = await server.post('/api/purchases/pending')
            .set(authHeaders)
            .send(albaran2);
        expect(res2.status).toBe(200);
    });
});

describe('Format price recalculation: PATCH /purchases/pending/:id/formato', () => {
    let authHeaders;
    let testItemId;

    beforeAll(async () => {
        authHeaders = await getAuthHeaders();
    });

    beforeEach(async () => {
        // Create a test ingredient with format: CAJA of 12 bottles at 109.20€
        const restId = (await pool.query("SELECT restaurante_id FROM usuarios WHERE email = 'test@test.com' LIMIT 1")).rows[0]?.restaurante_id;
        if (!restId) return;

        // Check if test ingredient exists, create if not
        let ingResult = await pool.query(
            "SELECT id FROM ingredientes WHERE nombre = 'TEST_VINO_FORMATO' AND restaurante_id = $1 AND deleted_at IS NULL",
            [restId]
        );
        let ingredienteId;
        if (ingResult.rows.length === 0) {
            ingResult = await pool.query(
                "INSERT INTO ingredientes (nombre, precio, unidad, familia, stock_actual, cantidad_por_formato, formato_compra, restaurante_id) VALUES ('TEST_VINO_FORMATO', 109.20, 'Botella', 'Bebida', 0, 12, 'CAJA', $1) RETURNING id",
                [restId]
            );
            ingredienteId = ingResult.rows[0].id;
        } else {
            ingredienteId = ingResult.rows[0].id;
        }

        // Create a pending purchase item linked to this ingredient
        const batchId = require('crypto').randomUUID();
        const itemResult = await pool.query(
            "INSERT INTO compras_pendientes (batch_id, ingrediente_nombre, ingrediente_id, precio, cantidad, fecha, restaurante_id) VALUES ($1, 'EIDOS DA SALGOSA ROSAL 2023', $2, 109.20, 1, '2026-03-17', $3) RETURNING id",
            [batchId, ingredienteId, restId]
        );
        testItemId = itemResult.rows[0].id;
    });

    afterEach(async () => {
        const restId = (await pool.query("SELECT restaurante_id FROM usuarios WHERE email = 'test@test.com' LIMIT 1")).rows[0]?.restaurante_id;
        if (restId) {
            await pool.query("DELETE FROM compras_pendientes WHERE restaurante_id = $1", [restId]);
            await pool.query("DELETE FROM ingredientes WHERE nombre = 'TEST_VINO_FORMATO' AND restaurante_id = $1", [restId]);
        }
    });

    test('switching to botella (×1) divides price by cantidad_por_formato', async () => {
        const res = await server.patch(`/api/purchases/pending/${testItemId}/formato`)
            .set(authHeaders)
            .send({ formato_override: 1 });

        expect(res.status).toBe(200);
        expect(res.body.formato_override).toBe(1);
        // 109.20 / 12 = 9.10
        expect(parseFloat(res.body.precio)).toBeCloseTo(9.10, 2);
    });

    test('switching to caja (×12) uses full format price', async () => {
        // First set to botella
        await server.patch(`/api/purchases/pending/${testItemId}/formato`)
            .set(authHeaders)
            .send({ formato_override: 1 });

        // Then switch back to caja
        const res = await server.patch(`/api/purchases/pending/${testItemId}/formato`)
            .set(authHeaders)
            .send({ formato_override: 12 });

        expect(res.status).toBe(200);
        expect(res.body.formato_override).toBe(12);
        expect(parseFloat(res.body.precio)).toBeCloseTo(109.20, 2);
    });

    test('rejects invalid formato_override', async () => {
        const res = await server.patch(`/api/purchases/pending/${testItemId}/formato`)
            .set(authHeaders)
            .send({ formato_override: 0 });

        expect(res.status).toBe(400);
    });
});
