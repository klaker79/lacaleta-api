// Deriva de precio sostenida ("caso tomate", Anais 2026-07-05).
// computePriceDrift compara el precio que usa el food cost HOY (vía
// getBackendIngredientUnitPrice: media histórica o precio fijado 📌) contra la
// media ponderada de los últimos 90 días, y devuelve SOLO subidas sostenidas
// (>= minCompras días de compra) en ingredientes de alto gasto (>= minGasto).
// ADITIVO: no toca ningún cálculo existente.
const { computePriceDrift } = require('../../src/utils/businessHelpers');

// Fila base: "TOMATE" — histórico dice 3 €/kg, últimos 90d comprando a 10 €/kg.
// El escandallo enseña food cost con 3 € cuando la realidad reciente es 10 €.
const TOMATE = {
    id: 1, nombre: 'TOMATE', unidad: 'kg',
    precio: 3, cantidad_por_formato: 1, precio_fijado: false,
    precio_medio_compra: 3.0,          // media histórica (la que usa la app)
    media_90d: 10.0,                   // media ponderada últimos 90 días
    n_compras_90d: 12, gasto_90d: 1200, cantidad_90d: 120,
    ultima_compra: '2026-07-01'
};

describe('computePriceDrift — subida sostenida (caso tomate)', () => {
    test('detecta la subida sostenida y calcula desviación e impacto/mes', () => {
        const out = computePriceDrift([TOMATE]);
        expect(out).toHaveLength(1);
        const a = out[0];
        expect(a.precio_app).toBe(3.0);            // lo que usa el food cost
        expect(a.media_90d).toBe(10.0);            // la realidad reciente
        expect(a.desviacion_pct).toBeCloseTo(233.3, 1);
        // (10-3) €/ud × 120 ud / 3 meses = 280 €/mes de sobrecoste oculto
        expect(a.impacto_mes).toBeCloseTo(280, 2);
        expect(a.recetas_afectadas).toBeUndefined(); // lo añade la ruta, no el helper
    });

    test('una entrega suelta cara NO es sostenido (n_compras < minCompras) → sin alerta', () => {
        const out = computePriceDrift([{ ...TOMATE, n_compras_90d: 2 }]);
        expect(out).toHaveLength(0);
    });

    test('ingrediente de gasto bajo (< minGasto) → sin alerta (no mueve dinero)', () => {
        const out = computePriceDrift([{ ...TOMATE, gasto_90d: 60 }]);
        expect(out).toHaveLength(0);
    });

    test('BAJADA de precio → sin alerta (solo subidas: la bajada no te hace perder)', () => {
        const out = computePriceDrift([{ ...TOMATE, media_90d: 2.0 }]);
        expect(out).toHaveLength(0);
    });

    test('subida menor que el umbral (p.ej. +10% con umbral 15%) → sin alerta', () => {
        const out = computePriceDrift([{ ...TOMATE, media_90d: 3.3 }]);
        expect(out).toHaveLength(0);
    });

    test('umbral configurable: +10% SÍ alerta con umbralPct=8', () => {
        const out = computePriceDrift([{ ...TOMATE, media_90d: 3.3 }], { umbralPct: 8 });
        expect(out).toHaveLength(1);
        expect(out[0].desviacion_pct).toBeCloseTo(10, 1);
    });

    test('precio_fijado 📌: compara contra el precio FIJADO, no contra la media histórica', () => {
        // Fijado a 3 €/ud (precio/cpf) aunque la media histórica sea 9: si llevas
        // 90 días comprando a 10, la alerta debe saltar CONTRA EL FIJADO (3).
        const row = { ...TOMATE, precio_fijado: true, precio: 3, cantidad_por_formato: 1, precio_medio_compra: 9.0 };
        const out = computePriceDrift([row]);
        expect(out).toHaveLength(1);
        expect(out[0].precio_app).toBe(3.0);
        expect(out[0].precio_fijado).toBe(true);
        expect(out[0].desviacion_pct).toBeCloseTo(233.3, 1);
    });

    test('sin compras en 90d (media_90d null) → sin alerta y sin crash', () => {
        const out = computePriceDrift([{ ...TOMATE, media_90d: null }]);
        expect(out).toHaveLength(0);
    });

    test('sin precio de app (todo null/0) → sin alerta y sin crash', () => {
        const row = { ...TOMATE, precio: 0, precio_medio_compra: null, precio_medio: null };
        const out = computePriceDrift([row]);
        expect(out).toHaveLength(0);
    });

    test('ordena por impacto_mes desc (lo que más dinero te cuesta, primero)', () => {
        const pequeno = { ...TOMATE, id: 2, nombre: 'PEREJIL', cantidad_90d: 30, gasto_90d: 300 }; // impacto 70
        const out = computePriceDrift([pequeno, TOMATE]);
        expect(out.map(a => a.nombre)).toEqual(['TOMATE', 'PEREJIL']);
    });

    test('entrada vacía / null → [] sin crash', () => {
        expect(computePriceDrift([])).toEqual([]);
        expect(computePriceDrift(null)).toEqual([]);
    });
});
