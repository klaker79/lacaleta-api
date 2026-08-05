/**
 * Matching del rendimiento estándar (USDA SR-28) contra lo que un chef teclea.
 *
 * Filosofía blindada aquí: antes un "no encontrado" que un match malo — una
 * sugerencia equivocada quema la confianza en todas las demás. Por eso NO hay
 * fuzzy por letras (calabaza≠calabacín) y la contención es por palabra entera.
 */
const { buscarRendimientoEstandar, normalizar } = require('../../src/utils/rendimientoEstandar');
const seed = require('../../src/db/rendimientosEstandarSeed');

describe('normalizar', () => {
    test('minúsculas, sin acentos, espacios colapsados', () => {
        expect(normalizar('  Espárrago   VERDE ')).toBe('esparrago verde');
        expect(normalizar('Calabacín')).toBe('calabacin');
    });
    test('la ñ se normaliza a n en AMBOS lados — "piña" sigue encontrando a Piña', () => {
        expect(normalizar('Piña')).toBe('pina');
        expect(buscarRendimientoEstandar('piña', seed)?.nombre).toBe('Piña');
    });
});

describe('buscarRendimientoEstandar (contra el seed REAL de 70 entradas)', () => {
    const buscar = (n) => buscarRendimientoEstandar(n, seed);

    test('match exacto: Alcachofa → 40% (el dato que cualquier chef firma)', () => {
        expect(buscar('Alcachofa')?.rendimiento).toBe(40);
    });

    test('con acentos y mayúsculas: ESPÁRRAGO VERDE', () => {
        expect(buscar('ESPÁRRAGO VERDE')?.rendimiento).toBe(53);
    });

    test('por alias: "papa" encuentra Patata', () => {
        expect(buscar('papa')?.nombre).toBe('Patata');
    });

    test('nombre compuesto del usuario: "Tomate pera rama" casa con Tomate', () => {
        expect(buscar('Tomate pera de rama')?.nombre).toBe('Tomate');
    });

    test('gana el término MÁS LARGO: "lomo de cerdo" → Lomo entero, no otro corte', () => {
        expect(buscar('lomo de cerdo fresco')?.nombre).toBe('Lomo de cerdo entero');
    });

    describe('prudencia: mejor null que un match malo', () => {
        test('calabaza no casa con calabacín (ni al revés)', () => {
            expect(buscar('calabaza violín')?.nombre).toBe('Calabaza');
            expect(buscar('calabacines baby')?.nombre).toBe('Calabacín');
        });
        test('lo desconocido devuelve null, no el parecido', () => {
            expect(buscar('coca-cola 33cl')).toBeNull();
            expect(buscar('pulpo')).toBeNull(); // pescado = fase 2, sin datos NO se sugiere
            expect(buscar('')).toBeNull();
        });
        test('contención por PALABRA entera, no por letras: "ajo" no casa dentro de "tasajo"', () => {
            expect(buscar('tasajo curado')).toBeNull();
        });
    });

    describe('sanidad del seed completo', () => {
        test('70 entradas, todas con fuente USDA y rendimiento 1-99', () => {
            expect(seed.length).toBe(70);
            for (const e of seed) {
                expect(e.fuente).toMatch(/^USDA SR-28 #\d+$/);
                expect(e.rendimiento).toBeGreaterThan(0);
                expect(e.rendimiento).toBeLessThan(100);
                expect(['verdura', 'fruta', 'carne', 'marisco']).toContain(e.familia);
            }
        });
        test('sin nombres duplicados', () => {
            const nombres = seed.map(e => normalizar(e.nombre));
            expect(new Set(nombres).size).toBe(nombres.length);
        });
        test('cada entrada del seed se encuentra a sí misma por nombre', () => {
            for (const e of seed) {
                expect(buscarRendimientoEstandar(e.nombre, seed)?.nombre).toBe(e.nombre);
            }
        });
    });
});
