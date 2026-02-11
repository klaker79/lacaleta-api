/**
 * ============================================
 * tests/critical/intelligence-endpoints.test.js
 * ============================================
 *
 * Verifica que los 4 endpoints de inteligencia devuelven
 * datos estructurados correctos y no crashean.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Intelligence Endpoints — Structure and stability', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /api/intelligence/freshness — returns array with urgencia levels', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/intelligence/freshness')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        if (res.body.length > 0) {
            const item = res.body[0];
            expect(item).toHaveProperty('nombre');
            expect(item).toHaveProperty('urgencia');
            expect(['critico', 'hoy', 'mañana', 'ok']).toContain(item.urgencia);
            console.log(`🧊 Freshness alerts: ${res.body.length} items`);
            res.body.forEach(a => console.log(`   ${a.nombre}: ${a.urgencia} (${a.dias_restantes} días)`));
        } else {
            console.log(`✅ Freshness: no alerts (all fresh)`);
        }
    });

    it('2. GET /api/intelligence/purchase-plan — returns suggestions', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/intelligence/purchase-plan?day=6')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('dia_objetivo');
        expect(res.body).toHaveProperty('sugerencias');
        expect(Array.isArray(res.body.sugerencias)).toBe(true);

        console.log(`📦 Purchase plan for ${res.body.dia_objetivo}: ${res.body.sugerencias.length} suggestions`);
        res.body.sugerencias.slice(0, 3).forEach(s =>
            console.log(`   ${s.nombre}: need ${parseFloat(s.sugerencia_pedido).toFixed(1)} ${s.unidad}`)
        );
    });

    it('3. GET /api/intelligence/overstock — returns array', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/intelligence/overstock')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        if (res.body.length > 0) {
            const item = res.body[0];
            expect(item).toHaveProperty('nombre');
            expect(item).toHaveProperty('dias_stock');
            console.log(`📈 Overstock: ${res.body.length} items`);
            res.body.slice(0, 3).forEach(s =>
                console.log(`   ${s.nombre}: ${parseFloat(s.dias_stock).toFixed(0)} days of stock`)
            );
        } else {
            console.log(`✅ Overstock: no alerts`);
        }
    });

    it('4. GET /api/intelligence/price-check — returns valid data', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/intelligence/price-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();

        // Endpoint may return array or object with alerts
        const items = Array.isArray(res.body) ? res.body : (res.body.alertas || res.body.recetas || []);

        if (items.length > 0) {
            console.log(`💰 Price check items: ${items.length}`);
            items.slice(0, 3).forEach(s =>
                console.log(`   ${s.nombre}: food cost ${parseFloat(s.food_cost_percent || s.food_cost || 0).toFixed(1)}%`)
            );
        } else {
            console.log(`✅ Price check: ${JSON.stringify(Object.keys(res.body)).slice(0, 80)}`);
        }
    });

    it('5. GET /api/intelligence/waste-stats — returns waste analytics', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/intelligence/waste-stats')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        // Should return some structure (array or object)
        console.log(`🗑️ Waste stats type: ${Array.isArray(res.body) ? 'array' : 'object'}`);
        if (Array.isArray(res.body)) {
            console.log(`   Items: ${res.body.length}`);
        } else if (res.body) {
            const keys = Object.keys(res.body);
            console.log(`   Keys: ${keys.join(', ')}`);
        }
    });
});
