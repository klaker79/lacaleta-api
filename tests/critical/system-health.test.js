/**
 * ═══════════════════════════════════════════════════
 * 🏥 SYSTEM HEALTH CHECK — Operational diagnostics
 * ═══════════════════════════════════════════════════
 * Tests:
 * 1. GET /api/health — public health endpoint
 * 2. GET /api/system/health-check — authenticated diagnostics
 * 3. Health check returns expected diagnostic categories
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('System Health Check — Operational diagnostics', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /api/health — public health endpoint returns ok', async () => {
        const res = await request(API_URL)
            .get('/api/health')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(200);
        expect(res.body.status).toBeDefined();
        console.log(`✅ Public health: ${res.body.status}`);
    });

    it('2. GET /api/system/health-check — authenticated diagnostics', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/system/health-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.database).toBeDefined();
        expect(res.body.database.ok).toBe(true);
        console.log(`✅ System health check passed — DB: ${res.body.database.message}`);
    });

    it('3. Health check returns expected diagnostic categories', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/system/health-check')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);

        // Verify all diagnostic categories exist
        const categories = Object.keys(res.body);
        expect(categories).toContain('database');
        expect(categories).toContain('recetasSinIngredientes');
        expect(categories).toContain('stockNegativo');
        expect(categories).toContain('valorStock');

        // Each category should have an 'ok' field
        for (const cat of ['database', 'recetasSinIngredientes', 'stockNegativo']) {
            expect(res.body[cat].ok).toBeDefined();
        }

        console.log(`✅ Diagnostic categories: ${categories.join(', ')}`);

        // Log any warnings
        const warnings = categories.filter(c => res.body[c].ok === false);
        if (warnings.length > 0) {
            console.log(`   ⚠️ Warnings: ${warnings.join(', ')}`);
        } else {
            console.log(`   ✅ All checks passed`);
        }
    });
});
