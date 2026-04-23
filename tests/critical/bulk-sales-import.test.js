/**
 * ============================================
 * tests/critical/bulk-sales-import.test.js
 * ============================================
 *
 * Verifica la importación masiva de ventas (flujo n8n TPV/OCR).
 * Tests: formato inválido, código TPV no encontrado, y dedup por fecha.
 *
 * @author MindLoopIA
 * @date 2026-02-11
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('POST /api/sales/bulk — TPV bulk import (n8n path)', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('1. Invalid format (no ventas array) → 400', async () => {
        if (!authToken) return;

        const res = await request(API_URL)
            .post('/api/sales/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ datos: 'invalido' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
        console.log(`✅ Invalid format rejected: ${res.body.error}`);
    });

    it('2. Unknown codigo_tpv → processed with fallidos count', async () => {
        if (!authToken) return;

        // Use a far-future date to avoid conflict with real data
        const futureDate = '2099-12-31';

        const res = await request(API_URL)
            .post('/api/sales/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                ventas: [{
                    codigo_tpv: '99999',
                    receta: 'PLATO_INEXISTENTE_TEST',
                    cantidad: 1,
                    total: 10.00,
                    fecha: futureDate
                }]
            });

        // Should succeed (200) but report the unmatched item as fallido
        expect([200, 201]).toContain(res.status);
        expect(res.body.fallidos).toBeGreaterThanOrEqual(1);
        console.log(`✅ Unknown TPV code: procesados=${res.body.procesados}, fallidos=${res.body.fallidos}`);

        // Cleanup: delete any sales created for the test date
        // (shouldn't be any since the code was invalid, but just in case)
    });

    it('3. Duplicate date import → 409 conflict', async () => {
        if (!authToken) return;

        // First, check if there are existing sales for today
        const today = new Date().toISOString().split('T')[0];
        const salesRes = await request(API_URL)
            .get('/api/sales')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        // If there are sales for today, a second import should be rejected
        if (salesRes.status === 200 && Array.isArray(salesRes.body)) {
            const todaySales = salesRes.body.filter(s =>
                s.fecha && s.fecha.startsWith(today)
            );

            if (todaySales.length > 0) {
                const res = await request(API_URL)
                    .post('/api/sales/bulk')
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({
                        ventas: [{
                            receta: 'Test',
                            cantidad: 1,
                            total: 10.00,
                            fecha: today
                        }]
                    });

                expect(res.status).toBe(409);
                expect(res.body.error).toContain('Ya existen ventas');
                console.log(`✅ Duplicate date rejected: ${res.body.error} (${res.body.ventasExistentes} existing)`);
            } else {
                console.log('⚠️ No existing sales today — cannot test 409 dedup. Verifying endpoint accepts post.');
                // Just verify the endpoint exists and is reachable
                const res = await request(API_URL)
                    .post('/api/sales/bulk')
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`)
                    .send({ ventas: [] });

                // Empty array should still be accepted and processed (0 items)
                expect([200, 400]).toContain(res.status);
            }
        }
    });

    // Fix 2026-04-24: prioridad variante > receta padre cuando codigo_tpv duplicado.
    // Casa comun en La Nave 5: receta padre creada con codigo botella, luego variante
    // BOTELLA identica. Antes del fix: matchee por padre -> variante_id=null. Despues:
    // matchee por variante -> variante_id correcto.
    it('4. Codigo duplicado padre-variante prioriza variante', async () => {
        if (!authToken) return;

        // Buscar en la BD una receta cuyo codigo coincida con el de alguna de sus variantes
        const recipesRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (recipesRes.status !== 200 || !Array.isArray(recipesRes.body)) return;

        let matched = null;
        for (const r of recipesRes.body) {
            if (!r.codigo || r.codigo === '' || r.codigo === 'SIN_TPV') continue;
            const variantsRes = await request(API_URL)
                .get(`/api/recipes/${r.id}/variants`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`);
            if (variantsRes.status !== 200 || !Array.isArray(variantsRes.body)) continue;
            const shared = variantsRes.body.find(v => v.codigo === r.codigo);
            if (shared) {
                matched = { receta: r, variante: shared };
                break;
            }
        }
        if (!matched) {
            console.warn('⚠️ No hay receta con codigo duplicado padre-variante. Test skipped.');
            return;
        }

        const futureDate = '2099-06-15';
        const res = await request(API_URL)
            .post('/api/sales/bulk')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                ventas: [{
                    codigo_tpv: matched.receta.codigo,
                    cantidad: 1,
                    total: parseFloat(matched.variante.precio_venta) || 10,
                    fecha: futureDate,
                }],
            });

        expect([200, 201, 409]).toContain(res.status);
        if (res.status === 409) {
            console.log('⚠️ Fecha futura ocupada — test skipped (caso borde del dedup).');
            return;
        }
        expect(res.body.procesados).toBeGreaterThanOrEqual(1);

        // Verificar que la venta se registro con variante_id (fix aplicado)
        const salesRes = await request(API_URL)
            .get(`/api/sales?fecha=${futureDate}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);
        if (salesRes.status === 200 && Array.isArray(salesRes.body)) {
            const sale = salesRes.body.find(
                s => s.fecha && s.fecha.startsWith(futureDate) && s.receta_id === matched.receta.id
            );
            if (sale) {
                expect(sale.variante_id).toBe(matched.variante.id);
                expect(parseFloat(sale.factor_variante)).toBe(parseFloat(matched.variante.factor));

                // Cleanup
                await request(API_URL)
                    .delete(`/api/sales/${sale.id}`)
                    .set('Origin', 'http://localhost:3001')
                    .set('Authorization', `Bearer ${authToken}`);
            }
        }
    });
});
