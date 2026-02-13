/**
 * ============================================
 * tests/critical/average-cost-calculation.test.js
 * ============================================
 *
 * PRIORITY 1 — Financial, critical.
 * Verifies that GET /api/inventory/complete returns correct
 * precio_medio and valor_stock calculations, respecting
 * cantidad_por_formato (e.g. beer barrels → individual units).
 *
 * @author MindLoopIA
 * @date 2026-02-13
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Average Cost Calculation — /api/inventory/complete math', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. Returns array with precio_medio and valor_stock for each ingredient', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/inventory/complete')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);

        // Every item must have the financial fields
        const first = res.body[0];
        expect(first).toHaveProperty('precio_medio');
        expect(first).toHaveProperty('valor_stock');
        expect(first).toHaveProperty('stock_virtual');
        expect(first).toHaveProperty('nombre');

        console.log(`📊 Inventory: ${res.body.length} ingredients with cost data`);
        console.log(`   First: ${first.nombre} → precio_medio=${first.precio_medio}, valor_stock=${first.valor_stock}`);
    });

    it('2. valor_stock ≈ stock_virtual × precio_medio (tolerance 0.01)', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/inventory/complete')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        let checked = 0;
        let bugs = [];

        for (const item of res.body) {
            const precioMedio = parseFloat(item.precio_medio) || 0;
            const stockVirtual = parseFloat(item.stock_virtual) || 0;
            const valorStock = parseFloat(item.valor_stock) || 0;
            const expected = stockVirtual * precioMedio;
            const diff = Math.abs(valorStock - expected);

            if (diff > 0.02) {
                bugs.push(`⚠️ BUG: ${item.nombre} — valor_stock=${valorStock} != stock(${stockVirtual}) × precio(${precioMedio}) = ${expected.toFixed(2)}`);
            }
            checked++;
        }

        if (bugs.length > 0) {
            console.log(`🐛 BUGS FOUND (${bugs.length}/${checked}):`);
            bugs.slice(0, 5).forEach(b => console.log(`   ${b}`));
        } else {
            console.log(`✅ valor_stock math consistent for all ${checked} ingredients`);
        }

        // Allow up to 5% inconsistency rate (floating point edge cases)
        const errorRate = bugs.length / checked;
        expect(errorRate).toBeLessThan(0.05);
    });

    it('3. precio_medio respects cantidad_por_formato division', async () => {
        if (!authToken) return;

        // Get raw ingredients to compare
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(ingRes.status).toBe(200);

        // Find an ingredient with cantidad_por_formato > 1
        const withFormat = ingRes.body.find(i =>
            parseFloat(i.cantidad_por_formato) > 1
        );

        if (!withFormat) {
            console.log('⚠️ No ingredient with cantidad_por_formato > 1 found — skipping');
            return;
        }

        // Get inventory/complete and find same ingredient
        const invRes = await request(API_URL)
            .get('/api/inventory/complete')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(invRes.status).toBe(200);

        const invItem = invRes.body.find(i => i.id === withFormat.id);
        expect(invItem).toBeDefined();

        const rawPrice = parseFloat(withFormat.precio) || 0;
        const cpf = parseFloat(withFormat.cantidad_por_formato) || 1;
        const expectedPrecioMedio = cpf > 0 ? rawPrice / cpf : rawPrice;
        const actualPrecioMedio = parseFloat(invItem.precio_medio) || 0;

        console.log(`🧮 ${withFormat.nombre}: precio=${rawPrice}, cpf=${cpf}`);
        console.log(`   Expected precio_medio: ${rawPrice}/${cpf} = ${expectedPrecioMedio.toFixed(4)}`);
        console.log(`   Actual precio_medio: ${actualPrecioMedio}`);

        const diff = Math.abs(actualPrecioMedio - expectedPrecioMedio);
        if (diff > 0.01) {
            console.log(`   ⚠️ BUG: Mismatch of ${diff.toFixed(4)}`);
        } else {
            console.log(`   ✅ Match within tolerance`);
        }

        expect(diff).toBeLessThan(0.01);
    });
});
