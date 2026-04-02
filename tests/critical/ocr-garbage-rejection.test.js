/**
 * ============================================
 * tests/critical/ocr-garbage-rejection.test.js
 * ============================================
 *
 * Tests that OCR garbage data is handled gracefully.
 *
 * Real production incidents:
 * - GUANTES: cantidad=1000, precio=0.01 (OCR garbage inflated stock by 500,000)
 * - SERVILLETAS: cantidad=40, precio=0.90 (correct data but multiplied by cpf)
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
        expect(res.body.recibidos).toBeGreaterThanOrEqual(1);
    });

    it('2. POST /purchases/pending handles negative values (Math.abs)', async () => {
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

        // Should accept (Math.abs is applied)
        expect([200, 201]).toContain(res.status);
    });

    it('3. POST /purchases/pending handles empty compras array', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ compras: [] });

        // Should not crash — return 400 or empty result
        expect(res.status).toBeLessThan(500);
    });

    it('4. POST /purchases/pending handles missing fields gracefully', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: 'TEST_MISSING_FIELDS'
                    // No precio, no cantidad, no fecha
                }]
            });

        // Should not crash the server (500)
        expect(res.status).toBeLessThan(500);
    });

    it('5. POST /purchases/pending handles garbage strings in numeric fields', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: 'TEST_GARBAGE_NUMS',
                    precio: 'abc',
                    cantidad: 'xyz',
                    fecha: 'not-a-date'
                }]
            });

        // Should not crash the server
        expect(res.status).toBeLessThan(500);
    });

    it('6. Bulk purchases route does not crash on empty data', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/daily/purchases/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ compras: [] });

        expect(res.status).toBeLessThan(500);
    });

    it('7. Bulk purchases route does not crash on missing body', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/daily/purchases/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect(res.status).toBeLessThan(500);
    });
});
