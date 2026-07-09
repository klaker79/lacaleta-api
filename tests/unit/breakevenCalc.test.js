/**
 * Tests del cálculo puro del Punto de Equilibrio (tool de Omnes).
 * El caso "La Nave 5" replica los números REALES verificados por SQL el
 * 2026-07-09 y DEBE dar lo mismo que el bloque de Análisis del frontend:
 * gastos operativos 40.406,58 € · fc global 90d 34,2 % · ticket 16,15 €
 * → 3.802 platos/mes · ~2.362 €/día.
 */
const { computeBreakevenBackend, DIAS_SERVICIO_MES_DEFAULT } = require('../../src/utils/breakevenCalc');

describe('computeBreakevenBackend', () => {
    test('caso La Nave 5 (números reales 2026-07-09): cuadra con el bloque del frontend', () => {
        const r = computeBreakevenBackend({
            gastosOperativosMes: 40406.58,
            foodCostPct: 34.2,
            ticketMedio: 16.152 // ticket ponderado real del periodo
        });
        expect(r).not.toBeNull();
        // margen = 16,152 × 0,658 = 10,63 €
        expect(r.margen_por_plato).toBeCloseTo(10.63, 2);
        // platos = ceil(40406,58 / 10,628) = 3802 (mismo que la app)
        expect(r.platos_equilibrio_mes).toBe(3802);
        expect(r.dias_servicio).toBe(26);
        // €/día ≈ 2.362 (la app muestra 2.361,88 con su ticket exacto)
        expect(r.ventas_equilibrio_dia).toBeGreaterThan(2300);
        expect(r.ventas_equilibrio_dia).toBeLessThan(2420);
        // coherencia interna: ventas mes = platos × ticket CRUDO (el ticket_medio
        // del resultado va redondeado a 2 decimales solo para mostrar); día = mes/días
        expect(r.ventas_equilibrio_mes).toBeCloseTo(r.platos_equilibrio_mes * 16.152, 1);
        expect(r.ventas_equilibrio_dia).toBeCloseTo(r.ventas_equilibrio_mes / 26, 1);
    });

    test('fórmula: margen = ticket × (1 − fc/100); platos = ceil(gastos/margen)', () => {
        const r = computeBreakevenBackend({ gastosOperativosMes: 10000, foodCostPct: 50, ticketMedio: 20 });
        expect(r.margen_por_plato).toBe(10);           // 20 × 0,5
        expect(r.platos_equilibrio_mes).toBe(1000);    // ceil(10000/10)
        expect(r.ventas_equilibrio_mes).toBe(20000);   // 1000 × 20
        expect(r.ventas_equilibrio_dia).toBeCloseTo(20000 / 26, 2);
    });

    test('diasServicio configurable; default 26', () => {
        expect(DIAS_SERVICIO_MES_DEFAULT).toBe(26);
        const r = computeBreakevenBackend({ gastosOperativosMes: 26000, foodCostPct: 50, ticketMedio: 20, diasServicio: 30 });
        expect(r.dias_servicio).toBe(30);
        expect(r.platos_equilibrio_dia).toBe(Math.ceil(r.platos_equilibrio_mes / 30));
    });

    test('datos inválidos → null (sin gastos, fc fuera de rango, ticket 0)', () => {
        expect(computeBreakevenBackend({ gastosOperativosMes: 0, foodCostPct: 34, ticketMedio: 16 })).toBeNull();
        expect(computeBreakevenBackend({ gastosOperativosMes: 1000, foodCostPct: 0, ticketMedio: 16 })).toBeNull();
        expect(computeBreakevenBackend({ gastosOperativosMes: 1000, foodCostPct: 100, ticketMedio: 16 })).toBeNull();
        expect(computeBreakevenBackend({ gastosOperativosMes: 1000, foodCostPct: 34, ticketMedio: 0 })).toBeNull();
        expect(computeBreakevenBackend({})).toBeNull();
    });
});
