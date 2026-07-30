/**
 * Los tres flujos OCR tienen que casar los nombres IGUAL.
 *
 * Hay tres puertas por las que entra un albarán leído por OCR: el parse de la
 * foto, el alta de líneas pendientes y el bulk legacy de n8n. Las dos primeras
 * usaban ya `matchIngrediente` (comparación por palabras); la tercera se quedó
 * con un matcheo antiguo que normalizaba BORRANDO la puntuación y comparaba la
 * cadena entera por igualdad o inclusión.
 *
 * Eso fallaba por los dos lados:
 *  - de menos: "ATUN AC.GIR.SERVIHOSTEL" quedaba como "atunacgirservihostel"
 *    —al borrar los puntos las palabras se pegan— y no casaba con "Atún";
 *  - de más: "sal" está contenido en "salmon", así que una línea de sal podía
 *    acabar sumando stock de salmón.
 *
 * Y sobre todo: la MISMA foto casaba distinto según por dónde entrara.
 */
const fs = require('fs');
const path = require('path');
const { matchIngrediente } = require('../../src/utils/ingredientMatcher');

const RUTA = path.join(__dirname, '..', '..', 'src', 'routes', 'balance.routes.js');
const fuente = fs.readFileSync(RUTA, 'utf8');

describe('Ningún flujo OCR se queda con matcheo propio', () => {
    test('hay tres llamadas a matchIngrediente, una por flujo', () => {
        const llamadas = (fuente.match(/matchIngrediente\s*\(/g) || []).length;
        // 3 llamadas + 1 del require = el require no lleva paréntesis pegado,
        // así que aquí sólo cuentan las invocaciones.
        expect(llamadas).toBe(3);
    });

    test('no queda ningún mapa de nombres normalizados a mano', () => {
        // Los `ingredientesMap`/`aliasMap` eran el corazón del matcheo viejo.
        expect(fuente).not.toMatch(/\bingredientesMap\b/);
        expect(fuente).not.toMatch(/\baliasMap\b/);
    });

    test('nadie casa ingredientes comparando por inclusión de cadena', () => {
        // El patrón exacto que casaba "sal" con "salmón".
        expect(fuente).not.toMatch(/nombreDB\.includes\(|aliasNombre\.includes\(/);
    });

    test('el bulk legacy construye candidatos como los otros dos', () => {
        const i = fuente.indexOf("router.post('/daily/purchases/bulk'");
        expect(i).toBeGreaterThan(-1);
        const cuerpo = fuente.slice(i, i + 4000);
        expect(cuerpo).toContain('candidatosMatch');
        expect(cuerpo).toContain('matchIngrediente');
    });

    test('el bulk sigue excluyendo alias de ingredientes borrados', () => {
        // Sin esto, un alias que apunta a un ingrediente soft-deleted revive
        // datos zombi metiéndoles compras.
        const i = fuente.indexOf("router.post('/daily/purchases/bulk'");
        const cuerpo = fuente.slice(i, i + 4000);
        expect(cuerpo).toMatch(/i\.deleted_at IS NULL/);
    });
});

/**
 * Los casos de albarán real (puntuación pegada, abreviaturas, erratas del OCR)
 * ya están cubiertos en `ingredientMatcher.test.js`, que es donde vive el
 * helper. Aquí solo se fija el fallo que traía el matcheo VIEJO de este
 * endpoint y que la comparación por palabras corrige: casar de más por
 * inclusión de cadena.
 */
describe('El falso positivo que provocaba comparar por inclusión', () => {
    const CATALOGO = [
        { id: 1, nombre: 'Sal marina' },
        { id: 2, nombre: 'Salmón fresco' },
    ];

    test('una línea de sal NO acaba sumando stock de salmón', () => {
        // El matcheo viejo hacía `'salmon'.includes('sal')` → casaba salmón.
        // A precio de salmón y contra su stock.
        expect(matchIngrediente('SAL MARINA GRUESA 1KG', CATALOGO)?.id).toBe(1);
    });

    test('un producto que no está en el catálogo no casa con nada', () => {
        // Preferimos dejarlo sin asignar —el humano lo revisa antes de
        // consolidar— a inventar un ingrediente.
        expect(matchIngrediente('DETERGENTE INDUSTRIAL', CATALOGO)).toBeNull();
    });
});
