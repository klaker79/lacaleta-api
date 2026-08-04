/**
 * Rendimiento real de una elaboración (caso PULPO, auditoría 2026-08-02):
 * la ficha decía 60% pero pesando salía ~44%, y esa diferencia era food cost
 * invisible (36,5% → 49,7% en PULPO A FEIRA). La función convierte dos pesadas
 * (bruta y neta) en el rendimiento real, y caza los dedazos de unidades.
 */
const { calcularRendimientoReal, RENDIMIENTO_MAX } = require('../../src/utils/rendimientoReal');

describe('calcularRendimientoReal', () => {
    test('el caso pulpo: 10 kg crudos → 4,4 kg cocidos = 44%', () => {
        const r = calcularRendimientoReal(10, 4.4);
        expect(r.valid).toBe(true);
        expect(r.rendimiento).toBe(44);
    });

    test('redondea a 2 decimales', () => {
        const r = calcularRendimientoReal(3, 2);
        expect(r.valid).toBe(true);
        expect(r.rendimiento).toBe(66.67);
    });

    test('más del 100% es válido (arroz: 1 kg seco → 2,5 kg cocido)', () => {
        const r = calcularRendimientoReal(1, 2.5);
        expect(r.valid).toBe(true);
        expect(r.rendimiento).toBe(250);
    });

    test('acepta strings numéricos (vienen del body JSON del modal)', () => {
        const r = calcularRendimientoReal('10', '6');
        expect(r.valid).toBe(true);
        expect(r.rendimiento).toBe(60);
    });

    describe('dedazos que rebotan', () => {
        test('bruta 0 o negativa', () => {
            expect(calcularRendimientoReal(0, 5).valid).toBe(false);
            expect(calcularRendimientoReal(-3, 5).valid).toBe(false);
        });

        test('neta 0 o negativa', () => {
            expect(calcularRendimientoReal(5, 0).valid).toBe(false);
            expect(calcularRendimientoReal(5, -1).valid).toBe(false);
        });

        test('no numérico', () => {
            expect(calcularRendimientoReal('pulpo', 5).valid).toBe(false);
            expect(calcularRendimientoReal(undefined, 5).valid).toBe(false);
        });

        test(`unidades mezcladas (bruta en kg, neta en g): >${RENDIMIENTO_MAX}% rebota`, () => {
            // 2 kg crudos y "1800" (gramos) de neta ⇒ 90.000%: imposible.
            const r = calcularRendimientoReal(2, 1800);
            expect(r.valid).toBe(false);
            expect(r.error).toMatch(/unidades/);
        });
    });
});
