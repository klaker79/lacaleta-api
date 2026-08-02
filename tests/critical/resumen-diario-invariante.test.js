/**
 * ═══════════════════════════════════════════════════════════════
 * 🛡️ GUARDIÁN: coherencia interna de ventas_diarias_resumen
 * ═══════════════════════════════════════════════════════════════
 * Bug detectado en PRODUCCIÓN el 2026-08-02 (La Nave 5, rid=3):
 * el 25% de las filas de `ventas_diarias_resumen` cumplían
 *     total_ingresos != cantidad_vendida * precio_venta_unitario
 *
 * CAUSA: en POST /sales/bulk (importación del TPV vía n8n) se guardaban
 * DOS FUENTES DISTINTAS sin validarlas entre sí:
 *   - precio_venta_unitario  ← recetas.precio_venta (catálogo de la app)
 *   - total_ingresos         ← venta.total (importe REAL del ticket)
 * Ejemplo real: AMEIXAS ficha 19,00 / cobrado 18,00 todos los días.
 *
 * FIX: precio_venta_unitario pasa a ser el precio REALIZADO
 * (total_ingresos / cantidad_vendida), en INSERT, ON CONFLICT y DELETE.
 *
 * ⚠️ ESTE TEST SE CREA SUS PROPIOS DATOS (ingrediente + receta).
 * En CI el tenant nace VACÍO: si el test dependiera de que existan recetas,
 * se saltaría y quedaría en verde sin haber probado nada — que es
 * exactamente lo que pasó en su primera versión (2026-08-02). Por eso aquí
 * el setup FALLA RUIDOSAMENTE si no puede montar sus datos.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

// DECIMAL(10,2): el precio se redondea a 2 decimales, así que la invariante
// se cumple con una tolerancia de medio céntimo por unidad vendida.
const toleranciaPara = (unidades) => Math.max(0.01, unidades * 0.005 + 0.01);

const sufijo = Date.now();

describe('🛡️ ventas_diarias_resumen — invariantes de coherencia', () => {
    let authToken;
    let ingredienteId;
    let recetaId;
    let setupError = null;
    const ventasCreadas = [];
    const fechaTest = '2099-12-30';

    // PVP de catálogo deliberadamente DISTINTO del coste, para que la fila
    // tenga precio e ingresos que puedan divergir si el fix se revierte.
    const PVP_CATALOGO = 20;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) { setupError = 'no se pudo obtener token de auth'; return; }

        const ingRes = await request(API_URL)
            .post('/api/ingredients')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `_TEST_INVARIANTE_ING_${sufijo}`,
                unidad: 'kg',
                precio: 4,
                stock_actual: 1000,
                stock_minimo: 0,
                categoria: 'test'
            });

        if (![200, 201].includes(ingRes.status) || !ingRes.body?.id) {
            setupError = `no se pudo crear el ingrediente (status ${ingRes.status})`;
            return;
        }
        ingredienteId = ingRes.body.id;

        const recRes = await request(API_URL)
            .post('/api/recipes')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                nombre: `_TEST_INVARIANTE_REC_${sufijo}`,
                categoria: 'alimentos',
                precio_venta: PVP_CATALOGO,
                porciones: 1,
                ingredientes: [{ ingredienteId, cantidad: 0.5 }]
            });

        if (recRes.status !== 201 || !recRes.body?.id) {
            setupError = `no se pudo crear la receta (status ${recRes.status})`;
            return;
        }
        recetaId = recRes.body.id;
    });

    afterAll(async () => {
        if (!authToken) return;
        for (const id of ventasCreadas) {
            await request(API_URL).delete(`/api/sales/${id}`)
                .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`).catch(() => { });
        }
        if (recetaId) {
            await request(API_URL).delete(`/api/recipes/${recetaId}`)
                .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`).catch(() => { });
        }
        if (ingredienteId) {
            await request(API_URL).delete(`/api/ingredients/${ingredienteId}`)
                .set('Origin', ORIGIN).set('Authorization', `Bearer ${authToken}`).catch(() => { });
        }
    });

    const leerFila = async () => {
        const res = await request(API_URL)
            .get(`/api/daily/sales?fecha=${fechaTest}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);
        if (res.status !== 200 || !Array.isArray(res.body)) return null;
        return res.body.find(r => r.receta_id === recetaId) || null;
    };

    it('0. El setup montó sus propios datos (si esto falla, los demás no prueban nada)', () => {
        // Deliberadamente NO es un skip: un guardián que se salta en silencio
        // es peor que no tener guardián, porque da falsa confianza.
        expect(setupError).toBeNull();
        expect(recetaId).toBeDefined();
        console.log(`✅ Setup: receta ${recetaId} con ingrediente ${ingredienteId}`);
    });

    it('1. Tras la primera venta, total_ingresos == cantidad_vendida × precio_venta_unitario', async () => {
        expect(setupError).toBeNull();

        const postRes = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ receta_id: recetaId, cantidad: 4, fecha: fechaTest });

        expect(postRes.status).toBe(201);
        ventasCreadas.push(postRes.body.id);

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const qty = parseFloat(fila.cantidad_vendida);
        const ing = parseFloat(fila.total_ingresos);
        const pvu = parseFloat(fila.precio_venta_unitario);

        expect(qty).toBe(4);
        expect(Math.abs(qty * pvu - ing)).toBeLessThanOrEqual(toleranciaPara(qty));
        console.log(`✅ ${qty} uds × ${pvu} € ≈ ${ing} €`);
    });

    it('2. Tras acumular una segunda venta el mismo día, la invariante se mantiene', async () => {
        expect(setupError).toBeNull();

        const postRes = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ receta_id: recetaId, cantidad: 3, fecha: fechaTest });

        expect(postRes.status).toBe(201);
        ventasCreadas.push(postRes.body.id);

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const qty = parseFloat(fila.cantidad_vendida);
        const ing = parseFloat(fila.total_ingresos);
        const pvu = parseFloat(fila.precio_venta_unitario);

        // El ON CONFLICT DO UPDATE debe RECALCULAR el precio, no dejarlo
        // congelado con el de la primera venta del día.
        expect(qty).toBe(7);
        expect(Math.abs(qty * pvu - ing)).toBeLessThanOrEqual(toleranciaPara(qty));
        console.log(`✅ Tras acumular: ${qty} uds × ${pvu} € ≈ ${ing} €`);
    });

    it('3. beneficio_bruto siempre es total_ingresos − coste_ingredientes', async () => {
        expect(setupError).toBeNull();

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const ing = parseFloat(fila.total_ingresos);
        const coste = parseFloat(fila.coste_ingredientes);
        const benef = parseFloat(fila.beneficio_bruto);

        expect(coste).toBeGreaterThan(0); // la receta tiene ingrediente con precio
        expect(benef).toBeCloseTo(ing - coste, 2);
        console.log(`✅ ${ing} − ${coste} = ${benef}`);
    });

    it('4. Tras BORRAR una venta, la fila sigue siendo coherente', async () => {
        expect(setupError).toBeNull();
        expect(ventasCreadas.length).toBeGreaterThan(0);

        const idABorrar = ventasCreadas.shift();
        const delRes = await request(API_URL)
            .delete(`/api/sales/${idABorrar}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(delRes.status);

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const qty = parseFloat(fila.cantidad_vendida);
        const ing = parseFloat(fila.total_ingresos);
        const pvu = parseFloat(fila.precio_venta_unitario);
        const coste = parseFloat(fila.coste_ingredientes);
        const benef = parseFloat(fila.beneficio_bruto);

        // Quedan las 3 unidades de la segunda venta.
        expect(qty).toBe(3);
        expect(Math.abs(qty * pvu - ing)).toBeLessThanOrEqual(toleranciaPara(qty));

        // El DELETE clampaba beneficio_bruto con GREATEST(0,...) sobre valores
        // SIN acotar, dejando la fila incoherente en días con pérdida.
        expect(benef).toBeCloseTo(ing - coste, 2);

        expect(ing).toBeGreaterThanOrEqual(0);
        expect(coste).toBeGreaterThanOrEqual(0);
        console.log(`✅ Tras borrado: ${qty} uds, ${ing} € ingresos, ${coste} € coste, ${benef} € beneficio`);
    });
});
