const { ALERGENOS_CODES, sanitizeAlergenos } = require('../../src/utils/alergenos');

describe('sanitizeAlergenos', () => {
    test('14 códigos UE canónicos', () => {
        expect(ALERGENOS_CODES).toHaveLength(14);
        expect(ALERGENOS_CODES).toEqual(expect.arrayContaining(['gluten', 'pescado', 'moluscos', 'frutos_cascara']));
    });

    test('deja solo códigos válidos, en minúscula, sin duplicados y en orden canónico', () => {
        expect(sanitizeAlergenos(['PESCADO', 'gluten', 'pescado'])).toEqual(['gluten', 'pescado']);
    });

    test('descarta códigos inventados o basura (no guarda nada raro)', () => {
        expect(sanitizeAlergenos(['pescado', 'inventado', 'xxx', ''])).toEqual(['pescado']);
        expect(sanitizeAlergenos(['nuez'])).toEqual([]); // 'nuez' no es código canónico (es frutos_cascara)
    });

    test('entrada no-array → [] (nunca revienta)', () => {
        expect(sanitizeAlergenos(null)).toEqual([]);
        expect(sanitizeAlergenos(undefined)).toEqual([]);
        expect(sanitizeAlergenos('pescado')).toEqual([]);
        expect(sanitizeAlergenos({})).toEqual([]);
    });

    test('array vacío → []', () => {
        expect(sanitizeAlergenos([])).toEqual([]);
    });
});
