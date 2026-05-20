/**
 * Tests para sanitizeString en src/utils/validators.js.
 *
 * Específicamente prueba que el bypass de tags anidados (CodeQL alert
 * "Incomplete multi-character sanitization") está cerrado: la regex se
 * aplica en bucle hasta convergencia.
 */

const { sanitizeString } = require('../../src/utils/validators');

describe('sanitizeString (validators.js)', () => {
    test('strings normales pasan sin cambios', () => {
        expect(sanitizeString('hola')).toBe('hola');
        expect(sanitizeString('  hola  ')).toBe('hola');
    });

    test('elimina los delimitadores < y > de tags HTML', () => {
        expect(sanitizeString('<b>hola</b>')).toBe('bhola/b');
        expect(sanitizeString('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
    });

    test('cierra el bypass de tags anidados (CodeQL alert)', () => {
        // Antes la regex `/<[^>]*>/g` dejaba contenido válido. Ahora al quitar
        // `<` y `>` directamente, ningún tag HTML puede reconstruirse aguas
        // abajo aunque el atacante intente anidar marcadores.
        const result = sanitizeString('<scr<script>ipt>alert(1)</script>');
        expect(result).not.toContain('<');
        expect(result).not.toContain('>');

        const result2 = sanitizeString('<<script>script>alert(1)</script>');
        expect(result2).not.toContain('<');
        expect(result2).not.toContain('>');
    });

    test('limita longitud al maxLen indicado', () => {
        expect(sanitizeString('a'.repeat(300))).toHaveLength(255);
        expect(sanitizeString('a'.repeat(50), 20)).toHaveLength(20);
    });

    test('devuelve null para vacío/null/undefined', () => {
        expect(sanitizeString(null)).toBeNull();
        expect(sanitizeString(undefined)).toBeNull();
        expect(sanitizeString('')).toBeNull();
        expect(sanitizeString('   ')).toBeNull();
    });

    test('convierte no-strings a string', () => {
        expect(sanitizeString(42)).toBe('42');
        expect(sanitizeString(true)).toBe('true');
    });
});
