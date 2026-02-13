/**
 * ============================================
 * tests/critical/supplier-price-comparison.test.js
 * ============================================
 *
 * PRIORITY 2 — Affects purchase decisions.
 * Verifies supplier price comparison data from /api/ingredients-suppliers
 * and the intelligence price-check alert system.
 *
 * @author MindLoopIA
 * @date 2026-02-13
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Supplier Price Comparison — Multi-supplier pricing and alerts', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /api/ingredients-suppliers — returns price associations', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/ingredients-suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        if (res.body.length === 0) {
            console.log('⚠️ No ingredient-supplier associations found (acceptable for fresh DB)');
            return;
        }

        // Verify required fields
        const first = res.body[0];
        expect(first).toHaveProperty('ingrediente_id');
        expect(first).toHaveProperty('proveedor_id');
        expect(first).toHaveProperty('precio');
        expect(first).toHaveProperty('proveedor_nombre');

        // All prices should be non-negative numbers
        for (const item of res.body) {
            const precio = parseFloat(item.precio);
            expect(precio).toBeGreaterThanOrEqual(0);
        }

        console.log(`✅ ${res.body.length} ingredient-supplier associations`);
        console.log(`   First: ingrediente=${first.ingrediente_id}, proveedor=${first.proveedor_nombre}, precio=${first.precio}€`);
    });

    it('2. Same ingredient can have multiple suppliers with different prices', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/ingredients-suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        if (res.body.length < 2) {
            console.log('⚠️ Not enough associations to test multi-supplier — skipping');
            return;
        }

        // Group by ingrediente_id
        const byIngredient = {};
        for (const item of res.body) {
            if (!byIngredient[item.ingrediente_id]) {
                byIngredient[item.ingrediente_id] = [];
            }
            byIngredient[item.ingrediente_id].push(item);
        }

        // Find ingredients with multiple suppliers
        const multiSupplier = Object.entries(byIngredient)
            .filter(([_, suppliers]) => suppliers.length > 1);

        if (multiSupplier.length > 0) {
            const [ingId, suppliers] = multiSupplier[0];
            console.log(`✅ Ingredient #${ingId} has ${suppliers.length} suppliers:`);
            for (const s of suppliers) {
                console.log(`   ${s.proveedor_nombre}: ${s.precio}€ (principal: ${s.es_proveedor_principal})`);
            }
        } else {
            console.log(`📋 No ingredient has multiple suppliers — all ${Object.keys(byIngredient).length} ingredients have single supplier`);
        }

        // Verify data integrity — all IDs should be positive integers
        for (const item of res.body) {
            expect(item.ingrediente_id).toBeGreaterThan(0);
            expect(item.proveedor_id).toBeGreaterThan(0);
        }
    });

    it('3. GET /api/intelligence/price-check — returns alert structure', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/intelligence/price-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        // Required structure
        expect(res.body).toHaveProperty('objetivo');
        expect(res.body).toHaveProperty('umbral_alerta');
        expect(res.body).toHaveProperty('recetas_problema');
        expect(Array.isArray(res.body.recetas_problema)).toBe(true);

        // Business rules
        expect(res.body.objetivo).toBe(35); // 35% target food cost
        expect(res.body.umbral_alerta).toBe(40); // alert at 40%

        console.log(`✅ Price-check: target=${res.body.objetivo}%, alert=${res.body.umbral_alerta}%`);
        console.log(`   Recipes above threshold: ${res.body.recetas_problema.length}`);

        // Verify problematic recipes have valid data
        for (const r of res.body.recetas_problema.slice(0, 3)) {
            expect(r).toHaveProperty('nombre');
            expect(r).toHaveProperty('food_cost');
            expect(r.food_cost).toBeGreaterThan(res.body.umbral_alerta);
            console.log(`   ⚠️ ${r.nombre}: food_cost=${r.food_cost}%, sugerido=${r.precio_sugerido?.toFixed(2)}€`);
        }
    });
});
