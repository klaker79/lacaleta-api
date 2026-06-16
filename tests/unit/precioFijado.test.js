// Precio fijado manual (override): cuando un ingrediente tiene precio_fijado=true,
// getBackendIngredientUnitPrice debe usar el precio MANUAL (precio/cpf) e IGNORAR
// la media de compras (precio_medio_compra). Con el flag false/ausente, comportamiento
// idéntico al actual (backward-compatible: la media manda).
const { getBackendIngredientUnitPrice } = require('../../src/utils/businessHelpers');

describe('getBackendIngredientUnitPrice — precio_fijado (override manual)', () => {
    test('fijado=true → usa precio/cpf manual, IGNORA precio_medio_compra', () => {
        const row = { precio_fijado: true, precio: 1.15, cantidad_por_formato: 1, precio_medio_compra: 2.0 };
        expect(getBackendIngredientUnitPrice(row)).toBe(1.15);
    });

    test('fijado=true con cpf>1 → precio/cpf', () => {
        const row = { precio_fijado: true, precio: 6, cantidad_por_formato: 6, precio_medio_compra: 2.0 };
        expect(getBackendIngredientUnitPrice(row)).toBe(1.0);
    });

    test('fijado=false → media de compras (comportamiento actual)', () => {
        const row = { precio_fijado: false, precio: 1.15, cantidad_por_formato: 1, precio_medio_compra: 2.0 };
        expect(getBackendIngredientUnitPrice(row)).toBe(2.0);
    });

    test('sin flag (undefined) → media de compras (backward-compatible)', () => {
        const row = { precio: 1.15, cantidad_por_formato: 1, precio_medio_compra: 2.0 };
        expect(getBackendIngredientUnitPrice(row)).toBe(2.0);
    });

    test('fijado=true pero precio inválido (0) → cae a la prioridad normal (defensivo)', () => {
        const row = { precio_fijado: true, precio: 0, cantidad_por_formato: 1, precio_medio_compra: 2.0 };
        expect(getBackendIngredientUnitPrice(row)).toBe(2.0);
    });

    test('fijado=true sin compras → precio manual (caso ingrediente nuevo fijado)', () => {
        const row = { precio_fijado: true, precio: 1.15, cantidad_por_formato: 1, precio_medio_compra: null };
        expect(getBackendIngredientUnitPrice(row)).toBe(1.15);
    });
});
