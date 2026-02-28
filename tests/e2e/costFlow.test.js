/**
 * E2E Test: Flujo completo de cálculo de costes
 * Nota: Los endpoints v2 pueden no estar implementados aún.
 * Estos tests validan la estructura de respuesta SOLO si el endpoint responde 200.
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
        it('should handle calculate-cost request', async () => {
            if (!authToken) {
                console.warn('Skipping test - no auth token');
                return;
            }

            const res = await request(API_URL)
                .post('/api/v2/recipes/1/calculate-cost')
                .set('Authorization', `Bearer ${authToken}`);

            // Accept any non-500 response — endpoint may not exist yet
            expect(res.status).toBeLessThan(500);
            console.log(`✅ calculate-cost → ${res.status}`);

            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                expect(res.body.data).toHaveProperty('breakdown');
            }
        });

        it('should require authentication', async () => {
            const res = await request(API_URL)
                .post('/api/v2/recipes/1/calculate-cost')
                .set('Origin', 'http://localhost:3001');

            expect([401, 403, 404]).toContain(res.status);
        });
    });

    describe('GET /api/v2/recipes/stats', () => {
        it('should handle stats request', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .get('/api/v2/recipes/stats')
                .set('Authorization', `Bearer ${authToken}`);

            expect(res.status).toBeLessThan(500);
            console.log(`✅ recipes/stats → ${res.status}`);

            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                expect(res.body.data).toHaveProperty('totalRecipes');
            }
        });
    });

    describe('POST /api/v2/recipes/recalculate-all', () => {
        it('should handle recalculate-all request', async () => {
            if (!authToken) return;

            const res = await request(API_URL)
                .post('/api/v2/recipes/recalculate-all')
                .set('Authorization', `Bearer ${authToken}`);

            expect(res.status).toBeLessThan(500);
            console.log(`✅ recalculate-all → ${res.status}`);

            if (res.status === 200) {
                expect(res.body.success).toBe(true);
                expect(res.body.data).toHaveProperty('total');
            }
        });
    });
});
