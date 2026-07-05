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
    // Eliminar `<` y `>` literales para impedir cualquier tag HTML/script.
    // CodeQL alert "Incomplete multi-character sanitization" (2026-05-20):
    // la regex anterior `/<[^>]*>/g` se puede bypassear con tags anidados
    // (ej. `<scr<script>ipt>` deja contenido válido tras una pasada). Eliminar
    // los delimitadores cierra el vector sin ambigüedad — no quedan tags
    // posibles de reconstruir. Es defensa en profundidad: el frontend ya
    // escapa con escapeHTML al renderizar.
    const clean = str.replace(/[<>]/g, '').trim();
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
 *
 * @param {*} value - Valor a validar
 * @param {object} [opts]
 * @param {boolean} [opts.allowFuture=true] - Si es false, rechaza fechas en el
 *   futuro (con 1 día de margen por husos horarios). Se usa en la ENTRADA de
 *   compras/recepciones: un albarán no puede tener fecha futura (dedazo). Las
 *   fechas PASADAS/retroactivas siguen permitidas (meter una compra olvidada es
 *   un flujo válido). El default (true) conserva el comportamiento previo, así
 *   que los rangos de informe (menuEngineering) no cambian.
 * @returns {{ valid: boolean, error?: string, value?: Date }}
 */
const validateDate = (value, { allowFuture = true } = {}) => {
    if (!value) return { valid: false, error: 'Fecha es requerida' };
    const date = new Date(value);
    if (isNaN(date.getTime())) {
        return { valid: false, error: 'Formato de fecha inválido' };
    }
    // Rechazar fechas absurdas (antes de 2020).
    const minDate = new Date('2020-01-01');
    if (date < minDate) {
        return { valid: false, error: 'Fecha fuera de rango válido' };
    }
    const maxDate = new Date();
    if (allowFuture) {
        // Tope laxo: hasta 1 año vista (rangos de informe, etc.).
        maxDate.setFullYear(maxDate.getFullYear() + 1);
        if (date > maxDate) {
            return { valid: false, error: 'Fecha fuera de rango válido' };
        }
    } else {
        // Compras/recepciones: no se acepta futuro. +1 día de margen por husos
        // horarios (que "hoy" en local no lo rechace el servidor por TZ).
        maxDate.setDate(maxDate.getDate() + 1);
        if (date > maxDate) {
            return { valid: false, error: 'La fecha no puede ser futura' };
        }
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
