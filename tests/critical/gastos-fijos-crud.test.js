/**
 * ═══════════════════════════════════════════════════
 * 💰 GASTOS FIJOS — CRUD lifecycle + validation
 * ═══════════════════════════════════════════════════
 * Tests:
 * 1. POST /api/gastos-fijos with missing concepto → 400
 * 2. POST /api/gastos-fijos — creates fixed expense
 * 3. GET /api/gastos-fijos — lists the created expense
 * 4. PUT /api/gastos-fijos/:id — updates expense
 * 5. DELETE /api/gastos-fijos/:id — soft deletes (no longer in GET)
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Gastos Fijos — CRUD lifecycle', () => {
    let authToken;
    let createdGastoId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    afterAll(async () => {
        // Cleanup: delete the test gasto fijo if it was created
        if (authToken && createdGastoId) {
            await request(API_URL)
                .delete(`/api/gastos-fijos/${createdGastoId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🗑️ Cleaned up gasto fijo ${createdGastoId}`);
        }
    });

    it('1. POST /api/gastos-fijos without concepto → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/gastos-fijos')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ monto_mensual: 500 });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Missing concepto → ${res.status}: ${res.body.error}`);
    });

    it('2. POST /api/gastos-fijos — creates fixed expense', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/gastos-fijos')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                concepto: '_TEST_ALQUILER_AUTO_' + Date.now(),
                monto_mensual: 1500.50
            });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();
        expect(res.body.concepto).toContain('_TEST_ALQUILER_AUTO_');
        expect(parseFloat(res.body.monto_mensual)).toBeCloseTo(1500.50, 1);

        createdGastoId = res.body.id;
        console.log(`✅ Created gasto fijo #${createdGastoId}: ${res.body.concepto} → ${res.body.monto_mensual}€/mes`);
    });

    it('3. GET /api/gastos-fijos — lists the created expense', async () => {
        if (!authToken || !createdGastoId) return;

        const res = await request(API_URL)
            .get('/api/gastos-fijos')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const found = res.body.find(g => g.id === createdGastoId);
        expect(found).toBeDefined();
        console.log(`✅ Found gasto fijo in list (${res.body.length} total)`);
    });

    it('4. PUT /api/gastos-fijos/:id — updates expense', async () => {
        if (!authToken || !createdGastoId) return;

        const res = await request(API_URL)
            .put(`/api/gastos-fijos/${createdGastoId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ monto_mensual: 1800 });

        expect(res.status).toBe(200);
        expect(parseFloat(res.body.monto_mensual)).toBeCloseTo(1800, 0);
        console.log(`✅ Updated gasto fijo: monto_mensual → ${res.body.monto_mensual}€`);
    });

    it('5. DELETE /api/gastos-fijos/:id — soft deletes', async () => {
        if (!authToken || !createdGastoId) return;

        const deleteRes = await request(API_URL)
            .delete(`/api/gastos-fijos/${createdGastoId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(deleteRes.status).toBe(200);

        // Verify it no longer appears in GET
        const listRes = await request(API_URL)
            .get('/api/gastos-fijos')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const found = listRes.body.find(g => g.id === createdGastoId);
        expect(found).toBeUndefined();

        console.log(`✅ Gasto fijo soft-deleted, no longer in active list`);
        createdGastoId = null; // Don't double-delete in afterAll
    });
});
