/**
 * ============================================
 * tests/critical/ingredient-no-duplicate.test.js
 * ============================================
 *
 * CRITICAL (auditoría 2026-06-27 HIGH-1): POST /ingredients NO debe crear un
 * ingrediente con el mismo nombre (insensible a mayúsculas/espacios) que otro
 * vivo del mismo tenant. Duplicar fragmenta stock y precios (causa raíz).
 *
 * Contrato:
 *   1. Crear un ingrediente nuevo → 201.
 *   2. Crear OTRO con el mismo nombre exacto → 409 + existingId.
 *   3. Crear OTRO variando mayúsculas/espacios → 409 (mismo existingId).
 *   4. Un nombre distinto sí se crea → 201.
 *
 * @date 2026-06-27
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('POST /ingredients — anti-duplicado por tenant (HIGH-1)', () => {
    let authToken;
    let createdId;
    let otherId;
    const baseName = `ZZ_DUP_TEST_${Date.now()}`;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) console.warn('⚠️ No auth. Tests skipped.');
    });

    afterAll(async () => {
        for (const id of [createdId, otherId]) {
            if (id && authToken) {
                await request(API_URL)
                    .delete(`/api/ingredients/${id}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            }
        }
    });

    const crear = (nombre) => request(API_URL)
        .post('/api/ingredients')
        .set('Origin', 'http://localhost:3001')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ nombre, precio: 5, unidad: 'kg' });

    it('1. Crea el ingrediente nuevo → 201', async () => {
        if (!authToken) return;
        const res = await crear(baseName);
        expect(res.status).toBe(201);
        createdId = res.body.id;
        expect(createdId).toBeDefined();
    });

    it('2. Mismo nombre exacto → 409 + existingId', async () => {
        if (!authToken || !createdId) return;
        const res = await crear(baseName);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INGREDIENTE_DUPLICADO');
        expect(res.body.existingId).toBe(createdId);
    });

    it('3. Variando mayúsculas/espacios → 409 (no crea duplicado)', async () => {
        if (!authToken || !createdId) return;
        const res = await crear(`  ${baseName.toLowerCase()}  `);
        expect(res.status).toBe(409);
        expect(res.body.existingId).toBe(createdId);
    });

    it('4. Un nombre distinto sí se crea → 201', async () => {
        if (!authToken) return;
        const res = await crear(`${baseName}_OTRO`);
        expect(res.status).toBe(201);
        otherId = res.body.id;
        expect(otherId).toBeDefined();
    });
});
