// Entradas sin registrar (caso PAN de La Nave 5, 2026-08).
// Al vender con el stock a 0, el descuento se queda en GREATEST(0,...) y la venta
// guarda en `stock_deductions` lo que se PUDO descontar (`real`) frente a lo que
// TOCABA (`calculado`). Si esa diferencia se acumula, la mercancía entra en la
// cocina sin registrarse. computeUnregisteredEntries valora ese déficit con la
// función canónica de precio y filtra el ruido.
// ADITIVO: no toca stock, ni compensa, ni crea deuda.
const { computeUnregisteredEntries } = require('../../src/utils/businessHelpers');

// Fila base: "PAN" — 2.517,64 unidades servidas sobre cero en 150 ventas.
// El pan entra cada mañana y no se recepciona (compras registradas: 1,4 uds).
const PAN = {
    id: 345, nombre: 'PAN', unidad: 'unidad',
    precio: 2.2, cantidad_por_formato: 1, precio_fijado: false,
    precio_medio_compra: 2.2,
    uds_sin_descontar: 2517.64, n_ventas: 150,
    primera: '2026-05-11', ultima: '2026-08-06'
};

describe('computeUnregisteredEntries — mercancía que entra sin registrarse', () => {
    test('detecta el déficit y lo valora con el precio canónico', () => {
        const out = computeUnregisteredEntries([PAN]);
        expect(out).toHaveLength(1);
        const a = out[0];
        expect(a.id).toBe(345);
        expect(a.uds_sin_descontar).toBeCloseTo(2517.64, 2);
        expect(a.importe_eur).toBeCloseTo(5538.81, 2); // 2517,64 × 2,2 €/ud
        expect(a.n_ventas).toBe(150);
        expect(a.primera).toBe('2026-05-11');
    });

    test('respeta precio_fijado 📌 (override manual manda sobre la media)', () => {
        const out = computeUnregisteredEntries([{
            ...PAN, precio_fijado: true, precio: 10, cantidad_por_formato: 2,
            precio_medio_compra: 2.2, uds_sin_descontar: 100, n_ventas: 10
        }]);
        // precio fijado: 10 € / 2 uds por formato = 5 €/ud → 100 × 5 = 500 €
        expect(out[0].importe_eur).toBeCloseTo(500, 2);
    });

    test('un despiste suelto (n_ventas < minVentas) NO es un proceso roto', () => {
        const out = computeUnregisteredEntries([{ ...PAN, n_ventas: 2 }]);
        expect(out).toHaveLength(0);
    });

    test('déficit que no mueve dinero (< minEuros) → sin alerta', () => {
        const out = computeUnregisteredEntries([{ ...PAN, uds_sin_descontar: 5 }]); // 11 €
        expect(out).toHaveLength(0);
    });

    test('sin déficit (calculado == real) → sin alerta', () => {
        const out = computeUnregisteredEntries([{ ...PAN, uds_sin_descontar: 0 }]);
        expect(out).toHaveLength(0);
    });

    test('déficit negativo (dato corrupto) → se ignora, no revienta', () => {
        const out = computeUnregisteredEntries([{ ...PAN, uds_sin_descontar: -50 }]);
        expect(out).toHaveLength(0);
    });

    test('ingrediente sin precio válido → no inventa importe', () => {
        const out = computeUnregisteredEntries([{
            ...PAN, precio: 0, precio_medio_compra: null, precio_medio: null
        }]);
        expect(out).toHaveLength(0);
    });

    test('ordena por importe descendente (lo que más duele, primero)', () => {
        const out = computeUnregisteredEntries([
            { ...PAN, id: 1, nombre: 'FILLOA', uds_sin_descontar: 1583, precio_medio_compra: 1 },
            { ...PAN, id: 2, nombre: 'PAN', uds_sin_descontar: 2517.64, precio_medio_compra: 2.2 },
            { ...PAN, id: 3, nombre: 'XOUBIÑA', uds_sin_descontar: 49.41, precio_medio_compra: 9.46 }
        ]);
        expect(out.map(a => a.nombre)).toEqual(['PAN', 'FILLOA', 'XOUBIÑA']);
    });

    test('umbrales configurables por query param', () => {
        const filas = [{ ...PAN, uds_sin_descontar: 30, n_ventas: 3 }]; // 66 €, 3 ventas
        expect(computeUnregisteredEntries(filas)).toHaveLength(0);      // por defecto fuera
        expect(computeUnregisteredEntries(filas, { minVentas: 1, minEuros: 10 })).toHaveLength(1);
    });

    test('entrada vacía o nula no rompe', () => {
        expect(computeUnregisteredEntries([])).toEqual([]);
        expect(computeUnregisteredEntries(null)).toEqual([]);
        expect(computeUnregisteredEntries(undefined)).toEqual([]);
    });
});
