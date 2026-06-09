/**
 * Tests del prorrateo de gastos fijos (src/utils/prorrateo.js).
 *
 * Cubre el bug que veía Iker: P&L de "este mes" a día 9 comparaba 9 días de
 * ingresos contra un mes ENTERO de gastos fijos → beneficio neto catastrófico.
 * Ahora los fijos se prorratean a los días reales del periodo.
 */
const { prorratearGastosFijos } = require('../../src/utils/prorrateo');

describe('prorratearGastosFijos', () => {
    const FIJOS = 45645;

    test('mes en curso parcial (1-9 jun, hoy=9) → prorratea 9/30 y marca parcial', () => {
        // El modelo pide el mes completo, pero hoy es 9 jun (hoyExclusivo = 10 jun).
        const r = prorratearGastosFijos(FIJOS, '2026-06-01', '2026-07-01', '2026-06-10');
        expect(r.hasta_efectivo).toBe('2026-06-10');
        expect(r.dias_periodo).toBe(9);
        expect(r.dias_mes).toBe(30);
        expect(r.parcial).toBe(true);
        // 45645 * 9 / 30 = 13693.5
        expect(r.gastos_fijos_periodo).toBe(13693.5);
    });

    test('mes cerrado completo (mayo) → fijos completos, no parcial', () => {
        const r = prorratearGastosFijos(FIJOS, '2026-05-01', '2026-06-01', '2026-06-10');
        expect(r.hasta_efectivo).toBe('2026-06-01');
        expect(r.dias_periodo).toBe(31);
        expect(r.dias_mes).toBe(31);
        expect(r.parcial).toBe(false);
        expect(r.gastos_fijos_periodo).toBe(FIJOS);
    });

    test('mes de 30 días completo (abril) → fijos completos', () => {
        const r = prorratearGastosFijos(FIJOS, '2026-04-01', '2026-05-01', '2026-06-10');
        expect(r.dias_periodo).toBe(30);
        expect(r.dias_mes).toBe(30);
        expect(r.parcial).toBe(false);
        expect(r.gastos_fijos_periodo).toBe(FIJOS);
    });

    test('periodo enteramente futuro → 0 días, 0 fijos', () => {
        const r = prorratearGastosFijos(FIJOS, '2026-07-01', '2026-08-01', '2026-06-10');
        expect(r.dias_periodo).toBe(0);
        expect(r.gastos_fijos_periodo).toBe(0);
        expect(r.parcial).toBe(true);
    });

    test('gastos fijos 0 → siempre 0', () => {
        const r = prorratearGastosFijos(0, '2026-06-01', '2026-07-01', '2026-06-10');
        expect(r.gastos_fijos_periodo).toBe(0);
    });

    test('gastos fijos no numérico → 0 (defensivo)', () => {
        const r = prorratearGastosFijos(null, '2026-06-01', '2026-06-10', '2026-06-10');
        expect(r.gastos_fijos_periodo).toBe(0);
    });

    test('febrero bisiesto (2028) parcial → divide entre 29', () => {
        const r = prorratearGastosFijos(2900, '2028-02-01', '2028-03-01', '2028-02-11');
        expect(r.dias_mes).toBe(29);
        expect(r.dias_periodo).toBe(10);
        // 2900 * 10 / 29 = 1000
        expect(r.gastos_fijos_periodo).toBe(1000);
    });
});
