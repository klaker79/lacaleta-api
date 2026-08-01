// Suministros acumulados (auditoría de stock, 2026-08-01).
//
// Los suministros no están en ninguna receta ⇒ vender NO los descuenta: solo
// entran, nunca salen. Su stock deja de medir el almacén y pasa a medir todo lo
// comprado desde el primer día. En La Nave 5, 45 de 54 suministros no habían
// bajado ni una unidad en 90 días y 0 de 69 tenían recuento físico.
//
// computeSuppliesOverstock compara el stock contra el RITMO REAL DE COMPRA (el
// único proxy de consumo que tienen: si sigues comprando propano es que lo
// gastas) y devuelve los que acumulan más meses de los razonables.
// ADITIVO: no toca ningún cálculo existente, solo avisa.
const { computeSuppliesOverstock } = require('../../src/utils/businessHelpers');

// "PROPANO" real de La Nave 5: 240 unidades en stock, 128 compradas en 90 días
// (≈42,7/mes) ⇒ 5,6 meses de cobertura acumulados.
const PROPANO = {
    id: 1, nombre: 'PROPANO', unidad: 'unidad',
    stock_actual: 240, stock_real: null,
    precio: 15.53, cantidad_por_formato: 1,
    cantidad_90d: 128, n_compras_90d: 8,
    ultima_compra: '2026-07-21'
};

describe('computeSuppliesOverstock — acumulación frente al ritmo de compra', () => {
    test('detecta el sobrestock y calcula cobertura, exceso y su valor', () => {
        const out = computeSuppliesOverstock([PROPANO]);
        expect(out).toHaveLength(1);
        const a = out[0];
        expect(a.ritmo_mes).toBeCloseTo(42.67, 1);       // 128 / 3 meses
        expect(a.meses_cobertura).toBeCloseTo(5.6, 1);   // 240 / 42,67
        // Con umbral de 2 meses, lo "sano" serían 85,3 uds ⇒ sobran ~154,7.
        expect(a.exceso).toBeCloseTo(154.67, 1);
        expect(a.valor_exceso).toBeCloseTo(154.67 * 15.53, 0);
        expect(a.nunca_contado).toBe(true);
        expect(a.sin_compras_recientes).toBe(false);
    });

    test('un suministro que rota bien NO genera aviso', () => {
        // "BOBINA MECHA" real: 78 en stock, 216 compradas en 90d ⇒ 1,1 meses.
        const rota = { ...PROPANO, nombre: 'BOBINA MECHA', stock_actual: 78, cantidad_90d: 216 };
        expect(computeSuppliesOverstock([rota])).toHaveLength(0);
    });

    test('el umbral de meses es configurable', () => {
        expect(computeSuppliesOverstock([PROPANO], { umbralMeses: 6 })).toHaveLength(0);
        expect(computeSuppliesOverstock([PROPANO], { umbralMeses: 1 })).toHaveLength(1);
    });
});

describe('filtros anti-ruido', () => {
    test('material barato no genera aviso aunque acumule', () => {
        const barato = { ...PROPANO, precio: 0.05 }; // 240 × 0,05 = 12 € < minValor 25
        expect(computeSuppliesOverstock([barato])).toHaveLength(0);
        // Bajando el umbral de valor sí aparece.
        expect(computeSuppliesOverstock([barato], { minValor: 1 })).toHaveLength(1);
    });

    test('una compra puntual no es un ritmo — no avisa', () => {
        // 300 copas en UNA sola entrada: no hay ritmo con el que comparar.
        const puntual = { ...PROPANO, nombre: 'COPAS', stock_actual: 300, cantidad_90d: 300, n_compras_90d: 1 };
        expect(computeSuppliesOverstock([puntual])).toHaveLength(0);
    });

    test('stock 0 nunca genera aviso', () => {
        expect(computeSuppliesOverstock([{ ...PROPANO, stock_actual: 0 }])).toHaveLength(0);
    });

    test('lista vacía o nula no rompe', () => {
        expect(computeSuppliesOverstock([])).toEqual([]);
        expect(computeSuppliesOverstock(null)).toEqual([]);
    });
});

describe('sin compras en la ventana', () => {
    // Tienes 4.000 toallitas y llevas medio año sin reponer: igual de sospechoso,
    // pero la cobertura es infinita y no se puede calcular. Se marca aparte en vez
    // de inventar un número de meses.
    const parado = {
        id: 2, nombre: 'TAPA PARA VASO 6 ONZAS', unidad: 'unidad',
        stock_actual: 64, stock_real: null,
        precio: 2.12, cantidad_por_formato: 1,
        cantidad_90d: 0, n_compras_90d: 0, ultima_compra: null
    };

    test('avisa marcando sin_compras_recientes, sin inventar cobertura', () => {
        const out = computeSuppliesOverstock([parado]);
        expect(out).toHaveLength(1);
        expect(out[0].sin_compras_recientes).toBe(true);
        expect(out[0].meses_cobertura).toBeNull();
        // Sin ritmo de referencia, TODO el stock es exceso.
        expect(out[0].exceso).toBe(64);
    });
});

describe('precio unitario y orden', () => {
    test('usa precio/cantidad_por_formato, igual que valor_stock del inventario', () => {
        // Caja de 100 uds a 20 € ⇒ 0,20 €/ud. 500 uds en stock = 100 €.
        const caja = { ...PROPANO, precio: 20, cantidad_por_formato: 100, stock_actual: 500, cantidad_90d: 100 };
        const a = computeSuppliesOverstock([caja])[0];
        expect(a.valor).toBeCloseTo(100, 2);
    });

    test('ordena por valor del exceso, no por cantidad', () => {
        // `muchas` acumula más unidades, pero `caras` acumula más DINERO.
        const muchas = { ...PROPANO, id: 10, nombre: 'MUCHAS', precio: 0.5, stock_actual: 1000, cantidad_90d: 300 };
        const caras = { ...PROPANO, id: 11, nombre: 'CARAS', precio: 50, stock_actual: 100, cantidad_90d: 30 };
        const out = computeSuppliesOverstock([muchas, caras]);
        expect(out.map(a => a.nombre)).toEqual(['CARAS', 'MUCHAS']);
    });
});
