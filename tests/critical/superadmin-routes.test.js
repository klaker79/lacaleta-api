/**
 * Super Admin Routes — Access control + endpoint validation
 *
 * Verifies:
 * - All superadmin endpoints require authentication (401 without token)
 * - All superadmin endpoints require superadmin flag (403 for regular users)
 * - Proper validation on inputs (400 for invalid data)
 * - Correct responses for superadmin users (200 with expected shape)
 *
 * NOTE: Test user may or may not be superadmin. Tests adapt accordingly.
 */
const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Super Admin Routes — Access control and endpoints', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    // ===== UNAUTHENTICATED — must return 401 =====

    it('GET /api/superadmin/metrics without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/superadmin/metrics')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
    });

    it('GET /api/superadmin/restaurants without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/superadmin/restaurants')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
    });

    it('GET /api/superadmin/restaurants/1 without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/superadmin/restaurants/1')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
    });

    it('PATCH /api/superadmin/restaurants/1 without token → 401', async () => {
        const res = await request(API_URL)
            .patch('/api/superadmin/restaurants/1')
            .set('Origin', 'http://localhost:3001')
            .send({ plan: 'premium' });

        expect(res.status).toBe(401);
    });

    it('GET /api/superadmin/restaurants/1/users without token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/superadmin/restaurants/1/users')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(401);
    });

    // ===== AUTHENTICATED — 403 for regular user, 200 for superadmin =====

    it('GET /api/superadmin/metrics with token → 403 or 200', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/metrics')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 403]).toContain(res.status);

        if (res.status === 200) {
            expect(res.body.totalRestaurants).toBeDefined();
            expect(res.body.activeSubscriptions).toBeDefined();
            expect(res.body.totalUsers).toBeDefined();
            expect(res.body.byPlan).toBeDefined();
            console.log(`✅ Superadmin metrics: ${res.body.totalRestaurants} restaurants, ${res.body.totalUsers} users`);
        } else {
            console.log(`✅ Superadmin metrics: 403 (test user is not superadmin)`);
        }
    });

    it('GET /api/superadmin/restaurants with token → 403 or 200', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/restaurants')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 403]).toContain(res.status);

        if (res.status === 200) {
            expect(res.body.restaurants).toBeDefined();
            expect(Array.isArray(res.body.restaurants)).toBe(true);
            expect(res.body.total).toBeDefined();
            console.log(`✅ Superadmin restaurants: ${res.body.total} total`);
        }
    });

    it('GET /api/superadmin/restaurants with filters → 403 or 200', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/restaurants?plan=premium&limit=10&offset=0')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 403]).toContain(res.status);

        if (res.status === 200) {
            expect(res.body.limit).toBe(10);
            expect(res.body.offset).toBe(0);
        }
    });

    it('GET /api/superadmin/restaurants/:id with token → 403 or 200/404', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/restaurants/1')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 403, 404]).toContain(res.status);

        if (res.status === 200) {
            expect(res.body.id).toBe(1);
            expect(res.body.users).toBeDefined();
            expect(Array.isArray(res.body.users)).toBe(true);
            console.log(`✅ Restaurant detail: ${res.body.nombre}, ${res.body.users.length} users`);
        }
    });

    it('GET /api/superadmin/restaurants/999999 → 403 or 404', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/restaurants/999999')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([403, 404]).toContain(res.status);
    });

    it('PATCH /api/superadmin/restaurants/1 with invalid plan → 403 or 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .patch('/api/superadmin/restaurants/1')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ plan: 'invalid_plan_name' });

        expect([400, 403]).toContain(res.status);
    });

    it('PATCH /api/superadmin/restaurants/1 with no fields → 403 or 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .patch('/api/superadmin/restaurants/1')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect([400, 403]).toContain(res.status);
    });

    it('GET /api/superadmin/restaurants/:id/users → 403 or 200/404', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/restaurants/1/users')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 403, 404]).toContain(res.status);

        if (res.status === 200) {
            expect(Array.isArray(res.body)).toBe(true);
        }
    });

    // ===== INVALID INPUT =====

    it('GET /api/superadmin/restaurants/abc → 400 or 403', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/superadmin/restaurants/abc')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([400, 403]).toContain(res.status);
    });

    it('Invalid token → 401', async () => {
        const res = await request(API_URL)
            .get('/api/superadmin/metrics')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', 'Bearer invalid.jwt.token');

        expect(res.status).toBe(401);
    });
});
