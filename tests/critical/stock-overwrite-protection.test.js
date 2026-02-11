/**
 * ============================================
 * tests/critical/stock-overwrite-protection.test.js
 * ============================================
 *
 * ⚡ CRITICAL: Este test habría detectado el bug del Pulpo.
 *
 * Verifica que:
 * 1. PUT /api/ingredients/:id SIN stock_actual → preserva stock existente
 * 2. PUT /api/ingredients/:id CON stock_actual → cambia stock (para inventario)
 * 3. Editar proveedor/nombre/familia → stock NO cambia
 * 4. adjust-stock seguido de PUT parcial → stock atómico NO se revierte
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('Stock Overwrite Protection — PUT /api/ingredients/:id', () => {
    let authToken;
    let testIngredientId;
    let testIngredientName;
    let originalData;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        // Get a test ingredient and save ALL original data for restoration
        const res = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (res.status === 200 && res.body.length > 0) {
            const ing = res.body[res.body.length - 1];
            testIngredientId = ing.id;
            testIngredientName = ing.nombre;
            originalData = {
                nombre: ing.nombre,
                proveedor_id: ing.proveedor_id,
                precio: ing.precio,
                unidad: ing.unidad,
                stock_actual: parseFloat(ing.stock_actual) || 0,
                stock_minimo: parseFloat(ing.stock_minimo) || 0,
                familia: ing.familia
            };
            console.log(`📦 Test ingredient: ${testIngredientName} (ID: ${testIngredientId}), stock: ${originalData.stock_actual}`);
        }
    });

    afterAll(async () => {
        // Restore original data
        if (authToken && testIngredientId && originalData) {
            await request(API_URL)
                .put(`/api/ingredients/${testIngredientId}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .send(originalData);
            console.log(`🧹 Restored ${testIngredientName} to original state`);
        }
    });

    it('1. ⚡ CRITICAL: PUT without stock_actual should PRESERVE existing stock', async () => {
        if (!authToken || !testIngredientId) return;

        const stockBefore = originalData.stock_actual;

        // Update ONLY the name — no stock_actual field sent
        const res = await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: originalData.nombre + ' _TEST_'
            });

        expect(res.status).toBe(200);
        const stockAfter = parseFloat(res.body.stock_actual) || 0;

        console.log(`📊 PUT sin stock_actual: stock antes=${stockBefore}, después=${stockAfter}`);
        expect(stockAfter).toBeCloseTo(stockBefore, 1);

        // Restore name
        await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ nombre: originalData.nombre });
    });

    it('2. PUT WITH explicit stock_actual should update it', async () => {
        if (!authToken || !testIngredientId) return;

        const newStock = 777.77;
        const res = await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                stock_actual: newStock
            });

        expect(res.status).toBe(200);
        const stockAfter = parseFloat(res.body.stock_actual) || 0;
        expect(stockAfter).toBeCloseTo(newStock, 1);
        console.log(`📊 PUT con stock_actual=${newStock}: resultado=${stockAfter}`);

        // Restore stock
        await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ stock_actual: originalData.stock_actual });
    });

    it('3. PUT updating familia should NOT touch stock', async () => {
        if (!authToken || !testIngredientId) return;

        // Read current stock (may differ from originalData due to test 2)
        const beforeRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const stockBefore = parseFloat(beforeRes.body.find(i => i.id === testIngredientId)?.stock_actual) || 0;

        const res = await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                familia: 'bebida'
            });

        expect(res.status).toBe(200);
        const stockAfter = parseFloat(res.body.stock_actual) || 0;
        expect(stockAfter).toBeCloseTo(stockBefore, 1);
        console.log(`📊 PUT familia change: stock antes=${stockBefore}, después=${stockAfter}`);

        // Restore familia
        await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ familia: originalData.familia });
    });

    it('4. PUT updating proveedor should NOT touch stock', async () => {
        if (!authToken || !testIngredientId) return;

        // Read current stock
        const beforeRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        const stockBefore = parseFloat(beforeRes.body.find(i => i.id === testIngredientId)?.stock_actual) || 0;

        const res = await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                proveedor_id: originalData.proveedor_id
            });

        expect(res.status).toBe(200);
        const stockAfter = parseFloat(res.body.stock_actual) || 0;
        expect(stockAfter).toBeCloseTo(stockBefore, 1);
        console.log(`📊 PUT proveedor change: stock antes=${stockBefore}, después=${stockAfter}`);
    });

    it('5. ⚡ RACE CONDITION: adjust-stock then PUT partial → stock should NOT revert', async () => {
        if (!authToken || !testIngredientId) return;

        // Step 1: Record current stock
        const getRes = await request(API_URL)
            .get('/api/ingredients')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const currentIng = getRes.body.find(i => i.id === testIngredientId);
        const stockBefore = parseFloat(currentIng.stock_actual) || 0;

        // Step 2: Atomic adjustment +50
        const adjustRes = await request(API_URL)
            .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ delta: 50, reason: 'test_race_condition' });

        expect(adjustRes.status).toBe(200);
        const stockAfterAdjust = adjustRes.body.stock_actual;
        expect(stockAfterAdjust).toBeCloseTo(stockBefore + 50, 1);
        console.log(`📊 After adjust +50: ${stockBefore} → ${stockAfterAdjust}`);

        // Step 3: PUT with ONLY nombre (simulates a frontend edit that reads stale data)
        // This is EXACTLY what caused the Pulpo bug
        const putRes = await request(API_URL)
            .put(`/api/ingredients/${testIngredientId}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: originalData.nombre  // Only name, no stock_actual
            });

        expect(putRes.status).toBe(200);
        const stockAfterPut = parseFloat(putRes.body.stock_actual) || 0;

        console.log(`📊 After PUT sin stock: ${stockAfterAdjust} → ${stockAfterPut}`);
        // ⚡ THE KEY ASSERTION: stock should STILL be the adjusted value, NOT the original
        expect(stockAfterPut).toBeCloseTo(stockAfterAdjust, 1);

        // Restore
        await request(API_URL)
            .post(`/api/ingredients/${testIngredientId}/adjust-stock`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ delta: -50, reason: 'test_race_restore' });
    });
});
