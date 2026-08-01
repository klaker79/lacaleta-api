/**
 * Diferencia de inventario — el dato que se calculaba y se tiraba.
 *
 * Cada recuento físico guarda en inventory_snapshots_v2 lo que el sistema creía
 * tener y lo que había de verdad. 560 registros en La Nave 5 desde diciembre de
 * 2025, y ninguna pantalla los leía.
 *
 * `computeInventoryDifference` agrupa esos snapshots en SESIONES (una vuelta a la
 * cámara) y valora la diferencia en euros. No corrige stock: el inventario virtual
 * es una aproximación y el recuento es lo único que pone los dos mundos a cero.
 */
const { computeInventoryDifference } = require('../../src/utils/businessHelpers');

// Recorte del recuento real del 23/07 en La Nave 5.
const fila = (over = {}) => ({
    fecha: '2026-07-23T15:12:00.000Z',
    ingrediente_id: 45, nombre: 'BERBERECHOS', unidad: 'kg',
    stock_virtual: 20, stock_real: 8, diferencia: -12,
    precio: 16.32, cantidad_por_formato: 1, precio_fijado: false,
    precio_medio_compra: 16.32,
    ...over
});

describe('computeInventoryDifference — sesiones y valoración', () => {
    test('valora la falta en euros con el precio canónico', () => {
        const [s] = computeInventoryDifference([fila()]);
        expect(s.contados).toBe(1);
        expect(s.falta_eur).toBeCloseTo(12 * 16.32, 2);
        expect(s.sobra_eur).toBe(0);
        expect(s.neto_eur).toBeCloseTo(-12 * 16.32, 2);
    });

    test('separa lo que falta de lo que sobra', () => {
        const [s] = computeInventoryDifference([
            fila(),
            fila({ ingrediente_id: 47, nombre: 'NAVAJA', stock_virtual: 5, stock_real: 8, diferencia: 3, precio: 10, precio_medio_compra: 10 })
        ]);
        expect(s.falta_eur).toBeCloseTo(195.84, 2);
        expect(s.sobra_eur).toBeCloseTo(30, 2);
        expect(s.neto_eur).toBeCloseTo(-165.84, 2);
        expect(s.contados).toBe(2);
    });

    // El recuento se guarda fila a fila: las del mismo minuto son UNA vuelta.
    // Y en La Nave 5 se cuenta por zonas, así que dos vueltas el mismo día son
    // dos recuentos distintos y no deben fundirse.
    test('agrupa por minuto, no por día', () => {
        const s = computeInventoryDifference([
            fila({ fecha: '2026-07-23T15:12:00.000Z' }),
            fila({ fecha: '2026-07-23T15:12:30.000Z' }),   // misma vuelta
            fila({ fecha: '2026-07-23T19:40:00.000Z' })    // otra vuelta, mismo día
        ]);
        expect(s).toHaveLength(2);
        expect(s[0].contados).toBe(1);   // la de las 19:40
        expect(s[1].contados).toBe(2);
    });

    test('ordena de más reciente a más antiguo', () => {
        const s = computeInventoryDifference([
            fila({ fecha: '2026-06-24T07:59:00.000Z' }),
            fila({ fecha: '2026-07-23T15:12:00.000Z' })
        ]);
        expect(s[0].fecha.slice(0, 10)).toBe('2026-07-23');
        expect(s[1].fecha.slice(0, 10)).toBe('2026-06-24');
    });
});

describe('desviación en % — lo que hace comparables dos recuentos', () => {
    // 3.000 € de desviación no significan lo mismo contando la bodega entera que
    // contando cuatro ingredientes. El % se mide sobre lo que decía el sistema.
    test('se calcula sobre el valor que el sistema esperaba', () => {
        const [s] = computeInventoryDifference([fila()]);   // esperaba 20 kg × 16,32
        expect(s.valor_esperado).toBeCloseTo(326.4, 2);
        expect(s.desviacion_pct).toBeCloseTo(60, 1);        // faltaban 12 de 20
    });

    test('sin valor esperado no se inventa un porcentaje', () => {
        const [s] = computeInventoryDifference([
            fila({ stock_virtual: 0, stock_real: 0, diferencia: 0, precio: 0, precio_medio_compra: null })
        ]);
        expect(s.desviacion_pct).toBeNull();
    });
});

describe('top de desviaciones', () => {
    test('ordena por dinero, no por cantidad, y recorta', () => {
        const s = computeInventoryDifference([
            fila({ ingrediente_id: 1, nombre: 'MUCHAS UNIDADES', stock_virtual: 1000, stock_real: 0, diferencia: -1000, precio: 0.1, precio_medio_compra: 0.1 }),
            fila({ ingrediente_id: 2, nombre: 'POCAS PERO CARAS', stock_virtual: 10, stock_real: 0, diferencia: -10, precio: 60, precio_medio_compra: 60 })
        ], { topN: 1 });
        expect(s[0].top).toHaveLength(1);
        expect(s[0].top[0].nombre).toBe('POCAS PERO CARAS');
    });

    test('los ingredientes que cuadran no ensucian el top', () => {
        const [s] = computeInventoryDifference([
            fila(),
            fila({ ingrediente_id: 9, nombre: 'CUADRA', stock_virtual: 5, stock_real: 5, diferencia: 0 })
        ]);
        expect(s.top.map(t => t.nombre)).toEqual(['BERBERECHOS']);
    });
});

describe('entradas raras no rompen el informe', () => {
    test('lista vacía o nula', () => {
        expect(computeInventoryDifference([])).toEqual([]);
        expect(computeInventoryDifference(null)).toEqual([]);
    });

    test('filas sin fecha o con fecha inválida se ignoran', () => {
        expect(computeInventoryDifference([fila({ fecha: null }), fila({ fecha: 'no-es-fecha' })])).toEqual([]);
    });

    test('si `diferencia` viene nula se recalcula de real - virtual', () => {
        const [s] = computeInventoryDifference([fila({ diferencia: null })]);
        expect(s.neto_eur).toBeCloseTo(-12 * 16.32, 2);
    });
});
