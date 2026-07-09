/**
 * Alérgenos UE — 14 códigos canónicos (minúscula, sin acentos). Fuente única
 * en el backend, espejo de los del frontend (src/modules/ingredientes/alergenos.js).
 * Reglamento UE 1169/2011 / RD 126/2015.
 */
const ALERGENOS_CODES = [
    'gluten', 'crustaceos', 'huevos', 'pescado', 'cacahuetes', 'soja',
    'lacteos', 'frutos_cascara', 'apio', 'mostaza', 'sesamo', 'sulfitos',
    'altramuces', 'moluscos'
];

const _SET = new Set(ALERGENOS_CODES);

/**
 * Sanea un array de alérgenos: deja SOLO códigos canónicos válidos, en
 * minúscula, sin duplicados y en el orden canónico. Cualquier cosa que no sea
 * un array o no reconocida se descarta → nunca guardamos basura ni códigos
 * inventados. Devuelve SIEMPRE un array (vacío si no hay nada válido).
 * @param {*} arr
 * @returns {string[]}
 */
function sanitizeAlergenos(arr) {
    if (!Array.isArray(arr)) return [];
    const vistos = new Set();
    for (const a of arr) {
        const code = String(a || '').trim().toLowerCase();
        if (_SET.has(code)) vistos.add(code);
    }
    // Orden canónico estable.
    return ALERGENOS_CODES.filter(c => vistos.has(c));
}

module.exports = { ALERGENOS_CODES, sanitizeAlergenos };
