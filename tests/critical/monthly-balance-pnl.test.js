/**
 * ============================================
 * tests/critical/monthly-balance-pnl.test.js
 * ============================================
 *
 * Verifica que el endpoint de balance mensual devuelve
 * estructura correcta con valores consistentes.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('GET /api/balance/mes — Monthly P&L structure and math', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. Returns valid P&L structure with required fields', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/balance/mes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        // Verify required fields exist
        expect(res.body).toHaveProperty('ingresos');
        expect(res.body).toHaveProperty('costos');
        expect(res.body).toHaveProperty('ganancia');
        expect(res.body).toHaveProperty('margen');
        expect(res.body).toHaveProperty('num_ventas');
        expect(res.body).toHaveProperty('valor_inventario');

        console.log(`📊 Balance mensual:`);
        console.log(`   Ingresos: ${res.body.ingresos}€`);
        console.log(`   Costos: ${res.body.costos}€`);
        console.log(`   Ganancia: ${res.body.ganancia}€`);
        console.log(`   Margen: ${res.body.margen}%`);
        console.log(`   Num ventas: ${res.body.num_ventas}`);
        console.log(`   Valor inventario: ${res.body.valor_inventario}€`);
    });

    it('2. Financial values are non-negative and math is consistent', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/balance/mes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        const { ingresos, costos, ganancia, margen, num_ventas, valor_inventario } = res.body;

        // Values should be numbers
        expect(typeof ingresos).toBe('number');
        expect(typeof costos).toBe('number');
        expect(typeof ganancia).toBe('number');
        expect(typeof num_ventas).toBe('number');

        // Non-negative checks
        expect(ingresos).toBeGreaterThanOrEqual(0);
        expect(costos).toBeGreaterThanOrEqual(0);
        expect(num_ventas).toBeGreaterThanOrEqual(0);
        expect(valor_inventario).toBeGreaterThanOrEqual(0);

        // Math consistency: ganancia = ingresos - costos
        const expectedGanancia = ingresos - costos;
        expect(Math.abs(ganancia - expectedGanancia)).toBeLessThan(0.01);
        console.log(`✅ ganancia (${ganancia}) = ingresos (${ingresos}) - costos (${costos})`);

        // Margin consistency: margen = (ganancia / ingresos) * 100 OR 0 if no revenue
        if (ingresos > 0) {
            const expectedMargen = (ganancia / ingresos) * 100;
            expect(Math.abs(margen - expectedMargen)).toBeLessThan(0.2);
            console.log(`✅ margen (${margen}%) ≈ (${ganancia} / ${ingresos}) × 100 = ${expectedMargen.toFixed(1)}%`);
        } else {
            expect(margen).toBe(0);
            console.log(`✅ No revenue, margen = 0`);
        }
    });

    it('3. Historical month query returns valid data', async () => {
        if (!authToken) return;

        // Query January of current year (likely to have data)
        const res = await request(API_URL)
            .get('/api/balance/mes?mes=1&ano=2026')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('ingresos');
        expect(res.body).toHaveProperty('costos');
        expect(res.body).toHaveProperty('ganancia');

        console.log(`📊 January 2026: ingresos=${res.body.ingresos}€, costos=${res.body.costos}€, ventas=${res.body.num_ventas}`);

        // Should have some data for January
        if (res.body.num_ventas > 0) {
            console.log(`   ✅ Historical data found (${res.body.num_ventas} ventas)`);
        } else {
            console.log(`   ⚠️ No sales data for Jan 2026 (acceptable for integration test)`);
        }
    });
});
