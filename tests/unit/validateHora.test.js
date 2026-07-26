/**
 * Tests de validateHora — hora de entrada por empleado (2026-07-26).
 *
 * Postgres devuelve las columnas TIME como 'HH:MM:SS' pero el frontend usa
 * <input type="time"> ('HH:MM'). El validador acepta ambas formas y normaliza
 * SIEMPRE a 'HH:MM', que es lo que el generador de horarios mete en los turnos.
 */
const { validateHora } = require('../../src/utils/validators');

describe('validateHora', () => {
    describe('acepta y normaliza a HH:MM', () => {
        test.each([
            ['10:00', '10:00'],
            ['11:30', '11:30'],       // el caso de Fran en La Nave 5
            ['11:30:00', '11:30'],    // como lo devuelve Postgres (TIME)
            ['09:05:30', '09:05'],    // descarta los segundos
            ['9:05', '09:05'],        // rellena con cero a la izquierda
            ['00:00', '00:00'],
            ['23:59', '23:59'],
            ['  08:15  ', '08:15']    // tolera espacios
        ])('%s → %s', (entrada, esperado) => {
            const r = validateHora(entrada);
            expect(r.valid).toBe(true);
            expect(r.value).toBe(esperado);
        });
    });

    describe('rechaza valores inválidos', () => {
        test.each([
            [null], [undefined], [''],
            ['24:00'],        // hora fuera de rango
            ['10:60'],        // minutos fuera de rango
            ['25:30'],
            ['abc'],
            ['10'],           // sin minutos
            ['10:5'],         // minutos de un dígito
            ['10-30'],
            ['10:00 PM'],
            ["10:00'; DROP TABLE empleados; --"]
        ])('%p es inválido', (entrada) => {
            const r = validateHora(entrada);
            expect(r.valid).toBe(false);
            expect(r.error).toBeTruthy();
            expect(r.value).toBeUndefined();
        });
    });

    test('nunca devuelve un valor que Postgres no pueda castear a TIME', () => {
        const entradas = ['10:00', '11:30:00', '9:05', '23:59', '00:00:00'];
        for (const entrada of entradas) {
            const r = validateHora(entrada);
            expect(r.value).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        }
    });
});
