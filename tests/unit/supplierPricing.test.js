/**
 * Prueba la matemática de propagación del formato del proveedor principal al ingrediente
 * (Opción A, Migración 017). Lo crítico: tras propagar, el precio UNITARIO (€/unidad-base)
 * del ingrediente debe seguir siendo el mismo que el canónico del proveedor — es decir,
 * ingredientes.precio / cantidad_por_formato === ip.precio. Si esto se rompe, el food cost
 * se descuadraría por el factor del formato.
 */
const {
    cpfSeguro,
    precioFichaDesdeBase,
    precioUnitarioIngrediente,
    desviacionSupera,
} = require('../../src/utils/supplierPricing');

describe('supplierPricing — cpfSeguro', () => {
    it('devuelve el número si es > 0', () => {
        expect(cpfSeguro(7.5)).toBe(7.5);
        expect(cpfSeguro('12')).toBe(12);
    });
    it('cae a 1 con 0, negativo, null, undefined o NaN (NUNCA 0)', () => {
        expect(cpfSeguro(0)).toBe(1);
        expect(cpfSeguro(-3)).toBe(1);
        expect(cpfSeguro(null)).toBe(1);
        expect(cpfSeguro(undefined)).toBe(1);
        expect(cpfSeguro('abc')).toBe(1);
    });
});

describe('supplierPricing — INVARIANTE precio/cpf = €base', () => {
    // Casos reales: volandeira docena, caja de 7.5 docenas, kg, etc.
    const casos = [
        { base: 11.70, cpf: 1 },
        { base: 6.42, cpf: 7.5 },
        { base: 2.00, cpf: 6 },
        { base: 0.4275, cpf: 90 },
        { base: 13.00, cpf: 12 },
        { base: 3.21, cpf: 15 },
    ];

    casos.forEach(({ base, cpf }) => {
        it(`base=${base} €/ud, cpf=${cpf} → ficha=base×cpf y ficha/cpf ≈ base`, () => {
            const ficha = precioFichaDesdeBase(base, cpf);
            // ingredientes.precio = €/formato = base × cpf (2 decimales)
            expect(ficha).toBeCloseTo(base * cpf, 2);
            // round-trip: al dividir por cpf recuperamos el €/unidad-base (tolerancia por redondeo a céntimo)
            const unit = precioUnitarioIngrediente(ficha, cpf);
            expect(Math.abs(unit - base)).toBeLessThan(0.01 / cpf + 1e-9);
        });
    });

    it('cpf=1 → ficha === base (comportamiento histórico intacto)', () => {
        expect(precioFichaDesdeBase(9.99, 1)).toBe(9.99);
        expect(precioUnitarioIngrediente(9.99, 1)).toBe(9.99);
    });

    it('precioFichaDesdeBase con base inválida devuelve null (no rompe)', () => {
        expect(precioFichaDesdeBase('x', 5)).toBeNull();
    });

    it('cpf 0/NaN nunca divide por cero (usa 1)', () => {
        expect(precioFichaDesdeBase(5, 0)).toBe(5);
        expect(precioUnitarioIngrediente(5, 0)).toBe(5);
    });
});

describe('supplierPricing — guard ±70% sobre precio UNITARIO', () => {
    it('NO dispara con cambios razonables (<70%)', () => {
        expect(desviacionSupera(11.70, 13.00)).toBe(false); // -10%
        expect(desviacionSupera(6.42, 11.70)).toBe(false);  // -45%, legítimo (proveedor más barato)
    });
    it('dispara con saltos brutales (>70%): error de captura', () => {
        expect(desviacionSupera(3.21, 11.70)).toBe(true);   // -72.5% (precio de caja como si fuera €/ud)
        expect(desviacionSupera(90, 11.70)).toBe(true);
    });
    it('no dispara si el actual es 0/indefinido (no hay base de comparación)', () => {
        expect(desviacionSupera(5, 0)).toBe(false);
        expect(desviacionSupera(5, null)).toBe(false);
    });
    it('umbral configurable', () => {
        expect(desviacionSupera(1.5, 1.0, 0.70)).toBe(false); // +50%
        expect(desviacionSupera(1.5, 1.0, 0.40)).toBe(true);  // +50% > 40%
    });
});
