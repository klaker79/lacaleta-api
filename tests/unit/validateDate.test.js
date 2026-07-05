// validateDate — candado anti-fecha-futura (dedazo 30-07, incidente 2026-07-05).
// allowFuture:false rechaza el futuro (con 1 día de margen por TZ) pero SIEMPRE
// permite fechas pasadas/retroactivas (meter una compra olvidada es válido).
// Default allowFuture:true conserva el comportamiento previo (rangos de informe).
const { validateDate } = require('../../src/utils/validators');

// Helpers de fecha relativos a hoy (sin literales para no romper con el tiempo).
const dISO = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
};

describe('validateDate — default (allowFuture:true, retrocompatible)', () => {
    test('fecha pasada válida', () => {
        expect(validateDate('2025-01-15').valid).toBe(true);
    });
    test('futuro a 25 días SIGUE permitido con el default (rango de informe)', () => {
        expect(validateDate(dISO(25)).valid).toBe(true);
    });
    test('futuro a más de 1 año rechazado', () => {
        expect(validateDate(dISO(400)).valid).toBe(false);
    });
    test('antes de 2020 rechazado', () => {
        expect(validateDate('2019-12-31').valid).toBe(false);
    });
    test('formato inválido rechazado', () => {
        expect(validateDate('no-soy-fecha').valid).toBe(false);
    });
    test('vacío rechazado', () => {
        expect(validateDate('').valid).toBe(false);
        expect(validateDate(null).valid).toBe(false);
    });
});

describe('validateDate — allowFuture:false (compras/recepciones)', () => {
    test('HOY permitido', () => {
        expect(validateDate(dISO(0), { allowFuture: false }).valid).toBe(true);
    });
    test('AYER / retroactiva permitida (compra olvidada)', () => {
        expect(validateDate(dISO(-1), { allowFuture: false }).valid).toBe(true);
        expect(validateDate(dISO(-30), { allowFuture: false }).valid).toBe(true);
        expect(validateDate('2025-11-20', { allowFuture: false }).valid).toBe(true);
    });
    test('el caso del incidente: +25 días (dedazo 30-07) RECHAZADO', () => {
        const res = validateDate(dISO(25), { allowFuture: false });
        expect(res.valid).toBe(false);
        expect(res.error).toMatch(/futura/i);
    });
    test('+2 días rechazado (ya es futuro claro)', () => {
        expect(validateDate(dISO(2), { allowFuture: false }).valid).toBe(false);
    });
    test('mañana (+1 día) permitido: margen por husos horarios', () => {
        expect(validateDate(dISO(1), { allowFuture: false }).valid).toBe(true);
    });
    test('antes de 2020 sigue rechazado también con allowFuture:false', () => {
        expect(validateDate('2018-05-01', { allowFuture: false }).valid).toBe(false);
    });
});
