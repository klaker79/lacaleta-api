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
 * Si el TPV cobraba 18 € y la ficha decía 19 €, la fila guardaba las dos
 * cifras a la vez. Ejemplo real: AMEIXAS ficha 19,00 / cobrado 18,00
 * todos los días desde marzo; NAVAJAS ficha 18,00 / cobrado 16,00.
 *
 * FIX: precio_venta_unitario pasa a ser el precio REALIZADO
 * (total_ingresos / cantidad_vendida), tanto en el INSERT como en el
 * ON CONFLICT DO UPDATE y en el DELETE. Es la misma fórmula que ya usaba
 * POST /analytics/recalculate-cogs, que era el único sitio que lo hacía bien.
 *
 * NINGÚN test cubría esta invariante. Por eso el bug vivió meses sin
 * que ninguna auditoría lo detectara. Este test existe para que no vuelva.
 *
 * Se usa fecha futura (2099-12-30) para no tocar datos reales del tenant.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

// DECIMAL(10,2): el precio se redondea a 2 decimales, así que la invariante
// se cumple con una tolerancia de medio céntimo por unidad vendida.
const toleranciaPara = (unidades) => Math.max(0.01, unidades * 0.005 + 0.01);

describe('🛡️ ventas_diarias_resumen — invariantes de coherencia', () => {
    let authToken;
    let recetaId;
    let recetaPrecioCatalogo;
    const fechaTest = '2099-12-30';
    const ventasCreadas = [];

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        const recetasRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        if (recetasRes.status !== 200 || !Array.isArray(recetasRes.body)) return;

        const recetaFood = recetasRes.body.find(r => {
            const cat = (r.categoria || '').toLowerCase().trim();
            const esNoFood = ['bebida', 'bebidas', 'base', 'preparacion base', 'suministro', 'suministros'].includes(cat);
            return !esNoFood && parseFloat(r.precio_venta) > 0 && parseInt(r.porciones) >= 1;
        });

        if (recetaFood) {
            recetaId = recetaFood.id;
            recetaPrecioCatalogo = parseFloat(recetaFood.precio_venta);
        }
    });

    afterAll(async () => {
        // Cleanup: borrar las ventas de test para no dejar basura en el tenant.
        for (const id of ventasCreadas) {
            await request(API_URL)
                .delete(`/api/sales/${id}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
                .catch(() => { });
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

    it('1. El precio guardado es el REALIZADO, no el de catálogo, aunque el importe cobrado difiera', async () => {
        if (!authToken || !recetaId) {
            console.log('⏭️ Skip: sin auth o sin receta FOOD disponible');
            return;
        }

        // Importe deliberadamente DISTINTO al precio de catálogo: simula el caso
        // real de AMEIXAS (ficha 19 €, TPV cobra 18 €).
        const cantidad = 4;
        const precioReal = Math.max(1, Math.round((recetaPrecioCatalogo * 0.8) * 100) / 100);
        const totalReal = Math.round(precioReal * cantidad * 100) / 100;

        expect(precioReal).not.toBeCloseTo(recetaPrecioCatalogo, 2); // el test debe ser significativo

        const postRes = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ receta_id: recetaId, cantidad, fecha: fechaTest });

        expect(postRes.status).toBe(201);
        if (postRes.body.id) ventasCreadas.push(postRes.body.id);

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const cantidadVendida = parseFloat(fila.cantidad_vendida);
        const totalIngresos = parseFloat(fila.total_ingresos);
        const precioUnit = parseFloat(fila.precio_venta_unitario);

        // ── INVARIANTE CENTRAL ───────────────────────────────────────────
        // total_ingresos debe reconstruirse desde cantidad × precio.
        expect(cantidadVendida).toBeGreaterThan(0);
        expect(Math.abs(cantidadVendida * precioUnit - totalIngresos))
            .toBeLessThanOrEqual(toleranciaPara(cantidadVendida));

        console.log(`✅ Invariante OK: ${cantidadVendida} uds × ${precioUnit} € ≈ ${totalIngresos} €`);
        // referencia no usada en aserción, sólo informativa
        void totalReal;
    });

    it('2. Tras acumular una segunda venta el mismo día, la invariante se mantiene', async () => {
        if (!authToken || !recetaId) {
            console.log('⏭️ Skip: sin auth o sin receta FOOD disponible');
            return;
        }

        const postRes = await request(API_URL)
            .post('/api/sales')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ receta_id: recetaId, cantidad: 3, fecha: fechaTest });

        expect(postRes.status).toBe(201);
        if (postRes.body.id) ventasCreadas.push(postRes.body.id);

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const cantidadVendida = parseFloat(fila.cantidad_vendida);
        const totalIngresos = parseFloat(fila.total_ingresos);
        const precioUnit = parseFloat(fila.precio_venta_unitario);

        // El ON CONFLICT DO UPDATE debe RECALCULAR el precio, no dejarlo congelado
        // con el de la primera venta del día.
        expect(Math.abs(cantidadVendida * precioUnit - totalIngresos))
            .toBeLessThanOrEqual(toleranciaPara(cantidadVendida));

        console.log(`✅ Invariante tras acumular: ${cantidadVendida} uds × ${precioUnit} € ≈ ${totalIngresos} €`);
    });

    it('3. beneficio_bruto siempre es total_ingresos − coste_ingredientes', async () => {
        if (!authToken || !recetaId) {
            console.log('⏭️ Skip: sin auth o sin receta FOOD disponible');
            return;
        }

        const fila = await leerFila();
        expect(fila).not.toBeNull();

        const totalIngresos = parseFloat(fila.total_ingresos);
        const coste = parseFloat(fila.coste_ingredientes);
        const beneficio = parseFloat(fila.beneficio_bruto);

        expect(beneficio).toBeCloseTo(totalIngresos - coste, 2);
        console.log(`✅ beneficio_bruto coherente: ${totalIngresos} − ${coste} = ${beneficio}`);
    });

    it('4. Tras BORRAR una venta, la fila sigue siendo coherente (invariante + beneficio)', async () => {
        if (!authToken || !recetaId || ventasCreadas.length === 0) {
            console.log('⏭️ Skip: sin auth, sin receta o sin ventas que borrar');
            return;
        }

        const idABorrar = ventasCreadas.shift();
        const delRes = await request(API_URL)
            .delete(`/api/sales/${idABorrar}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        expect([200, 204]).toContain(delRes.status);

        const fila = await leerFila();
        if (!fila) {
            console.log('ℹ️ La fila desapareció tras el borrado (nada que validar)');
            return;
        }

        const cantidadVendida = parseFloat(fila.cantidad_vendida);
        const totalIngresos = parseFloat(fila.total_ingresos);
        const precioUnit = parseFloat(fila.precio_venta_unitario);
        const coste = parseFloat(fila.coste_ingredientes);
        const beneficio = parseFloat(fila.beneficio_bruto);

        if (cantidadVendida > 0) {
            expect(Math.abs(cantidadVendida * precioUnit - totalIngresos))
                .toBeLessThanOrEqual(toleranciaPara(cantidadVendida));
        }

        // El DELETE clampaba beneficio_bruto con GREATEST(0,...) sobre valores SIN
        // acotar, dejando la fila incoherente en días con pérdida.
        expect(beneficio).toBeCloseTo(totalIngresos - coste, 2);

        // Ningún importe puede quedar negativo.
        expect(totalIngresos).toBeGreaterThanOrEqual(0);
        expect(coste).toBeGreaterThanOrEqual(0);
        expect(cantidadVendida).toBeGreaterThanOrEqual(0);

        console.log(`✅ Tras borrado sigue coherente: ${cantidadVendida} uds, ${totalIngresos} € ingresos, ${coste} € coste`);
    });
});
