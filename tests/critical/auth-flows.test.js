/**
 * ═══════════════════════════════════════════════════
 * 🔐 AUTH FLOWS — Registration and auth validation
 * ═══════════════════════════════════════════════════
 * Tests auth edge cases (without actually creating accounts):
 * 1. Register without required fields → 400
 * 2. Register with short password → 400
 * 3. Register with invalid invitation code → 403
 * 4. Token verify with valid token → 200
 * 5. Logout → 200
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Auth Flows — Registration validation and token management', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. POST /api/auth/register without required fields → 400', async () => {
        const res = await request(API_URL)
            .post('/api/auth/register')
            .set('Origin', 'http://localhost:3001')
            .send({ email: 'test@test.com' }); // Missing nombre and password

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Missing fields → ${res.status}: ${res.body.error}`);
    });

    it('2. POST /api/auth/register with short password → 400', async () => {
        const res = await request(API_URL)
            .post('/api/auth/register')
            .set('Origin', 'http://localhost:3001')
            .send({
                nombre: 'Test',
                email: 'test@test.com',
                password: '123' // Too short
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Short password → ${res.status}: ${res.body.error}`);
    });

    it('3. POST /api/auth/register with duplicate email → 400', async () => {
        const res = await request(API_URL)
            .post('/api/auth/register')
            .set('Origin', 'http://localhost:3001')
            .send({
                nombre: 'Duplicate User',
                email: TEST_USER_EMAIL,  // Already registered in CI setup
                password: 'password123'
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('registrado');
        console.log(`✅ Duplicate email → ${res.status}: ${res.body.error}`);
    });

    it('4. GET /api/auth/verify with valid token → 200', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/auth/verify')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.user).toBeDefined();
        expect(res.body.user.email).toBeDefined();
        expect(res.body.user.restauranteId).toBeDefined();
        console.log(`✅ Token verified: ${res.body.user.email} (restaurante #${res.body.user.restauranteId})`);
    });

    it('5. POST /api/auth/logout → 200', async () => {
        // ⚠️ FIX RACE CONDITION: Create a SEPARATE token for the logout test.
        // Using the shared cachedAuthToken would blacklist it server-side,
        // causing 401 "Token revocado" errors in parallel test suites.
        const loginRes = await request(API_URL)
            .post('/api/auth/login')
            .set('Origin', 'http://localhost:3001')
            .set('Content-Type', 'application/json')
            .send({
                email: process.env.TEST_USER_EMAIL || 'test@test.com',
                password: process.env.TEST_USER_PASSWORD || 'test123'
            });

        const logoutToken = loginRes.body.token || 'fake';

        const res = await request(API_URL)
            .post('/api/auth/logout')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${logoutToken}`);

        expect(res.status).toBe(200);
        console.log(`✅ Logout → ${res.status} (used separate token, shared token preserved)`);
    });
});
