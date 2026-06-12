/**
 * 🥇 GOLDEN PARITY — Costes de receta (lado BACKEND).
 *
 * Fixture compartida con el frontend:
 *   MindLoop-CostOS/src/__tests__/utils/golden-parity-costes.test.js
 * ⚠️ SI CAMBIAS UN NÚMERO AQUÍ, CAMBIA EL ESPEJO EN EL OTRO REPO. Los valores
 * esperados están CLAVADOS A MANO: si una fórmula cambia en un solo lado,
 * este test (o su espejo) se pone rojo.
 *
 * Invariantes sellados (auditoría 2026-06-12):
 *  - Prioridad de precio pmc > precio_medio > precio/cpf con semántica > 0.
 *  - Rendimiento: línea > ingrediente base > 100 (coste = precio/(rend/100)).
 *  - Subrecetas (id>100000): coste por porción de la subreceta × cantidad.
 *  - Ciclo corta a 0; diamante SUMA ambos caminos.
 *  - expandRecipeToBase con merma: cantidad cruda = (cantidad/porciones)/(rend/100).
 */

const {
    getBackendIngredientUnitPrice,
    getRecipeCostBase,
    expandRecipeToBase,
} = require('../../src/utils/businessHelpers');

// ===== FIXTURE (espejo exacto del frontend) =====
const SUB_AJADA = {
    id: 50, porciones: 10,
    ingredientes: [{ ingredienteId: 1, cantidad: 2 }], // 2×1.20 = 2.40 lote → 0.24/porción
};
const RECETA_PRINCIPAL = {
    id: 60, porciones: 4,
    ingredientes: [
        { ingredienteId: 2, cantidad: 1 },                     // 17.50/0.60 = 29.1667 (rend base 60)
        { ingredienteId: 3, cantidad: 0.5, rendimiento: 100 }, // 4.00 × 0.5 = 2.00
        { ingredienteId: 100050, cantidad: 2 },                // sub: 0.24 × 2 = 0.48
    ],
    // Lote = 31.6467 → /4 porciones = 7.9117 (FE muestra 7.91 a 2 dec)
};
const RECETA_CICLO = {
    id: 70, porciones: 1,
    ingredientes: [
        { ingredienteId: 1, cantidad: 1 },      // 1.20
        { ingredienteId: 100070, cantidad: 5 }, // se contiene a sí misma → 0
    ],
};
const SUB_PUENTE = { id: 81, porciones: 1, ingredientes: [{ ingredienteId: 100050, cantidad: 1 }] };
const RECETA_DIAMANTE = {
    id: 80, porciones: 1,
    ingredientes: [
        { ingredienteId: 100050, cantidad: 1 }, // AJADA directa: 0.24
        { ingredienteId: 100081, cantidad: 1 }, // AJADA vía puente: 0.24 (NO debe cortar)
    ],
};

const PRECIOS = new Map([[1, 1.20], [2, 17.50], [3, 4.00]]);
const RENDIMIENTO_BASE = new Map([[2, 60]]); // PULPO 60%
const RECETAS = new Map([
    [50, SUB_AJADA], [60, RECETA_PRINCIPAL], [70, RECETA_CICLO],
    [80, RECETA_DIAMANTE], [81, SUB_PUENTE],
]);

// Cliente pg falso para expandRecipeToBase (solo resuelve subrecetas por id)
const fakeClient = {
    query: async (_sql, params) => {
        const sub = RECETAS.get(params[0]);
        return { rows: sub ? [sub] : [] };
    },
};

describe('🥇 Golden parity — getBackendIngredientUnitPrice', () => {
    test('pmc real gana: 17.50', () => {
        expect(getBackendIngredientUnitPrice({ precio_medio_compra: '17.5000', precio: 30, cantidad_por_formato: 2 })).toBeCloseTo(17.50, 4);
    });
    test('pmc "0.0000" cae a precio/cpf: 4.00 (paridad M1 con frontend)', () => {
        expect(getBackendIngredientUnitPrice({ precio_medio_compra: '0.0000', precio_medio: '0.0000', precio: 4, cantidad_por_formato: null })).toBeCloseTo(4.00, 4);
    });
    test('nominal precio/cpf: 30/2 = 15.00', () => {
        expect(getBackendIngredientUnitPrice({ precio: 30, cantidad_por_formato: 2 })).toBeCloseTo(15.00, 4);
    });
    test('pmc negativo se ignora (cae a la cascada): 1.20', () => {
        expect(getBackendIngredientUnitPrice({ precio_medio_compra: '-5', precio: 1.20 })).toBeCloseTo(1.20, 4);
    });
});

