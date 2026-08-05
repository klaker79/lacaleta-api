/**
 * Matching de un nombre de ingrediente contra la tabla global
 * `rendimientos_estandar` (USDA SR-28, curada para hostelería española).
 *
 * Filosofía: SUGERIR con prudencia. Antes un "no encontrado" que un match malo —
 * una sugerencia equivocada quema la confianza en todas las demás.
 *
 * Orden de match:
 *  1. Exacto (normalizado) contra nombre o alias.
 *  2. El nombre del usuario CONTIENE un nombre/alias de la tabla como palabra
 *     completa ("Tomate pera rama" → "tomate"). Gana el término más largo.
 * No se hace fuzzy por letras: "calabaza"≠"calabacín".
 */

function normalizar(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // sin acentos; la ñ queda como n (ambos lados igual)
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {string} nombreUsuario - lo que el usuario tecleó ("Tomate pera")
 * @param {Array}  tabla - filas de rendimientos_estandar (nombre, aliases, ...)
 * @returns {object|null} la fila que mejor casa, o null si no hay match fiable
 */
function buscarRendimientoEstandar(nombreUsuario, tabla) {
    const usuario = normalizar(nombreUsuario);
    if (!usuario || !Array.isArray(tabla) || tabla.length === 0) return null;

    let candidato = null;
    let candidatoLen = 0;

    for (const fila of tabla) {
        const terminos = [fila.nombre, ...(Array.isArray(fila.aliases) ? fila.aliases : [])];
        for (const termino of terminos) {
            const t = normalizar(termino);
            if (!t) continue;

            // 1. Exacto: match inmediato, no hay nada mejor.
            if (t === usuario) return fila;

            // 2. Contención por palabra completa (bordes de palabra, no letras).
            const patron = new RegExp(`(^| )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
            if (patron.test(usuario) && t.length > candidatoLen) {
                candidato = fila;
                candidatoLen = t.length;
            }
        }
    }

    return candidato;
}

module.exports = { normalizar, buscarRendimientoEstandar };
