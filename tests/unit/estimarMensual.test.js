// Helper de extrapolación mensual del chat. Las tools devuelven ventas de una
// ventana de N días (default 60); para hablar "al mes" hay que normalizar a 30
// días. Antes el modelo trataba el total de 60 días como mensual → cifra x2.
const { estimarMensual } = require('../../src/services/chatService');

describe('estimarMensual', () => {
    test('153 uds en 60 días → 76.5/mes (no 153)', () => {
        expect(estimarMensual(153, 60)).toBeCloseTo(76.5, 5);
    });

    test('ventana de 30 días devuelve el mismo total', () => {
        expect(estimarMensual(100, 30)).toBeCloseTo(100, 5);
    });

    test('ventana de 90 días normaliza a 30', () => {
        expect(estimarMensual(90, 90)).toBeCloseTo(30, 5);
    });

    test('dias inválidos o cero → null (no se puede extrapolar)', () => {
        expect(estimarMensual(100, 0)).toBeNull();
        expect(estimarMensual(100, -5)).toBeNull();
        expect(estimarMensual(100, NaN)).toBeNull();
        expect(estimarMensual(100, undefined)).toBeNull();
    });

    test('total no numérico → null', () => {
        expect(estimarMensual(null, 60)).toBeNull();
        expect(estimarMensual('x', 60)).toBeNull();
    });

    test('total 0 → 0 (válido)', () => {
        expect(estimarMensual(0, 60)).toBe(0);
    });
});
