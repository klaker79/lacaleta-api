/**
 * Unit tests: expandRecipeToBase con opción aplicarRendimiento (2026-05-28).
 *
 * Verifica que el descuento de stock puede descontar la cantidad CRUDA
 * equivalente (cantidad / rendimiento) para que el stock refleje la merma real.
 *
 * Prioridad del rendimiento: línea del escandallo > ingrediente base > 100%.
 * Misma prioridad que usa el food cost → ambos cuadran.
 *
 * Fast-path: mock del client de pg (solo se usa para subrecetas).
 */

const { expandRecipeToBase } = require('../../src/utils/businessHelpers');

// Client mock: para subrecetas devuelve la fila configurada; si no, vacío.
function makeMockClient(subrecetasById = {}) {
    return {
        async query(sql, params) {
            const id = params?.[0];
            if (subrecetasById[id]) return { rows: [subrecetasById[id]] };
            return { rows: [] };
        }
    };
}

const RID = 3;

describe('expandRecipeToBase — comportamiento histórico (sin rendimiento)', () => {
    it('sin opts → cantidad servida tal cual (retrocompatible)', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.25 }]
        };
        const res = await expandRecipeToBase(receta, makeMockClient(), RID);
        expect(res).toEqual([{ ingredienteId: 32, cantidadPorPorcion: 0.25 }]);
    });

    it('aplicarRendimiento=false explícito → idéntico a histórico', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.25, rendimiento: 60 }]
        };
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, { aplicarRendimiento: false });
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.25, 6);
    });

    it('divide por porciones correctamente', async () => {
        const receta = {
            id: 1, porciones: 4,
            ingredientes: [{ ingredienteId: 10, cantidad: 1.0 }]
        };
        const res = await expandRecipeToBase(receta, makeMockClient(), RID);
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.25, 6);
    });
});

describe('expandRecipeToBase — con aplicarRendimiento (cantidad cruda)', () => {
    it('rendimiento en la LÍNEA del escandallo: pulpo 0.25 kg @ 60% → 0.4167 kg crudo', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.25, rendimiento: 60 }]
        };
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, { aplicarRendimiento: true });
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.25 / 0.60, 6); // 0.41667
    });

    it('rendimiento del INGREDIENTE base (línea sin rendimiento) vía map', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.25 }] // sin rendimiento en línea
        };
        const map = new Map([[32, 60]]); // pulpo 60% configurado en el ingrediente
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, {
            aplicarRendimiento: true,
            rendimientoIngredientesMap: map
        });
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.25 / 0.60, 6);
    });

    it('línea SOBRESCRIBE al ingrediente (cabeza de pulpo aprovechada → 80%)', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.25, rendimiento: 80 }]
        };
        const map = new Map([[32, 60]]); // ingrediente dice 60, pero la línea dice 80
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, {
            aplicarRendimiento: true,
            rendimientoIngredientesMap: map
        });
        // Debe usar 80 (línea), no 60 (ingrediente)
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.25 / 0.80, 6);
    });

    it('sin rendimiento en línea ni en map → 100% (sin cambio)', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 99, cantidad: 0.30 }]
        };
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, {
            aplicarRendimiento: true,
            rendimientoIngredientesMap: new Map()
        });
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.30, 6);
    });

    it('rendimiento 100% → no infla (cantidad servida = cruda)', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.20, rendimiento: 100 }]
        };
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, { aplicarRendimiento: true });
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.20, 6);
    });

    it('varios ingredientes, cada uno con su rendimiento', async () => {
        const receta = {
            id: 1, porciones: 1,
            ingredientes: [
                { ingredienteId: 32, cantidad: 0.25, rendimiento: 60 },  // pulpo
                { ingredienteId: 45, cantidad: 0.20, rendimiento: 100 }, // berberecho 100%
                { ingredienteId: 99, cantidad: 0.10 }                    // sin rend → map
            ]
        };
        const map = new Map([[99, 50]]); // este al 50%
        const res = await expandRecipeToBase(receta, makeMockClient(), RID, {
            aplicarRendimiento: true,
            rendimientoIngredientesMap: map
        });
        const byId = Object.fromEntries(res.map(r => [r.ingredienteId, r.cantidadPorPorcion]));
        expect(byId[32]).toBeCloseTo(0.25 / 0.60, 6);
        expect(byId[45]).toBeCloseTo(0.20, 6);
        expect(byId[99]).toBeCloseTo(0.10 / 0.50, 6);
    });
});

describe('expandRecipeToBase — subrecetas con rendimiento', () => {
    it('subreceta propaga aplicarRendimiento a sus ingredientes base', async () => {
        // Receta padre usa 1 unidad de subreceta (id 100001 → subreceta 1).
        // Subreceta: 1 porción, usa pulpo 0.25 kg @ 60%.
        const subreceta = {
            id: 1, porciones: 1,
            ingredientes: [{ ingredienteId: 32, cantidad: 0.25, rendimiento: 60 }]
        };
        const recetaPadre = {
            id: 2, porciones: 1,
            ingredientes: [{ ingredienteId: 100001, cantidad: 1 }]
        };
        const client = makeMockClient({ 1: subreceta });
        const res = await expandRecipeToBase(recetaPadre, client, RID, { aplicarRendimiento: true });
        // El pulpo de la subreceta debe venir en cantidad cruda
        expect(res[0].ingredienteId).toBe(32);
        expect(res[0].cantidadPorPorcion).toBeCloseTo(0.25 / 0.60, 6);
    });
});
