/**
 * ============================================
 * tests/critical/supplier-ingredient-sync.test.js
 * ============================================
 *
 * REGRESSION TEST: Verifica que al crear/borrar una asociación
 * ingrediente-proveedor, la lista de ingredientes del proveedor
 * se sincroniza correctamente en GET /api/suppliers.
 *
 * Bug original: La columna `ingredientes` de la tabla `proveedores`
 * no se actualizaba al modificar `ingredientes_proveedores`.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Supplier-Ingredient Sync — Association CRUD updates supplier list', () => {
    let authToken;
    let testIngredientId;
    let testIngredientName;
    let testSupplierId;
    let testSupplierName;
    let originalSupplierIngredients;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        // Get a test ingredient
        const ingRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (ingRes.status === 200 && ingRes.body.length > 0) {
            testIngredientId = ingRes.body[0].id;
            testIngredientName = ingRes.body[0].nombre;
            console.log(`📦 Test ingredient: ${testIngredientName} (ID: ${testIngredientId})`);
        }

        // Get a test supplier that does NOT have this ingredient
        const supRes = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (supRes.status === 200 && supRes.body.length > 0) {
            // Find a supplier that does NOT already have the test ingredient
            const supplier = supRes.body.find(s =>
                !s.ingredientes || !s.ingredientes.includes(testIngredientId)
            ) || supRes.body[supRes.body.length - 1]; // fallback to last supplier

            testSupplierId = supplier.id;
            testSupplierName = supplier.nombre;
            originalSupplierIngredients = supplier.ingredientes || [];
            console.log(`🏪 Test supplier: ${testSupplierName} (ID: ${testSupplierId})`);
            console.log(`   Original ingredients: [${originalSupplierIngredients.join(', ')}]`);
        }
    });

    it('1. Create association — supplier should list the ingredient', async () => {
        if (!authToken || !testIngredientId || !testSupplierId) return;

        // Create association
        const createRes = await request(API_URL)
            .post(`/api/ingredients/${testIngredientId}/suppliers`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedor_id: testSupplierId,
                precio: 1.00,
                es_proveedor_principal: false
            });

        expect([200, 201]).toContain(createRes.status);
        console.log(`✅ Association created: ingredient ${testIngredientId} → supplier ${testSupplierId}`);

        // Verify: GET /api/suppliers should now include this ingredient
        const supRes = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(supRes.status).toBe(200);

        const supplier = supRes.body.find(s => s.id === testSupplierId);
        expect(supplier).toBeDefined();
        expect(supplier.ingredientes).toContain(testIngredientId);
        console.log(`📋 Supplier ingredients after create: [${supplier.ingredientes.join(', ')}]`);
    });

    it('2. ⚡ CRITICAL: Delete association — supplier should NOT list the ingredient', async () => {
        if (!authToken || !testIngredientId || !testSupplierId) return;

        // Delete association
        const deleteRes = await request(API_URL)
            .delete(`/api/ingredients/${testIngredientId}/suppliers/${testSupplierId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(deleteRes.status);
        console.log(`🗑️ Association deleted: ingredient ${testIngredientId} ✕ supplier ${testSupplierId}`);

        // Verify: GET /api/suppliers should NOT include this ingredient anymore
        const supRes = await request(API_URL)
            .get('/api/suppliers')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(supRes.status).toBe(200);

        const supplier = supRes.body.find(s => s.id === testSupplierId);
        expect(supplier).toBeDefined();
        expect(supplier.ingredientes).not.toContain(testIngredientId);
        console.log(`📋 Supplier ingredients after delete: [${supplier.ingredientes.join(', ')}]`);
    });

    afterAll(async () => {
        // Safety cleanup: remove association if test 2 didn't run
        if (authToken && testIngredientId && testSupplierId) {
            try {
                await request(API_URL)
                    .delete(`/api/ingredients/${testIngredientId}/suppliers/${testSupplierId}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            } catch (e) {
                // Ignore — may already be deleted
            }
        }
    });
});
