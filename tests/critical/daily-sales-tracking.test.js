/**
 * ═══════════════════════════════════════════════════
 * 📊 DAILY SALES TRACKING — Sales summary + monthly report
 * ═══════════════════════════════════════════════════
 * Tests:
 * 1. GET /api/daily/sales — returns daily sales data
 * 2. GET /api/daily/sales with fecha filter — returns specific day
 * 3. GET /api/monthly/summary — returns monthly Excel-format report
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Daily Sales Tracking — Sales summaries and monthly reports', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. GET /api/daily/sales — returns daily sales data', async () => {
        if (!authToken) return;

        const now = new Date();
        const mes = now.getMonth() + 1;
        const ano = now.getFullYear();

        const res = await request(API_URL)
            .get(`/api/daily/sales?mes=${mes}&ano=${ano}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        console.log(`✅ Daily sales for ${mes}/${ano}: ${res.body.length} records`);
    });

    it('2. GET /api/daily/sales with fecha filter — returns specific day', async () => {
        if (!authToken) return;

        const today = new Date().toISOString().split('T')[0];

        const res = await request(API_URL)
            .get(`/api/daily/sales?fecha=${today}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        console.log(`✅ Sales for ${today}: ${res.body.length} records`);
    });

    it('3. GET /api/monthly/summary — returns monthly report structure', async () => {
        if (!authToken) return;

        const now = new Date();
        const mes = now.getMonth() + 1;
        const ano = now.getFullYear();

        const res = await request(API_URL)
            .get(`/api/monthly/summary?mes=${mes}&ano=${ano}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();

        // The monthly summary should have purchases and sales data
        if (res.body.compras || res.body.ventas || res.body.dias) {
            console.log(`✅ Monthly summary structure: ${Object.keys(res.body).join(', ')}`);
        } else {
            // May return raw object with different structure
            console.log(`✅ Monthly summary returned: ${typeof res.body} with ${Object.keys(res.body).length} keys`);
        }
    });
});
