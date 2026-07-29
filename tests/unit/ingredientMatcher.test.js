'use strict';

const { matchIngrediente, tokens, tokenCasan } = require('../../src/utils/ingredientMatcher');

// Catálogo de ejemplo (nombres "limpios" como los guarda la app).
const CATALOGO = [
    { id: 1, nombre: 'ATUN GIRASOL SERVIHOSTEL' },
    { id: 2, nombre: 'GASEOSA SERVIHOSTEL' },
    { id: 3, nombre: 'ARROZ SOS' },
    { id: 4, nombre: 'Harina de mandioca' },
    { id: 5, nombre: 'Dulce de leche' },
];

describe('ingredientMatcher — casos reales del albarán SERVIHOSTEL', () => {
    test('ATUN AC.GIR.SERVIHOSTEL 12/800G → ATUN GIRASOL SERVIHOSTEL (puntuación pegada + abreviatura + formato)', () => {
        expect(matchIngrediente('ATUN AC.GIR.SERVIHOSTEL 12/800G', CATALOGO)?.id).toBe(1);
    });

    test('GASEOGA SERVIHOSTEL 12/0.5L → GASEOSA SERVIHOSTEL (errata OCR + formato)', () => {
        expect(matchIngrediente('GASEOGA SERVIHOSTEL 12/0.5L', CATALOGO)?.id).toBe(2);
    });

    test('ARROZ 1 SOS 12/1KG → ARROZ SOS (ruido numérico + formato)', () => {
        expect(matchIngrediente('ARROZ 1 SOS 12/1KG', CATALOGO)?.id).toBe(3);
    });

    test('HARINA DE MANDIOCA 5KG → Harina de mandioca (stopword + formato)', () => {
        expect(matchIngrediente('HARINA DE MANDIOCA 5KG', CATALOGO)?.id).toBe(4);
    });
});

describe('ingredientMatcher — no debe casar de más', () => {
    test('producto totalmente ajeno → null', () => {
        expect(matchIngrediente('COCA COLA ZERO 24/33CL', CATALOGO)).toBeNull();
    });

    test('una sola palabra genérica compartida (marca) no basta', () => {
        // Solo "servihostel" en común con ATUN/GASEOSA → no debe casar ninguno.
        expect(matchIngrediente('MAYONESA SERVIHOSTEL 12/450ML', CATALOGO)).toBeNull();
    });

    test('texto vacío o sólo formato → null', () => {
        expect(matchIngrediente('12/800G', CATALOGO)).toBeNull();
        expect(matchIngrediente('', CATALOGO)).toBeNull();
    });
});

describe('ingredientMatcher — alias', () => {
    test('casa contra un alias aprendido', () => {
        const conAlias = [...CATALOGO, { id: 2, nombre: 'gaseosa serviho' }];
        expect(matchIngrediente('GASEOSA SERVIHO 12/1L', conAlias)?.id).toBe(2);
    });
});

describe('tokens / tokenCasan (unidad)', () => {
    test('tokens descarta formato, números y stopwords', () => {
        expect(tokens('ATUN AC.GIR.SERVIHOSTEL 12/800G')).toEqual(['atun', 'ac', 'gir', 'servihostel']);
        expect(tokens('HARINA DE MANDIOCA 5KG')).toEqual(['harina', 'mandioca']);
    });

    test('tokenCasan: abreviatura por prefijo y errata por Levenshtein', () => {
        expect(tokenCasan('gir', 'girasol')).toBe(true);   // prefijo
        expect(tokenCasan('gaseoga', 'gaseosa')).toBe(true); // errata (Lev 1)
        expect(tokenCasan('atun', 'aceite')).toBe(false);
    });
});
