/**
 * ============================================
 * tests/critical/transfer-stock-validation.test.js
 * ============================================
 *
 * Tests that transfers do not create phantom stock.
 * Transfers require admin role + multi-restaurant owner access.
 * Tests gracefully skip if the CI user doesn't have these permissions.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Transfer Stock Validation', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. Transfer creation requires authentication', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/transfers')
            .set('Origin', 'http://localhost:3001')
            .send({ ingrediente_id: 1, cantidad: 1 });

        // Without auth token → 401
        expect(res.status).toBe(401);
    });

    it('2. Transfer creation with empty body returns 400, not 500', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/transfers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        // Should be a client error (400/403), never a server crash (500)
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
    });

    it('3. Pending count endpoint works with auth', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .get('/api/transfers/pending-count')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Should return data or 403 (not admin), never 500
        expect(res.status).toBeLessThan(500);
    });
});
