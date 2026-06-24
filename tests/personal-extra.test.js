/**
 * ============================================
 * tests/personal-extra.test.js
 * ============================================
 *
 * CRUD /api/personal-extra — pagos a extras por horas (PyG).
 * Verifica: cálculo de total, filtro por rango de fechas, borrado
 * y aislamiento multi-tenant.
 *
 * Usa los helpers globales de tests/setup.js (getAuthToken, API_URL)
 * y SIEMPRE el header Origin requerido por el CORS del backend.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('CRUD /api/personal-extra', () => {
    let authToken;
    let createdId;
    // Fecha fija y única para el rango (evita colisión con datos reales del mes).
    const fecha = '2099-01-15';
    const desdeIn = '2099-01-01';
    const hastaIn = '2099-01-31';
    const desdeOut = '2099-02-01';
    const hastaOut = '2099-02-28';

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
        }
    });

    afterAll(async () => {
        // Limpieza defensiva por si algún assert falla antes del DELETE.
        if (authToken && createdId) {
            await request(API_URL)
                .delete(`/api/personal-extra/${createdId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('a. POST crea apunte y calcula total (4.5h × 12.5 = 56.25)', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/personal-extra')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ fecha, nombre: 'Extra Test', horas: 4.5, precio_hora: 12.5, observaciones: 'jest' });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();
        expect(Number(res.body.total)).toBeCloseTo(56.25, 2);
        expect(Number(res.body.horas)).toBeCloseTo(4.5, 2);
        expect(Number(res.body.precio_hora)).toBeCloseTo(12.5, 2);

        createdId = res.body.id;
    });

    it('b1. GET con rango que incluye la fecha → aparece el apunte', async () => {
        if (!authToken || !createdId) return;

        const res = await request(API_URL)
            .get(`/api/personal-extra?desde=${desdeIn}&hasta=${hastaIn}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        const ids = res.body.map((r) => r.id);
        expect(ids).toContain(createdId);
    });

    it('b3. GET SIN parámetros (mes en curso) NO revienta → 200', async () => {
        if (!authToken) return;
        // Regresión: el default usaba "${ym}-31" (fecha inexistente en meses de
        // 30 días/febrero) y la query daba 500. Debe responder 200 con un array.
        const res = await request(API_URL)
            .get('/api/personal-extra')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('b2. GET con rango que NO incluye la fecha → no aparece', async () => {
        if (!authToken || !createdId) return;

        const res = await request(API_URL)
            .get(`/api/personal-extra?desde=${desdeOut}&hasta=${hastaOut}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        const ids = res.body.map((r) => r.id);
        expect(ids).not.toContain(createdId);
    });

    it('c. DELETE elimina el apunte → 200', async () => {
        if (!authToken || !createdId) return;

        const res = await request(API_URL)
            .delete(`/api/personal-extra/${createdId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.message).toBeDefined();

        // Confirmar que ya no aparece.
        const after = await request(API_URL)
            .get(`/api/personal-extra?desde=${desdeIn}&hasta=${hastaIn}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const ids = after.body.map((r) => r.id);
        expect(ids).not.toContain(createdId);

        createdId = null; // evita doble borrado en afterAll
    });

    // Aislamiento multi-tenant: tests/setup.js solo expone credenciales de UN
    // restaurante (TEST_USER_EMAIL/PASSWORD), por lo que no se puede autenticar
    // un segundo tenant para comprobar que B no ve el apunte de A. Se deja como
    // skip explícito; la garantía de aislamiento la cubre el WHERE restaurante_id
    // de cada query y tests/critical/multi-tenant-isolation.test.js.
    it.skip('d. Aislamiento: restaurante B no ve el apunte de A (sin 2º tenant en setup)', async () => {
        // Pendiente: requiere TEST_USER_EMAIL_B / TEST_USER_PASSWORD_B en el entorno.
    });
});
