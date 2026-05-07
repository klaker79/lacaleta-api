/**
 * ═══════════════════════════════════════════════════
 * 🛡️ POST /sales single → ventas_diarias_resumen
 * ═══════════════════════════════════════════════════
 * Test de regresión del fix #184 (2026-05-05) "venta single también
 * actualiza ventas_diarias_resumen".
 *
 * Antes del fix, solo POST /sales/bulk (importación masiva) actualizaba
 * la tabla agregada. POST /sales single (botón "+ Nueva Venta") sólo
 * insertaba en `ventas` y descontaba stock, dejando ventas_diarias_resumen
 * sin la fila → Food Cost del Dashboard, P&L y rankings de menú vacíos
 * para tenants que registran ventas una a una.
 *
 * Este test verifica que tras POST /sales single, GET /api/daily/sales
 * devuelve la venta agregada en la fecha indicada.
 *
 * Uso fecha futura (2099-12-31) para no contaminar el resumen real del
 * tenant de test. Cleanup vía DELETE /api/sales/:id en afterAll.
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';

describe('POST /sales single — actualiza ventas_diarias_resumen', () => {
    let authToken;
    let recetaId;
    let ventaIdCreada;
    const fechaTest = '2099-12-31';

    beforeAll(async () => {
        authToken = await global.getAuthToken();
        if (!authToken) return;

        // Buscar una receta FOOD activa con porciones >=1 para usar en la venta.
        // Tomamos la primera disponible — el test no depende de una concreta.
        const recetasRes = await request(API_URL)
            .get('/api/recipes')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        if (recetasRes.status !== 200 || !Array.isArray(recetasRes.body)) return;

        const recetaFood = recetasRes.body.find(r => {
            const cat = (r.categoria || '').toLowerCase().trim();
            const esNoFood = ['bebida', 'bebidas', 'base', 'preparacion base', 'suministro', 'suministros'].includes(cat);
            return !esNoFood && parseFloat(r.precio_venta) > 0 && parseInt(r.porciones) >= 1;
        });

        if (recetaFood) recetaId = recetaFood.id;
    });

    afterAll(async () => {
        // Cleanup: borrar la venta de test si se creó, para no dejar basura.
        if (ventaIdCreada && authToken) {
            await request(API_URL)
                .delete(`/api/sales/${ventaIdCreada}`)
                .set('Origin', 'http://localhost:3001')
                .set('Authorization', `Bearer ${authToken}`)
                .catch(() => { });
        }
    });

    it('1. Tras POST /sales, la venta aparece en GET /api/daily/sales del día', async () => {
        if (!authToken || !recetaId) {
            console.log('⏭️ Skip: sin auth o sin receta FOOD disponible en el tenant');
            return;
        }

        // Estado inicial: cuántas ventas hay en la fecha de test antes de empezar.
        // Debe ser 0 si la fecha es futura y no hubo tests previos sin cleanup.
        const beforeRes = await request(API_URL)
            .get(`/api/daily/sales?fecha=${fechaTest}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        const cantidadAntesEnFecha = (beforeRes.body || [])
            .filter(r => r.receta_id === recetaId)
            .reduce((sum, r) => sum + (parseFloat(r.cantidad_vendida) || 0), 0);

        // POST /sales — venta single, cantidad 1, en fecha futura.
        const postRes = await request(API_URL)
            .post('/api/sales')
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                receta_id: recetaId,
                cantidad: 1,
                fecha: fechaTest,
            });

        expect(postRes.status).toBe(201);
        expect(postRes.body.id).toBeDefined();
        ventaIdCreada = postRes.body.id;

        // Verificación: ventas_diarias_resumen para esa receta en esa fecha
        // debe tener exactamente 1 unidad MÁS que antes.
        const afterRes = await request(API_URL)
            .get(`/api/daily/sales?fecha=${fechaTest}`)
            .set('Origin', 'http://localhost:3001')
            .set('Authorization', `Bearer ${authToken}`);

        expect(afterRes.status).toBe(200);
        const cantidadDespuesEnFecha = (afterRes.body || [])
            .filter(r => r.receta_id === recetaId)
            .reduce((sum, r) => sum + (parseFloat(r.cantidad_vendida) || 0), 0);

        const delta = cantidadDespuesEnFecha - cantidadAntesEnFecha;
        expect(delta).toBeCloseTo(1, 5);

        console.log(`✅ POST /sales single propagó +1 unidad a ventas_diarias_resumen (${cantidadAntesEnFecha} → ${cantidadDespuesEnFecha})`);
    });
});
