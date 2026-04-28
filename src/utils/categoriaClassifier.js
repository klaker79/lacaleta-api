/**
 * ════════════════════════════════════════════════════
 * 🏷️ Categoria Classifier — single source of truth
 * ════════════════════════════════════════════════════
 *
 * Clasificación canónica de categorías de receta/ingrediente para reportes
 * de food cost (food / beverage / otros). Resuelve la divergencia detectada
 * en la auditoría 2026-04-28 (S1, R4, A1-C5):
 *
 *   • chatService.resumen_pyg (chatService.js:599-602) metía `'base'` y
 *     `'suministro'` en el bucket BEVERAGE.
 *   • analytics.pnl-breakdown (analytics.routes.js:277-281) las metía en
 *     OTROS y solo aceptaba `'preparacion(es) base'` literal.
 *   • analysis.menu-engineering (analysis.routes.js:28) excluía un superset
 *     de categorías que tampoco coincidía con los otros dos.
 *
 * Resultado: Iker preguntaba al chat por food cost de bebidas y veía un
 * número distinto al del dashboard para la misma receta.
 *
 * Principio de la nueva clasificación:
 *   - La clasificación es POR CATEGORÍA de la receta/ingrediente.
 *   - Comparación case-insensitive y `trim()` de espacios.
 *   - Aceptamos sinónimos (singular/plural, con/sin acento) porque la base
 *     de datos legacy tiene mezclados `'bebida'`, `'bebidas'`, `'base'`,
 *     `'preparacion base'`, `'preparaciones base'`, `'suministro'`,
 *     `'suministros'`. CLAUDE.md frontend dice que las únicas válidas a
 *     futuro son `alimentos / bebidas / suministros`, pero no podemos
 *     romper datos antiguos. Cualquier nuevo sinónimo va aquí.
 *
 * Buckets:
 *   FOOD     — comida (default si la categoría no es bebida ni "otros").
 *   BEVERAGE — bebidas (vinos, cocktails, refrescos, café, infusiones).
 *   OTHER    — suministros y preparaciones base (no se cuentan en food
 *              cost porque NO se venden directamente al cliente).
 *
 * Uso típico:
 *   const { isBeverage, isOther } = require('../utils/categoriaClassifier');
 *   if (isBeverage(receta.categoria)) { ... }
 *
 * Para construir una lista SQL `NOT IN (...)` o `IN (...)` se exportan
 * `BEVERAGE_CATEGORIES` y `OTHER_CATEGORIES` (ambos arrays JS de strings)
 * que el caller puede unir y escapar antes de meter en una query.
 */

const FOOD_BUCKET = 'FOOD';
const BEVERAGE_BUCKET = 'BEVERAGE';
const OTHER_BUCKET = 'OTHER';

// Categorías canónicas conocidas (singular y plural). Acepta ambos por
// consistencia con datos heredados. Mantener en lower-case.
const BEVERAGE_CATEGORIES = ['bebidas', 'bebida'];
const OTHER_CATEGORIES = [
    'suministros',
    'suministro',
    'preparacion base',
    'preparaciones base',
    'base'
];

/**
 * Devuelve el bucket canónico (FOOD / BEVERAGE / OTHER) para una
 * categoría dada.
 *
 * @param {string|null|undefined} categoria
 * @returns {'FOOD'|'BEVERAGE'|'OTHER'}
 */
function classifyCategoria(categoria) {
    if (categoria === null || categoria === undefined) return FOOD_BUCKET;
    const c = String(categoria).toLowerCase().trim();
    if (c === '') return FOOD_BUCKET;
    if (BEVERAGE_CATEGORIES.includes(c)) return BEVERAGE_BUCKET;
    if (OTHER_CATEGORIES.includes(c)) return OTHER_BUCKET;
    return FOOD_BUCKET;
}

function isBeverage(categoria) { return classifyCategoria(categoria) === BEVERAGE_BUCKET; }
function isOther(categoria)    { return classifyCategoria(categoria) === OTHER_BUCKET; }
function isFood(categoria)     { return classifyCategoria(categoria) === FOOD_BUCKET; }

/**
 * Helper para construir una lista SQL `IN (...)` o `NOT IN (...)` con las
 * categorías que NO son food. Devuelve un string ya escapado, listo para
 * interpolar en una query SQL (no usa parámetros porque la lista es
 * estática y proviene del propio código, no del usuario).
 *
 * Ejemplo:
 *   `LOWER(COALESCE(r.categoria, '')) NOT IN (${nonFoodCategoriesSqlList()})`
 *
 * @returns {string} Lista SQL del tipo `'a', 'b', 'c'`.
 */
function nonFoodCategoriesSqlList() {
    return [...BEVERAGE_CATEGORIES, ...OTHER_CATEGORIES]
        .map(c => `'${c.replace(/'/g, "''")}'`)
        .join(', ');
}

/**
 * Lista SQL escapada solo para BEVERAGE.
 * @returns {string}
 */
function beverageCategoriesSqlList() {
    return BEVERAGE_CATEGORIES
        .map(c => `'${c.replace(/'/g, "''")}'`)
        .join(', ');
}

/**
 * Lista SQL escapada solo para OTHER.
 * @returns {string}
 */
function otherCategoriesSqlList() {
    return OTHER_CATEGORIES
        .map(c => `'${c.replace(/'/g, "''")}'`)
        .join(', ');
}

module.exports = {
    FOOD_BUCKET,
    BEVERAGE_BUCKET,
    OTHER_BUCKET,
    BEVERAGE_CATEGORIES,
    OTHER_CATEGORIES,
    classifyCategoria,
    isBeverage,
    isOther,
    isFood,
    nonFoodCategoriesSqlList,
    beverageCategoriesSqlList,
    otherCategoriesSqlList
};
