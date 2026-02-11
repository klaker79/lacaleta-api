/**
 * ═══════════════════════════════════════════════════
 * 📝 PENDING PURCHASES ADVANCED — Update + reject
 * ═══════════════════════════════════════════════════
 * Tests the PUT (update) and reject flows for pending purchases.
 * The POST format uses: { compras: [{ ingrediente, precio, cantidad, fecha }] }
 *
 * Tests:
 * 1. POST /api/purchases/pending — create pending item
 * 2. PUT /api/purchases/pending/:id — update pending item
 * 3. PUT with empty body → 400
 * 4. DELETE /api/purchases/pending/:id — reject pending item
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Pending Purchases Advanced — Update and reject flows', () => {
    let authToken;
    let createdPendingId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    afterAll(async () => {
        if (authToken && createdPendingId) {
            await request(API_URL)
                .delete(`/api/purchases/pending/${createdPendingId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    it('1. POST /api/purchases/pending — create pending item', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/purchases/pending')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                compras: [{
                    ingrediente: '_TEST_PENDING_UPDATE_' + Date.now(),
                    precio: 8.50,
                    cantidad: 3,
                    fecha: new Date().toISOString().split('T')[0]
                }]
            });

        expect(res.status).toBe(200);
        expect(res.body.recibidos).toBeGreaterThanOrEqual(1);
        console.log(`✅ Created ${res.body.recibidos} pending purchase (batch: ${res.body.batchId})`);

        // Get the ID of the created pending item by listing pending
        const listRes = await request(API_URL)
            .get('/api/purchases/pending?estado=pendiente')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // Find the test item by batch_id or by ingredient name
        const found = listRes.body.find(p =>
            p.batch_id === res.body.batchId ||
            (p.ingrediente_nombre && p.ingrediente_nombre.includes('_TEST_PENDING_UPDATE_'))
        );
        if (found) {
            createdPendingId = found.id;
            console.log(`   Found pending #${createdPendingId}`);
        }
    });

    it('2. PUT /api/purchases/pending/:id — update pending item', async () => {
        if (!authToken || !createdPendingId) return;

        const res = await request(API_URL)
            .put(`/api/purchases/pending/${createdPendingId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ precio: 12.00, cantidad: 5 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        console.log(`✅ Updated pending: precio→12€, cantidad→5`);
    });

    it('3. PUT with empty body → 400', async () => {
        if (!authToken || !createdPendingId) return;

        const res = await request(API_URL)
            .put(`/api/purchases/pending/${createdPendingId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Empty update → ${res.status}: ${res.body.error}`);
    });

    it('4. DELETE /api/purchases/pending/:id — reject pending item', async () => {
        if (!authToken || !createdPendingId) return;

        const res = await request(API_URL)
            .delete(`/api/purchases/pending/${createdPendingId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        console.log(`✅ Pending item rejected`);
        createdPendingId = null;
    });
});
