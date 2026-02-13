/**
 * ============================================
 * tests/critical/ocr-integration.test.js
 * ============================================
 *
 * OCR/PDF integration smoke tests.
 * Verifies POST /api/parse-pdf handles input validation,
 * missing API keys, and invalid payloads gracefully.
 *
 * Does NOT make real Anthropic API calls.
 *
 * @author MindLoopIA
 * @date 2026-02-13
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('OCR Integration — PDF parse input validation and error handling', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. POST /api/parse-pdf without auth → 401', async () => {
        const res = await request(API_URL)
            .post('/api/parse-pdf')
            .set('Origin', 'http://localhost:3001')
            .send({ pdfBase64: 'test' });

        expect(res.status).toBe(401);
        console.log('✅ Parse-pdf requires authentication');
    });

    it('2. POST /api/parse-pdf with empty body → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/parse-pdf')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Empty body → 400: ${res.body.error}`);
    });

    it('3. POST /api/parse-pdf with null pdfBase64 → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/parse-pdf')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ pdfBase64: null, filename: 'test.pdf' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('pdfBase64');
        console.log(`✅ Null pdfBase64 → 400: ${res.body.error}`);
    });

    it('4. POST /api/parse-pdf with valid payload → controlled error (no API key crash)', async () => {
        if (!authToken) return;

        // Send a minimal base64 payload — should NOT crash the server
        const res = await request(API_URL)
            .post('/api/parse-pdf')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                pdfBase64: 'JVBERi0xLjQKMSAwIG9iago=', // minimal PDF header in base64
                filename: 'test-invoice.pdf'
            });

        // Without ANTHROPIC_API_KEY → controlled 500, not a crash
        // With API key → would attempt real parsing (200 or API error)
        expect([200, 500]).toContain(res.status);

        if (res.status === 500) {
            // Verify it's a controlled error, not an unhandled crash
            expect(res.body).toHaveProperty('error');
            const isControlled = res.body.error.includes('ANTHROPIC_API_KEY') ||
                res.body.error.includes('IA') ||
                res.body.error.includes('Error');
            expect(isControlled).toBe(true);
            console.log(`✅ No API key → controlled 500: ${res.body.error}`);
        } else {
            console.log(`ℹ️ API key configured — got ${res.status}`);
        }
    });

    it('5. POST /api/parse-pdf — server stays healthy after error', async () => {
        // Verify the server didn't crash from previous test
        const res = await request(API_URL)
            .get('/api/health')
            .set('Origin', 'http://localhost:3001');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('healthy');
        console.log(`✅ Server healthy after OCR error handling: ${res.body.status}`);
    });
});
