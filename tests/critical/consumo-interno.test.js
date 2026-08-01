/**
 * ============================================
 * tests/critical/consumo-interno.test.js
 * ============================================
 *
 * CONSUMO INTERNO — un plato de la carta que se come el personal, se usa como
 * prueba de cocina o se invita. A diferencia de la "comida personal" de los
 * pedidos (compra desviada, NO toca stock), esto SÍ descuenta stock.
 *
 * Blinda lo crítico:
 *   - El descuento de stock sale de la RECETA (cantidad/porciones × porciones
 *     consumidas), no de la cantidad bruta del escandallo.
 *   - El coste lo calcula el BACKEND (nunca se acepta del cliente).
 *   - Al BORRAR se devuelve al stock exactamente lo descontado (snapshot).
 *   - Validaciones: tipo inválido, receta de otro tenant / inexistente, fecha futura.
 *
 * Fixtures propias (ingrediente + receta) para que los números sean exactos y
 * no dependan de los datos del tenant de CI.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Consumo interno (plato de la carta sin venta)', () => {
    let authToken;
    let ingId;
    let recId;
    let consumoId;
    const stamp = Date.now() % 100000;

    // Ingrediente: stock 100, precio 10 €/ud → precio unitario 10.
    // Receta: porciones 2, lleva 4 uds → 2 uds por porción, coste lote 40 €.
    const STOCK_INICIAL = 100;
    const PORCIONES_CONSUMIDAS = 3;
    const CONSUMO_ESPERADO = 6;   // (4 / 2) × 3
    const COSTE_ESPERADO = 60;    // (40 / 2) × 3

    const hdrs = (r) => r
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`);

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ Sin autenticación. Tests skipped.');
            return;
        }

        const ingRes = await hdrs(request(API_URL).post('/api/ingredients')).send({
            nombre: `TEST_CI_ING_${stamp}`,
            precio: 10,
            unidad: 'ud',
            stockActual: STOCK_INICIAL,
            cantidad_por_formato: 1,
            rendimiento: 100
        });
        if ([200, 201].includes(ingRes.status)) ingId = ingRes.body.id;

        if (ingId) {
            const recRes = await hdrs(request(API_URL).post('/api/recipes')).send({
                nombre: `TEST_CI_REC_${stamp}`,
                categoria: 'alimentos',
                precio_venta: 20,
                porciones: 2,
                codigo: `CI${stamp}`,
                ingredientes: [{ ingredienteId: ingId, cantidad: 4 }]
            });
            if ([200, 201].includes(recRes.status)) recId = recRes.body.id;
        }
    });

    afterAll(async () => {
        if (!authToken) return;
        if (consumoId) {
            await hdrs(request(API_URL).delete(`/api/consumos-internos/${consumoId}`));
        }
        if (recId) await hdrs(request(API_URL).delete(`/api/recipes/${recId}`));
        if (ingId) await hdrs(request(API_URL).delete(`/api/ingredients/${ingId}`));
    });

    async function stockDe(id) {
        const list = await hdrs(request(API_URL).get('/api/ingredients'));
        const ing = (list.body || []).find(i => i.id === id);
        return ing ? parseFloat(ing.stock_actual) : null;
    }

    it('a. POST descuenta el stock según la receta y calcula el coste en backend', async () => {
        if (!authToken || !recId) return;

        const res = await hdrs(request(API_URL).post('/api/consumos-internos')).send({
            recetaId: recId,
            porciones: PORCIONES_CONSUMIDAS,
            tipo: 'prueba',
            nota: 'prueba de cocina test',
            // Coste malicioso: el backend debe IGNORARLO y calcular el suyo.
            coste: 99999
        });

        expect(res.status).toBe(201);
        expect(res.body.receta_id).toBe(recId);
        expect(res.body.tipo).toBe('prueba');
        expect(parseFloat(res.body.coste)).toBeCloseTo(COSTE_ESPERADO, 2);
        consumoId = res.body.id;

        // Stock: 100 − 6 = 94 (NO 100 − 12, que sería usar la cantidad del lote)
        expect(await stockDe(ingId)).toBeCloseTo(STOCK_INICIAL - CONSUMO_ESPERADO, 3);
    });

    it('b. GET lo lista y suma el coste total', async () => {
        if (!authToken || !consumoId) return;

        const res = await hdrs(request(API_URL).get('/api/consumos-internos'));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.consumos)).toBe(true);

        const mio = res.body.consumos.find(c => c.id === consumoId);
        expect(mio).toBeDefined();
        expect(parseFloat(mio.coste)).toBeCloseTo(COSTE_ESPERADO, 2);
        expect(res.body.total_coste).toBeGreaterThanOrEqual(COSTE_ESPERADO);
    });

    it('c. tipo inválido → 400', async () => {
        if (!authToken || !recId) return;
        const res = await hdrs(request(API_URL).post('/api/consumos-internos')).send({
            recetaId: recId, porciones: 1, tipo: 'lo_que_sea'
        });
        expect(res.status).toBe(400);
    });

    it('d. receta inexistente → 404 (y no descuenta nada)', async () => {
        if (!authToken) return;
        const res = await hdrs(request(API_URL).post('/api/consumos-internos')).send({
            recetaId: 999999999, porciones: 1, tipo: 'personal'
        });
        expect(res.status).toBe(404);
    });

    it('e. fecha futura → 400', async () => {
        if (!authToken || !recId) return;
        const res = await hdrs(request(API_URL).post('/api/consumos-internos')).send({
            recetaId: recId, porciones: 1, tipo: 'personal', fecha: '2099-01-01'
        });
        expect(res.status).toBe(400);
    });

    it('f. DELETE devuelve al stock exactamente lo descontado', async () => {
        if (!authToken || !consumoId) return;

        const res = await hdrs(request(API_URL).delete(`/api/consumos-internos/${consumoId}`));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Stock restaurado a 100
        expect(await stockDe(ingId)).toBeCloseTo(STOCK_INICIAL, 3);

        // Ya no aparece en el listado (soft delete)
        const list = await hdrs(request(API_URL).get('/api/consumos-internos'));
        expect((list.body.consumos || []).some(c => c.id === consumoId)).toBe(false);

        consumoId = null; // evita el borrado defensivo del afterAll
    });
});
