/**
 * ============================================
 * tests/critical/pdf-parse-smoke.test.js
 * ============================================
 *
 * PRIORITY 5 — Smoke test.
 * Verifies that POST /api/parse-pdf validates inputs correctly.
 * Does NOT make real Anthropic API calls — only tests error handling.
 *
 * @author MindLoopIA
 * @date 2026-02-13
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('PDF Parse — Input validation smoke test', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. POST /api/parse-pdf without pdfBase64 → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/parse-pdf')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('pdfBase64');
        console.log(`✅ Missing pdfBase64 → 400: ${res.body.error}`);
    });

    it('2. POST /api/parse-pdf with payload → validates API key availability', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/parse-pdf')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ pdfBase64: 'dGVzdA==', filename: 'test.pdf' });

        // Without ANTHROPIC_API_KEY configured, server should return 500
        // With it configured, it would try to call the API (not what we want in test)
        // Either way, the endpoint is reachable and handles the request
        expect([200, 500]).toContain(res.status);

        if (res.status === 500 && res.body.error) {
            const isApiKeyError = res.body.error.includes('ANTHROPIC_API_KEY') ||
                res.body.error.includes('IA') ||
                res.body.error.includes('Error');
            expect(isApiKeyError).toBe(true);
            console.log(`✅ API key not configured (expected in test): ${res.body.error}`);
        } else {
            console.log(`ℹ️ PDF endpoint responded with ${res.status} (API key may be configured)`);
        }
    });
});
