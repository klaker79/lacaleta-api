/**
 * Validators - Validación numérica segura
 * Previene NaN, Infinity, negativos
 */

const validateNumber = (value, defaultVal = 0, min = 0, max = Infinity) => {
    const num = parseFloat(value);
    if (isNaN(num) || !isFinite(num)) return defaultVal;
    if (num < min) return min;
    if (num > max) return max;
    return num;
};

const validatePrecio = (value) => validateNumber(value, 0, 0, 999999);

const validateCantidad = (value) => validateNumber(value, 0, 0, 999999);

module.exports = { validateNumber, validatePrecio, validateCantidad };
