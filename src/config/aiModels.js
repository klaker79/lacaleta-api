/**
 * ============================================
 * config/aiModels.js - Modelos de IA (fuente única)
 * ============================================
 *
 * El id del modelo de Anthropic vivía escrito a mano en 4 sitios
 * (chatService, informeMensualHtml, /sales/parse-pdf y /parse-albaran).
 * Cuando se actualizó el modelo solo se tocaron 2 de los 4, y los otros
 * dos se quedaron apuntando a `claude-sonnet-4-20250514`. Ese modelo fue
 * retirado: la API responde 404 `not_found_error`, así que
 * `POST /sales/parse-pdf` (importar las ventas del TPV desde el PDF)
 * llevaba tiempo fallando en producción sin que nadie lo relacionara.
 *
 * Con el id en un solo sitio, actualizar el modelo vuelve a ser una línea
 * y no puede quedarse ningún endpoint atrás.
 *
 * ⚠️ Antes de cambiar el id, comprobar que existe:
 *   GET https://api.anthropic.com/v1/models/<id>  → 200 (no 404)
 *
 * @module config/aiModels
 */

/**
 * Modelo por defecto para todas las llamadas a Anthropic (chat de Omnes,
 * informe mensual, lectura de PDF de ventas y OCR de albarán).
 * @type {string}
 */
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

module.exports = { ANTHROPIC_MODEL };
