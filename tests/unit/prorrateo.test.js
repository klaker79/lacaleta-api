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

    // ── Criterio Iker 2026-07-08: devengo por DÍAS CON VENTAS ─────────────
    // El mismo criterio que la Cuenta de Resultados del Diario: cada día
    // trabajado carga su gasto fijo diario; los días sin ventas NO cargan.

    test('días con ventas < días de calendario → devenga solo los trabajados (caso La Nave 5 julio)', () => {
        // Julio, hoy=8 (8 días de calendario) pero solo 4 días con ventas.
        // Operativos 40406.58 → diario 1303.44 → 4 días = 5213.75 (redondeo a cts).
        const r = prorratearGastosFijos(40406.58, '2026-07-01', '2026-08-01', '2026-07-09', 4);
        expect(r.dias_periodo).toBe(8);
        expect(r.dias_devengo).toBe(4);
        expect(r.gastos_fijos_periodo).toBe(Math.round((40406.58 * 4 / 31) * 100) / 100);
    });

    test('mes cerrado con días sin ventas → devenga solo los días con ventas', () => {
        // Junio cerrado (30 días) pero abrió 26.
        const r = prorratearGastosFijos(FIJOS, '2026-06-01', '2026-07-01', '2026-08-01', 26);
        expect(r.dias_periodo).toBe(30);
        expect(r.dias_devengo).toBe(26);
        expect(r.gastos_fijos_periodo).toBe(Math.round((FIJOS * 26 / 30) * 100) / 100);
    });

    test('0 días con ventas → 0 fijos (sin columnas no hay cargo, como la tabla)', () => {
        const r = prorratearGastosFijos(FIJOS, '2026-06-01', '2026-07-01', '2026-08-01', 0);
        expect(r.dias_devengo).toBe(0);
        expect(r.gastos_fijos_periodo).toBe(0);
    });

    test('diasConVentas null/omitido → comportamiento antiguo (días de calendario)', () => {
        const r = prorratearGastosFijos(FIJOS, '2026-05-01', '2026-06-01', '2026-06-10', null);
        expect(r.dias_devengo).toBe(31);
        expect(r.gastos_fijos_periodo).toBe(FIJOS);
    });

    test('diasConVentas mayor que los días del periodo → se recorta al calendario', () => {
        const r = prorratearGastosFijos(FIJOS, '2026-06-01', '2026-07-01', '2026-08-01', 99);
        expect(r.dias_devengo).toBe(30);
        expect(r.gastos_fijos_periodo).toBe(FIJOS);
    });
});
