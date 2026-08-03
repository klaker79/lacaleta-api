/**
 * Fecha de pedido: el futuro depende del ESTADO (decisión de Iker, 2026-08-03).
 *
 *  - 'pendiente' → SÍ se permite. Es un pedido programado ("pídeme esto para el
 *    viernes"). Crear un pedido pendiente NO escribe en Diario, ni en stock, ni
 *    en precios; y al recibirlo el Diario usa la fecha de RECEPCIÓN. Una fecha
 *    futura ahí no descuadra nada.
 *  - 'recibido' → NO. Es la compra de mercado, que entra al Diario en el acto
 *    con esta misma fecha: un dedazo metería gasto en un día que no ha llegado.
 *
 * Las PASADAS se permiten siempre (meter una compra olvidada es válido).
 */
const { validateDate } = require('../../src/utils/validators');

// Misma expresión que usa el endpoint: allowFuture = !entraAlDiarioYa
const validarFechaPedido = (fecha, estado) =>
    validateDate(fecha, { allowFuture: estado !== 'recibido' });

const enDias = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
};

describe('pedido PENDIENTE: se puede programar a futuro', () => {
    test('el viernes que viene vale', () => {
        expect(validarFechaPedido(enDias(5), 'pendiente').valid).toBe(true);
    });

    test('dentro de un mes vale', () => {
        expect(validarFechaPedido(enDias(30), 'pendiente').valid).toBe(true);
    });

    // Sin `estado` el endpoint crea un pendiente: mismo trato.
    test('sin estado explícito se trata como pendiente', () => {
        expect(validarFechaPedido(enDias(5), undefined).valid).toBe(true);
    });

    // El modo laxo conserva su tope de 1 año: un dedazo gordo sigue rebotando.
    test('pero un dedazo de años sigue rechazándose', () => {
        expect(validarFechaPedido(enDias(400), 'pendiente').valid).toBe(false);
    });
});

describe('pedido RECIBIDO (compra de mercado): sin futuro', () => {
    test('mañana ya no vale', () => {
        const r = validarFechaPedido(enDias(5), 'recibido');
        expect(r.valid).toBe(false);
        expect(r.error).toBe('La fecha no puede ser futura');
    });

    // El validador da 1 día de margen por husos horarios: "hoy" en local nunca
    // puede rebotar por estar el servidor en UTC.
    test('hoy vale (y el margen de husos lo protege)', () => {
        expect(validarFechaPedido(enDias(0), 'recibido').valid).toBe(true);
    });
});

describe('las fechas pasadas se permiten en ambos casos', () => {
    test.each(['pendiente', 'recibido'])('retroactiva con estado %s', (estado) => {
        expect(validarFechaPedido(enDias(-10), estado).valid).toBe(true);
    });

    test('pero no antes de 2020', () => {
        expect(validarFechaPedido('2019-12-31', 'pendiente').valid).toBe(false);
    });
});
