/**
 * personalCostExpr — expresión SQL que calcula el coste de las líneas de comida
 * personal de un pedido, para RESTARLO de pedidos.total en los agregados de gasto.
 *
 * Es la pieza central del aislamiento de comida personal (incidente 2026-06-10).
 * Estos tests fijan su forma para que un cambio no la rompa en silencio.
 */
const { personalCostExpr } = require('../../src/utils/personalCost');

describe('personalCostExpr', () => {
    test('usa el alias por defecto "p"', () => {
        const sql = personalCostExpr();
        expect(sql).toContain("jsonb_array_elements(COALESCE(p.ingredientes");
    });

    test('acepta un alias personalizado', () => {
        expect(personalCostExpr('x')).toContain("jsonb_array_elements(COALESCE(x.ingredientes");
    });

    test('filtra SOLO las líneas marcadas personal = true', () => {
        expect(personalCostExpr('p')).toMatch(/personal'\)::boolean,\s*false\)\s*=\s*true/);
    });

    test('suma cantidad × precio con el MISMO COALESCE que la pestaña Búsqueda', () => {
        const sql = personalCostExpr('p');
        // cantidad: cantidadRecibida || cantidad
        expect(sql).toContain("e->>'cantidadRecibida'");
        expect(sql).toContain("e->>'cantidad'");
        // precio: precioReal || precioUnitario || precio_unitario
        expect(sql).toContain("e->>'precioReal'");
        expect(sql).toContain("e->>'precioUnitario'");
        expect(sql).toContain("e->>'precio_unitario'");
    });

    test('las líneas no-entregado cuentan 0', () => {
        expect(personalCostExpr('p')).toMatch(/no-entregado'\s*THEN 0/);
    });

    test('va envuelto en COALESCE(..., 0) → nunca devuelve NULL', () => {
        expect(personalCostExpr('p').trim().startsWith('COALESCE(')).toBe(true);
        expect(personalCostExpr('p').trim().endsWith(', 0)')).toBe(true);
    });

    test('es una expresión escalar (un solo SELECT SUM)', () => {
        const sql = personalCostExpr('p');
        expect((sql.match(/SELECT SUM/g) || []).length).toBe(1);
    });
});
