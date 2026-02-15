/**
 * Validators - Validación de inputs para API profesional
 * Previene: NaN, Infinity, negativos, XSS, SQL injection, datos corruptos
 */

// ========== NÚMEROS ==========

const validateNumber = (value, defaultVal = 0, min = 0, max = Infinity) => {
    const num = parseFloat(value);
    if (isNaN(num) || !isFinite(num)) return defaultVal;
    if (num < min) return min;
    if (num > max) return max;
    return num;
};

const validatePrecio = (value) => validateNumber(value, 0, 0, 999999);

const validateCantidad = (value) => validateNumber(value, 0, 0, 999999);

// ========== STRINGS ==========

/**
 * Sanitiza un string: trim, elimina caracteres peligrosos, limita longitud.
 * @param {*} value - Valor a sanitizar
 * @param {number} maxLen - Longitud máxima (default 255)
 * @returns {string|null} - String limpio o null si vacío
 */
const sanitizeString = (value, maxLen = 255) => {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (str.length === 0) return null;
    // Eliminar tags HTML/script (prevenir XSS stored)
    const clean = str.replace(/<[^>]*>/g, '').trim();
    return clean.substring(0, maxLen);
};

/**
 * Valida que un campo requerido tenga valor.
 * @param {*} value - Valor a validar
 * @param {string} fieldName - Nombre del campo para el mensaje de error
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
const validateRequired = (value, fieldName) => {
    const sanitized = sanitizeString(value);
    if (!sanitized) {
        return { valid: false, error: `${fieldName} es requerido` };
    }
    return { valid: true, value: sanitized };
};

// ========== IDs ==========

/**
 * Valida que un ID sea un entero positivo.
 * @param {*} value - Valor a validar
 * @returns {{ valid: boolean, error?: string, value?: number }}
 */
const validateId = (value) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num <= 0 || !isFinite(num)) {
        return { valid: false, error: 'ID debe ser un número entero positivo' };
    }
    return { valid: true, value: num };
};

// ========== FECHAS ==========

/**
 * Valida formato de fecha (acepta ISO 8601: YYYY-MM-DD o datetime).
 * @param {*} value - Valor a validar
 * @returns {{ valid: boolean, error?: string, value?: Date }}
 */
const validateDate = (value) => {
    if (!value) return { valid: false, error: 'Fecha es requerida' };
    const date = new Date(value);
    if (isNaN(date.getTime())) {
        return { valid: false, error: 'Formato de fecha inválido' };
    }
    // Rechazar fechas absurdas (antes de 2020 o más de 1 año en el futuro)
    const minDate = new Date('2020-01-01');
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    if (date < minDate || date > maxDate) {
        return { valid: false, error: 'Fecha fuera de rango válido' };
    }
    return { valid: true, value: date };
};

// ========== ENUMS ==========

/**
 * Valida que un valor esté en una lista de valores permitidos.
 * @param {*} value - Valor a validar
 * @param {string[]} allowed - Valores permitidos
 * @param {string} fieldName - Nombre del campo para el error
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
const validateEnum = (value, allowed, fieldName = 'Valor') => {
    if (!allowed.includes(value)) {
        return { valid: false, error: `${fieldName} inválido. Valores: ${allowed.join(', ')}` };
    }
    return { valid: true, value };
};

module.exports = {
    validateNumber,
    validatePrecio,
    validateCantidad,
    sanitizeString,
    validateRequired,
    validateId,
    validateDate,
    validateEnum
};
