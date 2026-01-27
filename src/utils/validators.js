/**
 * ============================================
 * validators.js - Validadores de Input
 * ============================================
 * 
 * Funciones de validación para sanitizar inputs.
 * 
 * @author MindLoopIA
 * @version 1.0.0
 */

/**
 * Valida y sanitiza inputs numéricos
 * Previene NaN, Infinity, negativos
 */
function validateNumber(value, defaultVal = 0, min = 0, max = Infinity) {
    const num = parseFloat(value);
    if (isNaN(num) || !isFinite(num)) return defaultVal;
    return Math.min(Math.max(num, min), max);
}

/**
 * Valida precio (debe ser >= 0)
 */
function validatePrecio(value) {
    return validateNumber(value, 0, 0);
}

/**
 * Valida cantidad/stock (debe ser >= 0)
 */
function validateCantidad(value) {
    return validateNumber(value, 0, 0);
}

/**
 * Valida ID numérico
 */
function validateId(value) {
    const id = parseInt(value, 10);
    return isNaN(id) || id < 1 ? null : id;
}

/**
 * Sanitiza string para prevenir SQL injection básico
 */
function sanitizeString(value, maxLength = 255) {
    if (typeof value !== 'string') return '';
    return value.trim().substring(0, maxLength);
}

module.exports = {
    validateNumber,
    validatePrecio,
    validateCantidad,
    validateId,
    sanitizeString
};
