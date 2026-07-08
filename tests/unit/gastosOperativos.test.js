/**
 * Gastos fijos operativos: excluye SOLO impuestos no operativos
 * (IVA/IGIC/IRPF/Sociedades). El IAE, IBI, tasas y gastos de explotación SÍ.
 *
 * El filtro real es un regex de Postgres (`!~*`) con límite de palabra
 * explícito `(^|[^a-z0-9])...([^a-z0-9]|$)` — la MISMA partición de palabras
 * que el frontend (esImpuestoNoOperativo separa por [^a-z0-9], guion bajo
 * incluido). El regex es sintaxis común JS/Postgres, así que aquí se prueba
 * TAL CUAL, sin traducción.
 */
const { IMPUESTOS_NO_OPERATIVOS_REGEX, condicionGastosOperativosSql } = require('../../src/utils/gastosOperativos');

const re = new RegExp(IMPUESTOS_NO_OPERATIVOS_REGEX, 'i');

describe('gastos operativos — impuestos NO operativos (excluidos)', () => {
    test('excluye IVA / IGIC / IRPF / Sociedades', () => {
        ['IVA', 'IGIC', 'IRPF', 'Sociedades', 'Impuesto de Sociedades',
         'IVA repercutido', 'iva 1T'].forEach(c => {
            expect(re.test(c)).toBe(true);
        });
    });

    test('guion bajo separa palabras (igual que el frontend): "iva_trimestral" se excluye', () => {
        ['iva_trimestral', 'IRPF_autonomo', 'pago_iva'].forEach(c => {
            expect(re.test(c)).toBe(true);
        });
    });

    test('MANTIENE el IAE, IBI y los gastos de explotación (NO son no operativos)', () => {
        ['IAE', 'IBI', 'Nóminas', 'Seguridad Social', 'Alquiler', 'Tasa basura',
         'Cuota préstamo', 'Luz', 'Seguro local', 'Licencia'].forEach(c => {
            expect(re.test(c)).toBe(false);
        });
    });

    test('token dentro de otra palabra NO matchea (privada, derivado)', () => {
        ['Privada', 'Derivado', 'Estivador'].forEach(c => {
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
