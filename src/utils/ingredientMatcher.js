'use strict';

/**
 * Matcheo de nombres leídos por OCR (albarán/factura) contra el catálogo de
 * ingredientes/alias del restaurante.
 *
 * El OCR devuelve el nombre "sucio": con puntuación pegada ("ATUN AC.GIR.SERVIHOSTEL"),
 * códigos de formato ("12/800G", "12/0.5L"), abreviaturas ("GIR." por "GIRASOL") y
 * erratas ("GASEOGA" por "GASEOSA"). El matcheo antiguo (igualdad/inclusión de la
 * cadena entera) fallaba con todo eso. Aquí comparamos por PALABRAS significativas,
 * tolerando formato, puntuación, abreviaturas y pequeñas erratas.
 *
 * Sólo sugiere: el humano revisa antes de consolidar, así que preferimos casar de
 * más (con un umbral prudente) a dejar líneas sin asignar.
 */

// Palabras que no identifican al producto (unidades, envases, relleno). El OCR las
// añade a menudo. No cuentan para el matcheo.
const STOPWORDS = new Set([
    'de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'para', 'al', 'y', 'o',
    'und', 'ud', 'uds', 'unid', 'unidad', 'unidades', 'caja', 'cajas', 'cja',
    'bote', 'botes', 'pack', 'packs', 'bolsa', 'bolsas', 'lata', 'latas',
    'botella', 'botellas', 'bot', 'saco', 'sacos', 'bandeja', 'bandejas', 'barqueta',
    'kg', 'kgs', 'kilo', 'kilos', 'g', 'gr', 'grs', 'gramo', 'gramos',
    'l', 'lt', 'lts', 'litro', 'litros', 'ml', 'cl', 'cc', 'x', 'ud',
]);

// Minúsculas, sin acentos, y la puntuación pasa a ESPACIO (no se borra, para no
// pegar palabras: "ac.gir.servihostel" -> "ac gir servihostel").
function normalizar(str) {
    return (str || '')
        .toString()
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Palabras significativas: descarta números y códigos de formato (empiezan por dígito:
// "12", "800g", "0", "5l"), stopwords y palabras de una sola letra.
function tokens(str) {
    return normalizar(str)
        .split(' ')
        .filter(tk => tk && tk.length >= 2 && !STOPWORDS.has(tk) && !/^\d/.test(tk));
}

// Distancia de edición (Levenshtein), para tolerar erratas del OCR: gaseoga~gaseosa.
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return prev[n];
}

// ¿Dos palabras "casan"? igual, una prefijo de la otra (>=3 chars: "gir" -> "girasol"),
// o muy parecidas (Levenshtein pequeño según longitud, para erratas del OCR).
function tokenCasan(a, b) {
    if (a === b) return true;
    const min = Math.min(a.length, b.length);
    if (min >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
    const d = levenshtein(a, b);
    if (min >= 8) return d <= 2;
    if (min >= 5) return d <= 1;
    return false;
}

// Puntuación 0..1: proporción de palabras del NOMBRE del catálogo cubiertas por el
// texto del OCR. (Comparamos contra el nombre del catálogo, que es el "limpio".)
function score(tokensOCR, tokensNombre) {
    if (!tokensNombre.length || !tokensOCR.length) return 0;
    let cubiertos = 0;
    for (const tn of tokensNombre) {
        if (tokensOCR.some(to => tokenCasan(to, tn))) cubiertos++;
    }
    return cubiertos / tokensNombre.length;
}

/**
 * Casa un nombre del OCR con el mejor candidato del catálogo.
 * @param {string} nombreOCR         Nombre leído por el OCR.
 * @param {Array<{id:number, nombre:string}>} candidatos  Ingredientes y/o alias
 *        (para un alias, `id` es el ingrediente_id y `nombre` es el texto del alias).
 * @param {{umbral?:number}} [opts]
 * @returns {{id:number, score:number}|null}  Mejor match por encima del umbral, o null.
 */
function matchIngrediente(nombreOCR, candidatos, opts = {}) {
    const umbral = opts.umbral != null ? opts.umbral : 0.6;
    const tOCR = tokens(nombreOCR);
    if (!tOCR.length) return null;
    let best = null;
    for (const c of (candidatos || [])) {
        const tN = tokens(c.nombre);
        if (!tN.length) continue;
        const s = score(tOCR, tN);
        // Nº de palabras del catálogo cubiertas. Para nombres de varias palabras
        // exigimos >=2 cubiertas (no basta una palabra genérica compartida, tipo la
        // marca "servihostel"); para nombres de una sola palabra basta esa.
        const cubiertos = Math.round(s * tN.length);
        const minCubiertos = tN.length >= 2 ? 2 : 1;
        if (s >= umbral && cubiertos >= minCubiertos) {
            // Mejor score; a igualdad, el nombre más específico (más palabras).
            if (!best || s > best.score || (s === best.score && tN.length > best.tokens)) {
                best = { id: c.id, score: s, tokens: tN.length };
            }
        }
    }
    return best ? { id: best.id, score: best.score } : null;
}

module.exports = { matchIngrediente, normalizar, tokens, tokenCasan, levenshtein, score };
