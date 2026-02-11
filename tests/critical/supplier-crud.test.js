/**
 * ═══════════════════════════════════════════════════
 * 🏢 SUPPLIER CRUD — Full lifecycle
 * ═══════════════════════════════════════════════════
 * Note: SupplierController uses different response shapes:
 * - list() → returns flat array of DTOs
 * - getById() → returns { success, data }
 * - create() → returns { success, data }
 * - update() → returns { success, data }
 * - delete() → returns { success, message }
 *
 * Tests:
 * 1. POST /api/suppliers — creates supplier
 * 2. GET /api/suppliers — lists suppliers (includes new one)
 * 3. GET /api/suppliers/:id — gets single supplier
 * 4. PUT /api/suppliers/:id — updates supplier
 * 5. DELETE /api/suppliers/:id — soft deletes supplier
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Supplier CRUD — Full lifecycle', () => {
    let authToken;
    let createdSupplierId;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    afterAll(async () => {
        if (authToken && createdSupplierId) {
            await request(API_URL)
                .delete(`/api/suppliers/${createdSupplierId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            console.log(`🗑️ Cleaned up supplier ${createdSupplierId}`);
        }
    });

    it('1. POST /api/suppliers — creates supplier', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: '_TEST_PROVEEDOR_' + Date.now(),
                contacto: 'Juan Test',
                telefono: '600123456',
                email: 'test@proveedor.com'
            });

        expect(res.status).toBe(201);
        // SupplierController wraps in { success, data }
        const supplier = res.body.data || res.body;
        expect(supplier.id || supplier.nombre).toBeDefined();

        createdSupplierId = supplier.id;
        console.log(`✅ Created supplier #${createdSupplierId}: ${supplier.nombre || supplier.name}`);
    });

    it('2. GET /api/suppliers — lists suppliers', async () => {
        if (!authToken || !createdSupplierId) return;

        const res = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        // list() returns flat array of DTOs
        const suppliers = Array.isArray(res.body) ? res.body : (res.body.data || []);
        expect(suppliers.length).toBeGreaterThan(0);

        const found = suppliers.find(s => s.id === createdSupplierId);
        expect(found).toBeDefined();
        console.log(`✅ Found supplier in list (${suppliers.length} total)`);
    });

    it('3. GET /api/suppliers/:id — gets single supplier', async () => {
        if (!authToken || !createdSupplierId) return;

        const res = await request(API_URL)
            .get(`/api/suppliers/${createdSupplierId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        const supplier = res.body.data || res.body;
        expect(supplier.id).toBe(createdSupplierId);
        console.log(`✅ Got supplier by ID: ${supplier.nombre || supplier.name}`);
    });

    it('4. PUT /api/suppliers/:id — updates supplier', async () => {
        if (!authToken || !createdSupplierId) return;

        const res = await request(API_URL)
            .put(`/api/suppliers/${createdSupplierId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ nombre: '_TEST_PROVEEDOR_UPDATED_', contacto: 'María Actualizada', telefono: '700999888' });

        expect(res.status).toBe(200);
        const supplier = res.body.data || res.body;
        expect(supplier.contacto).toBe('María Actualizada');
        console.log(`✅ Updated supplier: contacto → ${supplier.contacto}`);
    });

    it('5. DELETE /api/suppliers/:id — deletes supplier', async () => {
        if (!authToken || !createdSupplierId) return;

        const deleteRes = await request(API_URL)
            .delete(`/api/suppliers/${createdSupplierId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(deleteRes.status).toBe(200);

        // Verify not in list anymore
        const listRes = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const suppliers = Array.isArray(listRes.body) ? listRes.body : (listRes.body.data || []);
        const found = suppliers.find(s => s.id === createdSupplierId);
        expect(found).toBeUndefined();
        console.log(`✅ Supplier deleted, not in list`);
        createdSupplierId = null;
    });
});
