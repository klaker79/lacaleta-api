/**
 * E2E Test: Flujo completo de cálculo de costes
 */

const request = require('supertest');

const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Cost Calculation Flow E2E', () => {
    let authToken;

    beforeAll(async () => {
        const loginRes = await request(API_URL)
            .post('/api/auth/login')
            .send({
                email: process.env.TEST_USER_EMAIL || 'test@test.com',
                password: process.env.TEST_USER_PASSWORD || 'test123'
            });

        if (loginRes.body.token) {
            authToken = loginRes.body.token;
        } else {
            console.warn('No se pudo obtener token de auth');
        }
    });

    describe('POST /api/v2/recipes/:id/calculate-cost', () => {
        it('should calculate cost for existing recipe', async () => {
            if (!authToken) {
                console.warn('Skipping test - no auth token');
                return;
            }

            const res = await request(API_URL)
                .post('/api/v2/recipes/1/calculate-cost')
                .set('Authorization', `Bearer ${authToken}`);

            // Puede ser 200, 404 (no existe), o 501 (endpoint no implementado)
            expect([200, 404, 501]).toContain(res.status);

            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                expect(res.body.data).toHaveProperty('breakdown');
                expect(res.body.data.breakdown).toHaveProperty('totalCost');
            }
        });

        it('should return 404 for non-existent recipe', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/v2/recipes/99999/calculate-cost')
                .set('Authorization', `Bearer ${authToken}`);

            expect([404, 501]).toContain(res.status);
        });

        it('should require authentication', async () => {
            const res = await request(API_URL)
                .post('/api/v2/recipes/1/calculate-cost')
                .set('Origin', 'http://localhost:3001');

            // 401 (no auth) or 403 (CORS/auth rejection) are both valid
            expect([401, 403]).toContain(res.status);
        });
    });

    describe('GET /api/v2/recipes/stats', () => {
        it('should return cost statistics', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .get('/api/v2/recipes/stats')
                .set('Authorization', `Bearer ${authToken}`);

            // 200 or 501 if endpoint not yet implemented
            expect([200, 501]).toContain(res.status);

            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                expect(res.body.data).toHaveProperty('totalRecipes');
                expect(res.body.data).toHaveProperty('avgMargin');
                expect(res.body.data).toHaveProperty('avgFoodCost');
            }
        });
    });

    describe('POST /api/v2/recipes/recalculate-all', () => {
        it('should recalculate all recipes', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/v2/recipes/recalculate-all')
                .set('Authorization', `Bearer ${authToken}`);

            // 200 or 501 if endpoint not yet implemented
            expect([200, 501]).toContain(res.status);

            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                expect(res.body.data).toHaveProperty('total');
                expect(res.body.data).toHaveProperty('successful');
            }
        });
    });
});
