/**
 * ============================================
 * tests/integration/chat.test.js
 * ============================================
 *
 * Integration tests for POST /api/chat (Claude API backend).
 *
 * The "real model" test (calling Anthropic) is skipped unless
 * RUN_CHAT_LIVE=1 is set, so CI doesn't burn tokens on every run.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const LIVE = process.env.RUN_CHAT_LIVE === '1';

describe('POST /api/chat', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    describe('Auth and validation', () => {
        it('rejects without token (401)', async () => {
            const res = await request(API_URL)
                .post('/api/chat')
                .set('Origin', 'http://localhost:3001')
                .send({ message: 'hola' });

            expect(res.status).toBe(401);
        });

        it('rejects empty message (400)', async () => {
            if (!authToken) {
                console.warn('⚠️ Sin autenticación — skip');
                return;
            }
            const res = await request(API_URL)
                .post('/api/chat')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ message: '' });

            expect(res.status).toBe(400);
        });

        it('rejects missing message (400)', async () => {
            if (!authToken) return;
            const res = await request(API_URL)
                .post('/api/chat')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({});

            expect(res.status).toBe(400);
        });

        it('rejects message over 4000 chars (400)', async () => {
            if (!authToken) return;
            const res = await request(API_URL)
                .post('/api/chat')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ message: 'a'.repeat(4001) });

            expect(res.status).toBe(400);
        });
    });

    (LIVE ? describe : describe.skip)('Live Claude API (RUN_CHAT_LIVE=1)', () => {
        it('returns a plain-text response for a simple greeting', async () => {
            if (!authToken) return;
            const res = await request(API_URL)
                .post('/api/chat')
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send({ message: 'Hola, ¿cuántos ingredientes tengo?', lang: 'es' });

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/plain/);
            expect(res.text.length).toBeGreaterThan(0);
            console.log('🤖 Respuesta:', res.text.slice(0, 300));
        }, 60000);
    });
});
