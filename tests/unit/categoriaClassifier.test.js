/**
 * Tests del clasificador de categorías y, en particular, de la lista de
 * exclusión semántica para Omnes (Iker 2026-06-09).
 *
 * El análisis de Omnes solo debe contar "platos principales" tal cual los
 * percibe el cliente. Categorías de extras / cargos / unidades sueltas
 * deben quedar fuera.
 */
const {
    classifyCategoria,
    isBeverage,
    isOther,
    isFood,
    isOmnesExcluded,
    omnesExcludedCategoriesSqlList,
    OMNES_EXCLUDED_CATEGORIES
} = require('../../src/utils/categoriaClassifier');

describe('categoriaClassifier — buckets existentes', () => {
    test('bebidas → BEVERAGE', () => {
        expect(classifyCategoria('bebidas')).toBe('BEVERAGE');
        expect(isBeverage('Bebida')).toBe(true);
    });
    test('suministros y base → OTHER', () => {
        expect(isOther('suministros')).toBe(true);
        expect(isOther('preparacion base')).toBe(true);
        expect(isOther('base')).toBe(true);
    });
    test('alimentos genéricos → FOOD', () => {
        expect(isFood('alimentos')).toBe(true);
        expect(isFood('principal')).toBe(true);
        expect(isFood(null)).toBe(true);   // sin categoría → FOOD por defecto
    });
});

describe('categoriaClassifier.isOmnesExcluded', () => {
    test('pincho / aperitivo / tapa / extra / guarnición / aceite → excluidos', () => {
        ['pincho', 'aperitivo', 'tapa', 'extra', 'guarnicion', 'aceite']
            .forEach(cat => {
                expect(isOmnesExcluded(cat)).toBe(true);
            });
    });
    test('plural también acepta', () => {
        ['pinchos', 'aperitivos', 'tapas', 'extras', 'guarniciones', 'aceites']
            .forEach(cat => {
                expect(isOmnesExcluded(cat)).toBe(true);
            });
    });
    test('con tilde y sin tilde', () => {
        expect(isOmnesExcluded('guarnición')).toBe(true);
        expect(isOmnesExcluded('guarnicion')).toBe(true);
    });
    test('case-insensitive y trim', () => {
        expect(isOmnesExcluded('  PINCHO  ')).toBe(true);
        expect(isOmnesExcluded('Tapa')).toBe(true);
    });
    test('bebidas, suministros y base también se excluyen', () => {
        expect(isOmnesExcluded('bebidas')).toBe(true);
        expect(isOmnesExcluded('suministros')).toBe(true);
        expect(isOmnesExcluded('base')).toBe(true);
    });
    test('platos principales → NO se excluyen', () => {
        expect(isOmnesExcluded('alimentos')).toBe(false);
        expect(isOmnesExcluded('principal')).toBe(false);
        expect(isOmnesExcluded('entrante')).toBe(false);
        expect(isOmnesExcluded('postre')).toBe(false);
        expect(isOmnesExcluded(null)).toBe(false);
        expect(isOmnesExcluded(undefined)).toBe(false);
        expect(isOmnesExcluded('')).toBe(false);
    });
});

describe('omnesExcludedCategoriesSqlList', () => {
    test('incluye las 6 categorías de Iker + bebidas + suministros/base', () => {
        const sql = omnesExcludedCategoriesSqlList();
        OMNES_EXCLUDED_CATEGORIES.forEach(cat => {
            expect(sql).toContain(`'${cat}'`);
        });
        expect(sql).toContain(`'bebidas'`);
        expect(sql).toContain(`'suministros'`);
        expect(sql).toContain(`'base'`);
    });
    test('formato SQL válido (lista separada por comas)', () => {
        const sql = omnesExcludedCategoriesSqlList();
        // Debe poder interpolarse directamente en `IN (...)`
        expect(sql).toMatch(/^'[^']+'(?:, '[^']+')+$/);
    });
});
