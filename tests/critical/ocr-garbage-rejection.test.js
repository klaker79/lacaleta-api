/**
 * ============================================
 * tests/critical/ocr-garbage-rejection.test.js
 * ============================================
 *
 * Tests that OCR garbage data is handled gracefully (no server crashes).
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('OCR Garbage Rejection — Purchase data validation', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. POST /purchases/pending accepts valid data', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: 'TEST_OCR_VALID',
                    precio: 5.50,
                    cantidad: 3,
                    fecha: new Date().toISOString().split('T')[0]
                }]
            });

        expect([200, 201]).toContain(res.status);
    });

    it('2. POST /purchases/pending handles negative values', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: 'TEST_OCR_NEGATIVE',
                    precio: -5.50,
                    cantidad: -3,
                    fecha: new Date().toISOString().split('T')[0]
                }]
            });

        // Should not crash (500)
        expect(res.status).toBeLessThan(500);
    });

    it('3. POST /purchases/pending handles empty compras', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ compras: [] });

        expect(res.status).toBeLessThan(500);
    });

    it('4. POST /purchases/pending handles missing fields', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{ ingrediente: 'TEST_MISSING' }]
            });

        expect(res.status).toBeLessThan(500);
    });

    it('5. POST /purchases/pending handles garbage strings', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: 'TEST_GARBAGE',
                    precio: 'abc',
                    cantidad: 'xyz',
                    fecha: 'not-a-date'
                }]
            });

        expect(res.status).toBeLessThan(500);
    });

    it('6. POST /daily/purchases/bulk handles empty data', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/daily/purchases/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ compras: [] });

        expect(res.status).toBeLessThan(500);
    });

    it('7. POST /daily/purchases/bulk handles missing body', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/daily/purchases/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect(res.status).toBeLessThan(500);
    });
});