describe('🥇 Golden parity — getRecipeCostBase (espejo de calcularCosteRecetaCompleto)', () => {
    test('subreceta AJADA: lote 2.40 → 0.24 €/porción', () => {
        const lote = getRecipeCostBase(SUB_AJADA, PRECIOS, RECETAS, RENDIMIENTO_BASE);
        expect(lote).toBeCloseTo(2.40, 4);
        expect(lote / SUB_AJADA.porciones).toBeCloseTo(0.24, 4);
    });
    test('receta principal: lote 31.6467 → 7.9117 €/porción (FE muestra 7.91)', () => {
        const lote = getRecipeCostBase(RECETA_PRINCIPAL, PRECIOS, RECETAS, RENDIMIENTO_BASE);
        expect(lote).toBeCloseTo(31.6467, 3);
        const porPorcion = lote / RECETA_PRINCIPAL.porciones;
        expect(porPorcion).toBeCloseTo(7.9117, 3);
        // Paridad con el frontend (que redondea a 2 dec): diferencia < 1 céntimo
        expect(Math.abs(porPorcion - 7.91)).toBeLessThan(0.01);
    });
    test('ciclo corta a 0: coste = 1.20', () => {
        expect(getRecipeCostBase(RECETA_CICLO, PRECIOS, RECETAS, RENDIMIENTO_BASE)).toBeCloseTo(1.20, 4);
    });
    test('diamante SUMA ambos caminos: 0.48', () => {
        expect(getRecipeCostBase(RECETA_DIAMANTE, PRECIOS, RECETAS, RENDIMIENTO_BASE)).toBeCloseTo(0.48, 4);
    });
});

describe('🥇 Golden parity — expandRecipeToBase (descuento de stock)', () => {
    test('SIN merma: PULPO 0.25/porción, ACEITE 0.125, HARINA (vía sub) 0.1', async () => {
        const base = await expandRecipeToBase(RECETA_PRINCIPAL, fakeClient, 3, {});
        const m = new Map(base.map(b => [b.ingredienteId, b.cantidadPorPorcion]));
        expect(m.get(2)).toBeCloseTo(0.25, 6);    // 1/4
        expect(m.get(3)).toBeCloseTo(0.125, 6);   // 0.5/4
        expect(m.get(1)).toBeCloseTo(0.1, 6);     // (2/10) × (2/4)
    });
    test('CON merma: PULPO descuenta CRUDO 0.4167/porción (0.25 / 0.60)', async () => {
        const base = await expandRecipeToBase(RECETA_PRINCIPAL, fakeClient, 3, {
            aplicarRendimiento: true,
            rendimientoIngredientesMap: RENDIMIENTO_BASE,
        });
        const m = new Map(base.map(b => [b.ingredienteId, b.cantidadPorPorcion]));
        expect(m.get(2)).toBeCloseTo(0.416667, 4); // (1/4)/0.60 — la merma SÍ descuenta
        expect(m.get(3)).toBeCloseTo(0.125, 6);    // línea rend=100 explícito → sin cambio
        expect(m.get(1)).toBeCloseTo(0.1, 6);      // HARINA sin rendimiento → sin cambio
    });
    test('porciones>1 divide SIEMPRE (regresión C1: bulk sin porciones descontaba ×4)', async () => {
        const sinPorciones = { ...RECETA_PRINCIPAL, porciones: undefined };
        const base = await expandRecipeToBase(sinPorciones, fakeClient, 3, {});
        const m = new Map(base.map(b => [b.ingredienteId, b.cantidadPorPorcion]));
        // Sin porciones → 1 → PULPO descontaría 1.0 entero (el bug C1). Este test
        // documenta el comportamiento para que la SELECT siempre traiga porciones.
        expect(m.get(2)).toBeCloseTo(1.0, 6);
    });
});
