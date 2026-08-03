/**
 * ═══════════════════════════════════════════════════════════════
 * 🛡️ GET /sales — filtro por RANGO de fechas (desde/hasta)
 * ═══════════════════════════════════════════════════════════════
 * Incidente (2026-08-03): la pestaña **Balance** pedía
 * `getSales(inicioMes)` creyendo que `fecha` significaba "desde".
 * Pero el backend hacía `AND DATE(v.fecha) = $n` — IGUALDAD EXACTA de día.
 *
 * Resultado: Balance recibía SOLO las ventas del día 1 del mes y las pintaba
 * como el mes entero. Con datos reales de La Nave 5, julio de 2026 salía como
 * **3.884,70 €** en vez de **134.604,30 €** — un 2,9% de la realidad.
 * El filtro cliente (`>= inicioMes`) no lo arreglaba: ya solo le llegaba el día 1.
 *
 * FIX: `desde`/`hasta` como rango [desde, hasta), sin tocar `fecha` (que sigue
 * siendo un día exacto, para no romper a quien ya lo usa).
 *
 * Este test verifica las TRES cosas:
 *   1. `fecha` sigue devolviendo un solo día (no hay regresión)
 *   2. `desde` devuelve TODO lo posterior, no solo ese día
 *   3. el rango excluye lo anterior a `desde`
 *
 * Se crean ventas en fechas futuras (2098) para no tocar datos reales.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

const sufijo = Date.now();
const DIA_1 = '2098-03-01';
const DIA_2 = '2098-03-15';
const MES_SIGUIENTE = '2098-04-01';

describe('🛡️ GET /sales — desde/hasta filtran por rango, no por un solo día', () => {
    let authToken;
    let recetaId;
    let ingredienteId;
    let setupError = null;
    const ventasCreadas = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) { setupError = 'sin token de auth'; return; }

        // El tenant de CI nace vacío: el test se crea sus propios datos y FALLA
        // si no puede, en vez de saltarse en silencio y quedar verde sin probar nada.
        const ingRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`)
            .send({ nombre: `_TEST_RANGO_ING_${sufijo}`, unidad: 'kg', precio: 3, stock_actual: 500, stock_minimo: 0, categoria: 'test' });
        if (![200, 201].includes(ingRes.status) || !ingRes.body?.id) {
            setupError = `no se pudo crear el ingrediente (status ${ingRes.status})`; return;
        }
        ingredienteId = ingRes.body.id;

        const recRes = await request(API_URL)
            .post('/api/recipes')
            .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`)
            .send({ nombre: `_TEST_RANGO_REC_${sufijo}`, categoria: 'alimentos', precio_venta: 10, porciones: 1, ingredientes: [{ ingredienteId, cantidad: 0.1 }] });
        if (recRes.status !== 201 || !recRes.body?.id) {
            setupError = `no se pudo crear la receta (status ${recRes.status})`; return;
        }
        recetaId = recRes.body.id;

        for (const fecha of [DIA_1, DIA_2]) {
            const r = await request(API_URL)
                .post('/api/sales')
                .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`)
                .send({ receta_id: recetaId, cantidad: 1, fecha });
            if (r.status !== 201) { setupError = `no se pudo crear la venta de ${fecha}`; return; }
            ventasCreadas.push(r.body.id);
        }
    });

    afterAll(async () => {
        if (!authToken) return;
        for (const id of ventasCreadas) {
            await request(API_URL).delete(`/api/sales/${id}`)
                .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`).catch(() => { });
        }
        if (recetaId) await request(API_URL).delete(`/api/recipes/${recetaId}`)
            .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`).catch(() => { });
        if (ingredienteId) await request(API_URL).delete(`/api/ingredients/${ingredienteId}`)
            .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`).catch(() => { });
    });

    const pedir = async (qs) => {
        const res = await request(API_URL)
            .get(`/api/sales${qs}`)
            .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);
        return (res.body || []).filter(v => v.receta_id === recetaId);
    };

    it('0. El setup montó sus propios datos', () => {
        expect(setupError).toBeNull();
        expect(recetaId).toBeDefined();
        expect(ventasCreadas).toHaveLength(2);
    });

    it('1. `fecha` sigue devolviendo UN SOLO día (sin regresión)', async () => {
        expect(setupError).toBeNull();
        const filas = await pedir(`?fecha=${DIA_1}`);
        expect(filas).toHaveLength(1);
        expect(String(filas[0].fecha).substring(0, 10)).toBe(DIA_1);
    });

    it('2. `desde` devuelve TODO lo posterior, no solo ese día ← el bug de Balance', async () => {
        expect(setupError).toBeNull();
        const filas = await pedir(`?desde=${DIA_1}&hasta=${MES_SIGUIENTE}`);
        // Con el bug, aquí solo llegaba la venta del día 1.
        expect(filas).toHaveLength(2);
        const fechas = filas.map(v => String(v.fecha).substring(0, 10)).sort();
        expect(fechas).toEqual([DIA_1, DIA_2]);
    });

    it('3. el rango EXCLUYE lo anterior a `desde`', async () => {
        expect(setupError).toBeNull();
        const filas = await pedir(`?desde=${DIA_2}&hasta=${MES_SIGUIENTE}`);
        expect(filas).toHaveLength(1);
        expect(String(filas[0].fecha).substring(0, 10)).toBe(DIA_2);
    });

    it('4. un `desde` con formato inválido se ignora, no rompe ni inyecta', async () => {
        expect(setupError).toBeNull();
        const res = await request(API_URL)
            .get(`/api/sales?desde=${encodeURIComponent("2098-03-01'; DROP TABLE ventas;--")}`)
            .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`);
        expect(res.status).toBe(200);
        // Las ventas de test siguen existiendo: no se ha borrado nada.
        const siguen = await pedir(`?desde=${DIA_1}&hasta=${MES_SIGUIENTE}`);
        expect(siguen).toHaveLength(2);
    });
});
