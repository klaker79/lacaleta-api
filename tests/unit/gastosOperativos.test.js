/**
 * Gastos fijos operativos: excluye SOLO impuestos no operativos
 * (IVA/IGIC/IRPF/Sociedades). El IAE, IBI, tasas y gastos de explotación SÍ.
 *
 * El filtro real es un regex de Postgres (`!~*` con \y word boundary). Aquí se
 * verifica la MISMA lógica con su equivalente JS (\y ≈ \b) para blindar que la
 * regla no se rompa. Debe coincidir con el frontend (esImpuestoNoOperativo).
 */
const { IMPUESTOS_NO_OPERATIVOS_REGEX, condicionGastosOperativosSql } = require('../../src/utils/gastosOperativos');

// Réplica JS del regex Postgres: \y (word boundary Postgres) ≈ \b (JS).
const re = new RegExp(IMPUESTOS_NO_OPERATIVOS_REGEX.replace(/\\y/g, '\\b'), 'i');

describe('gastos operativos — impuestos NO operativos (excluidos)', () => {
    test('excluye IVA / IGIC / IRPF / Sociedades', () => {
        ['IVA', 'IGIC', 'IRPF', 'Sociedades', 'Impuesto de Sociedades'].forEach(c => {
            expect(re.test(c)).toBe(true);
        });
    });

    test('MANTIENE el IAE, IBI y los gastos de explotación (NO son no operativos)', () => {
        ['IAE', 'IBI', 'Nóminas', 'Seguridad Social', 'Alquiler', 'Tasa basura',
         'Cuota préstamo', 'Luz', 'Seguro local', 'Licencia'].forEach(c => {
            expect(re.test(c)).toBe(false);
        });
    });
});

describe('condicionGastosOperativosSql', () => {
    test('usa la columna concepto por defecto y admite alias', () => {
        expect(condicionGastosOperativosSql()).toMatch(/^concepto !~\* /);
        expect(condicionGastosOperativosSql('g.concepto')).toMatch(/^g\.concepto !~\* /);
    });
});
