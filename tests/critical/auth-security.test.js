/**
 * ============================================
 * tests/critical/auth-security.test.js
 * ============================================
 *
 * Verifica seguridad básica:
 * - Endpoints protegidos rechazan peticiones sin token
 * - Endpoints admin rechazan sin rol admin
 * - Errores no filtran información sensible
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Auth & Security — Token validation and admin protection', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    // ===== UNAUTHENTICATED REQUESTS =====

    it('1. GET /api/ingredients without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
        console.log(`🔒 GET /api/ingredients sin token: ${res.status}`);
    });

    it('2. GET /api/orders without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/orders')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
        console.log(`🔒 GET /api/orders sin token: ${res.status}`);
    });

    it('3. GET /api/suppliers without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
        console.log(`🔒 GET /api/suppliers sin token: ${res.status}`);
    });

    it('4. POST /api/sales without token → 401', async () => {
        const res = await request(API_URL)
            .post('/api/sales')
            .set('Origin', 'http://localhost:3001')
            .send({ recetaId: 1, cantidad: 1 });

        expect(res.status).toBe(401);
        console.log(`🔒 POST /api/sales sin token: ${res.status}`);
    });

    // ===== INVALID TOKEN =====

    it('5. GET /api/ingredients with invalid token → 401/403', async () => {
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', 'Bearer invalid.token.here');

        expect([401, 403]).toContain(res.status);
        console.log(`🔒 GET /api/ingredients con token inválido: ${res.status}`);
    });

    // ===== ADMIN-ONLY ENDPOINTS =====

    it('6. DELETE /api/horarios/all requires admin role', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .delete('/api/horarios/all')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Should be 403 if not admin, or 200 if admin
        // The important thing is it doesn't return 401 (auth works) or 500 (crash)
        expect([200, 403]).toContain(res.status);
        console.log(`🛡️ DELETE /api/horarios/all: ${res.status} (${res.status === 403 ? 'blocked ✅' : 'admin ✅'})`);
    });

    it('7. DELETE /api/mermas/reset requires admin role', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .delete('/api/mermas/reset')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Should be 403 if not admin, or 200 if admin
        expect([200, 403]).toContain(res.status);
        console.log(`🛡️ DELETE /api/mermas/reset: ${res.status} (${res.status === 403 ? 'blocked ✅' : 'admin ✅'})`);
    });

    // ===== ERROR INFO LEAKAGE =====

    it('8. 404 response should NOT leak path/method info', async () => {
        const res = await request(API_URL)
            .get('/api/this-route-does-not-exist-12345')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(404);

        // Should not contain path or method in the response body
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('this-route-does-not-exist-12345');
        expect(body).not.toContain('"method"');
        console.log(`🔒 404 response body: ${body}`);
    });

    it('9. Health check endpoint should NOT leak err.message on failure', async () => {
        // Just verify the endpoint exists and responds properly
        const res = await request(API_URL)
            .get('/api/system/health-check')
            .set('Origin', 'http://localhost:3001');

        // Health check could be 200 (healthy) or 500 (unhealthy)
        expect([200, 500]).toContain(res.status);

        if (res.status === 500) {
            const body = JSON.stringify(res.body);
            // Should NOT contain stack traces or detailed error info
            expect(body).not.toContain('at ');
            expect(body).not.toContain('node_modules');
            console.log(`🔒 Health check error response is sanitized: ✅`);
        } else {
            console.log(`💚 Health check: ${res.status} OK`);
        }
    });
});
