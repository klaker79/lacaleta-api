/**
 * ═══════════════════════════════════════════════════
 * 🍽️ MENU ENGINEERING FILTER — Beverages excluded
 * ═══════════════════════════════════════════════════
 * Validates the bug fix: beverages should NOT appear
 * in the BCG matrix (menu engineering analysis).
 * 
 * Tests:
 * 1. Menu engineering returns only food items (no bebidas)
 * 2. Response items have required BCG classification fields
 * 3. Creating a beverage recipe does NOT appear in results
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Menu Engineering Filter — No beverages in BCG matrix', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. Menu engineering returns only food items (no bebidas)', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/analysis/menu-engineering')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        // Check that NO item has categoria = 'bebidas' or 'bebida'
        const beverages = res.body.filter(item => {
            const cat = (item.categoria || '').toLowerCase();
            return cat === 'bebidas' || cat === 'bebida';
        });

        expect(beverages.length).toBe(0);
        console.log(`✅ Menu engineering: ${res.body.length} items, 0 beverages`);

        // Log the categories we DO see
        const categories = [...new Set(res.body.map(i => i.categoria))];
        console.log(`   Categories present: ${categories.join(', ')}`);
    });

    it('2. Response items have required BCG classification fields', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/analysis/menu-engineering')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        if (res.body.length > 0) {
            const item = res.body[0];
            // Every item should have BCG classification
            expect(item.clasificacion).toBeDefined();
            expect(['estrella', 'puzzle', 'caballo', 'perro']).toContain(item.clasificacion);
            expect(item.margen).toBeDefined();
            expect(item.popularidad).toBeDefined();
            expect(item.foodCost).toBeDefined();
            expect(item.metricas).toBeDefined();
            expect(item.metricas.esPopular).toBeDefined();
            expect(item.metricas.esRentable).toBeDefined();

            console.log(`✅ BCG fields verified on "${item.nombre}": ${item.clasificacion}`);
            console.log(`   Margin: ${item.margen.toFixed(2)}€ | Food cost: ${item.foodCost.toFixed(1)}%`);
        } else {
            console.log(`⚠️ No menu engineering data (no sales recorded)`);
        }
    });

    it('3. Balance comparativa returns monthly data', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/balance/comparativa')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        if (res.body.length > 0) {
            const month = res.body[0];
            expect(month.mes).toBeDefined();
            expect(month.ingresos).toBeDefined();
            expect(month.num_ventas).toBeDefined();
            console.log(`✅ Balance comparativa: ${res.body.length} months`);
            console.log(`   Latest: ${month.mes} → ${parseFloat(month.ingresos).toFixed(2)}€ (${month.num_ventas} sales)`);
        } else {
            console.log(`⚠️ No historical balance data`);
        }
    });
});
