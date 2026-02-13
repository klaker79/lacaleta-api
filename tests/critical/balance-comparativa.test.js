/**
 * ============================================
 * tests/critical/balance-comparativa.test.js
 * ============================================
 *
 * PRIORITY 3 — Multi-month PNL comparison and cross-check.
 * Verifies /api/balance/comparativa returns valid monthly data
 * and that numbers match /api/balance/mes for the same month.
 *
 * @author MindLoopIA
 * @date 2026-02-13
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Balance Comparativa — Multi-month PNL and cross-check', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /api/balance/comparativa — returns monthly revenue array', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/balance/comparativa')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        if (res.body.length === 0) {
            console.log('⚠️ No monthly data — no sales in DB (acceptable for integration test)');
            return;
        }

        // Verify structure
        const first = res.body[0];
        expect(first).toHaveProperty('mes');
        expect(first).toHaveProperty('ingresos');
        expect(first).toHaveProperty('num_ventas');

        // Verify values
        for (const month of res.body) {
            const ingresos = parseFloat(month.ingresos) || 0;
            const numVentas = parseInt(month.num_ventas) || 0;
            expect(ingresos).toBeGreaterThanOrEqual(0);
            expect(numVentas).toBeGreaterThanOrEqual(0);
        }

        console.log(`📊 Comparativa: ${res.body.length} months found`);
        res.body.slice(0, 3).forEach(m =>
            console.log(`   ${m.mes}: ingresos=${m.ingresos}€, ventas=${m.num_ventas}`)
        );
    });

    it('2. Months are ordered DESC and limited to 12', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/balance/comparativa')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        if (res.body.length < 2) {
            console.log('⚠️ Less than 2 months — cannot verify ordering');
            return;
        }

        // Should be ordered DESC (most recent first)
        for (let i = 0; i < res.body.length - 1; i++) {
            expect(res.body[i].mes >= res.body[i + 1].mes).toBe(true);
        }

        // Max 12 months
        expect(res.body.length).toBeLessThanOrEqual(12);

        console.log(`✅ ${res.body.length} months, ordered DESC: ${res.body[0].mes} → ${res.body[res.body.length - 1].mes}`);
    });

    it('3. Cross-check: comparativa ingresos ≈ balance/mes ingresos for same month', async () => {
        if (!authToken) return;

        const compRes = await request(API_URL)
            .get('/api/balance/comparativa')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(compRes.status).toBe(200);

        if (compRes.body.length === 0) {
            console.log('⚠️ No data to cross-check');
            return;
        }

        // Pick the first month with data
        const target = compRes.body.find(m => parseFloat(m.ingresos) > 0) || compRes.body[0];
        const [ano, mes] = target.mes.split('-');

        // Get detailed balance for same month
        const balRes = await request(API_URL)
            .get(`/api/balance/mes?mes=${parseInt(mes)}&ano=${parseInt(ano)}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(balRes.status).toBe(200);

        const compIngresos = parseFloat(target.ingresos) || 0;
        const balIngresos = parseFloat(balRes.body.ingresos) || 0;
        const diff = Math.abs(compIngresos - balIngresos);

        console.log(`🔄 Cross-check ${target.mes}:`);
        console.log(`   comparativa.ingresos = ${compIngresos}€`);
        console.log(`   balance/mes.ingresos = ${balIngresos}€`);

        if (diff > 0.01) {
            console.log(`   ⚠️ BUG: Mismatch of ${diff.toFixed(2)}€ between endpoints`);
        } else {
            console.log(`   ✅ Values match`);
        }

        expect(diff).toBeLessThan(0.01);
    });
});
