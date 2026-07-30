/**
 * ============================================
 * tests/critical/supplier-price-format-unit.test.js
 * ============================================
 *
 * REGRESSION TEST: `ingredientes_proveedores.precio` debe estar SIEMPRE en
 * €/UNIDAD-BASE, nunca en €/FORMATO.
 *
 * Bug original (ARAU, 2026-07-31): al editar un ingrediente con formato de
 * compra, el sync PUT /api/ingredients/:id copiaba `ingredientes.precio`
 * (que es €/FORMATO) tal cual a `ingredientes_proveedores.precio` (que es
 * €/UNIDAD-BASE). El desplegable de "Nuevo pedido" vuelve a multiplicar ese
 * precio por `cantidad_por_formato` para mostrarlo en €/formato, así que el
 * valor salía elevado al cuadrado del formato:
 *
 *     ATUN GIRASOL, LATA de 900 g a 7,58 €
 *     pivot mal    = 7,58        (€/LATA metido en columna €/g)
 *     desplegable  = 7,58 × 900  = 6.822 € por una lata  ❌
 *     pivot bien   = 0,0084      (7,58 / 900 = €/g)
 *     desplegable  = 0,0084 × 900 = 7,58 € por una lata  ✅
 *
 * El contrato lo confirma el propio esquema: la tabla pivot tiene una columna
 * `precio_formato` aparte para el precio del formato.
 *
 * @author MindLoopIA
 * @date 2026-07-31
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

describe('Supplier price unit — pivot guarda €/unidad-base, no €/formato', () => {
    let authToken;
    let supplierId;
    let ingredientId;

    const CPF = 900;            // 900 g por LATA
    const PRECIO_FORMATO = 7.58; // €/LATA
    const PRECIO_BASE_ESPERADO = PRECIO_FORMATO / CPF; // 0.008422... €/g

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) {
            console.warn('⚠️ No se pudo autenticar. Tests skipped.');
            return;
        }

        const supRes = await request(API_URL)
            .post('/api/suppliers')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ nombre: `PROV FORMATO TEST ${Date.now()}` });
        // SupplierController envuelve la respuesta en { success, data } — el
        // ingrediente NO. Desenvolver defensivamente en ambos casos.
        supplierId = (supRes.body?.data || supRes.body || {}).id;

        const ingRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `ATUN FORMATO TEST ${Date.now()}`,
                precio: PRECIO_FORMATO,
                unidad: 'g',
                stock_minimo: 1,
                formato_compra: 'LATA',
                cantidad_por_formato: CPF,
                proveedor_id: supplierId
            });
        ingredientId = (ingRes.body?.data || ingRes.body || {}).id;

        if (!supplierId || !ingredientId) {
            console.warn('⚠️ Setup incompleto', {
                supplierStatus: supRes.status, supplierId,
                ingredientStatus: ingRes.status, ingredientId
            });
        }

        // Vincular como proveedor PRINCIPAL: es la fila que toca el sync del PUT.
        if (ingredientId && supplierId) {
            await request(API_URL)
                .post(`/api/ingredients/${ingredientId}/suppliers`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .send({ proveedor_id: supplierId, es_proveedor_principal: true });
        }
    });

    afterAll(async () => {
        if (!authToken) return;
        if (ingredientId) {
            await request(API_URL)
                .delete(`/api/ingredients/${ingredientId}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
        }
        if (supplierId) {
            await request(API_URL)
                .delete(`/api/suppliers/${supplierId}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`);
        }
    });

    test('editar el precio NO debe copiar €/formato crudo a la pivot', async () => {
        if (!authToken || !ingredientId || !supplierId) {
            console.warn('⚠️ Sin setup (API no disponible). Test skipped.');
            return;
        }

        // Cambiar el precio dispara el sync (solo actúa si el precio varía).
        const nuevoPrecioFormato = 9.9;   // €/LATA
        const nuevoPrecioBase = nuevoPrecioFormato / CPF;

        const putRes = await request(API_URL)
            .put(`/api/ingredients/${ingredientId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `ATUN FORMATO TEST ${ingredientId}`,
                precio: nuevoPrecioFormato,
                unidad: 'g',
                stock_minimo: 1,
                formato_compra: 'LATA',
                cantidad_por_formato: CPF,
                proveedor_id: supplierId
            });
        expect([200, 201]).toContain(putRes.status);

        const relRes = await request(API_URL)
            .get(`/api/ingredients/${ingredientId}/suppliers`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        expect(relRes.status).toBe(200);

        const rel = (relRes.body || []).find(r => r.proveedor_id === supplierId);
        expect(rel).toBeDefined();

        const precioPivot = parseFloat(rel.precio);

        // 1) El valor debe ser el precio POR UNIDAD BASE…
        expect(precioPivot).toBeCloseTo(nuevoPrecioBase, 4);

        // 2) …y explícitamente NO el precio del formato crudo (el bug).
        expect(precioPivot).not.toBeCloseTo(nuevoPrecioFormato, 2);

        // 3) Invariante de negocio: reconstruir el €/formato debe devolver el
        //    precio tecleado, no un múltiplo de él (6.822 € por una lata).
        expect(precioPivot * CPF).toBeCloseTo(nuevoPrecioFormato, 2);
    });

    test('sin formato (cpf <= 1) el precio se propaga tal cual', async () => {
        if (!authToken || !supplierId) {
            console.warn('⚠️ Sin setup. Test skipped.');
            return;
        }

        // Ingrediente SIN formato: €/base y €/formato son lo mismo → idempotente.
        const simpleRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `SIMPLE SIN FORMATO ${Date.now()}`,
                precio: 3.5,
                unidad: 'kg',
                stock_minimo: 1,
                proveedor_id: supplierId
            });
        const simpleId = simpleRes.body?.id;
        if (!simpleId) {
            console.warn('⚠️ No se pudo crear ingrediente simple. Test skipped.');
            return;
        }

        await request(API_URL)
            .post(`/api/ingredients/${simpleId}/suppliers`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ proveedor_id: supplierId, es_proveedor_principal: true });

        await request(API_URL)
            .put(`/api/ingredients/${simpleId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `SIMPLE SIN FORMATO ${simpleId}`,
                precio: 4.25,
                unidad: 'kg',
                stock_minimo: 1,
                proveedor_id: supplierId
            });

        const relRes = await request(API_URL)
            .get(`/api/ingredients/${simpleId}/suppliers`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        const rel = (relRes.body || []).find(r => r.proveedor_id === supplierId);
        expect(rel).toBeDefined();
        expect(parseFloat(rel.precio)).toBeCloseTo(4.25, 2);

        await request(API_URL)
            .delete(`/api/ingredients/${simpleId}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
    });
});
