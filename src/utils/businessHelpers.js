/**
 * ════════════════════════════════════════════════════
 * 📦 Business Helpers — Shared functions extracted from server.js
 * ════════════════════════════════════════════════════
 * 
 * Phase 2 refactoring: eliminates code duplication across endpoints.
 */

/**
 * I1: Calcula el precio unitario de un ingrediente, dividiendo por cantidad_por_formato si aplica.
 * Reemplaza 6 ocurrencias del mismo cálculo dispersas en server.js.
 * 
 * @param {object} ingrediente - Objeto con { precio, cantidad_por_formato }
 * @returns {number} Precio unitario
 */
function calcularPrecioUnitario(ingrediente) {
    const precio = parseFloat(ingrediente.precio) || 0;
    const cantidadPorFormato = parseFloat(ingrediente.cantidad_por_formato) || 0;
    return cantidadPorFormato > 0 ? precio / cantidadPorFormato : precio;
}

/**
 * I2: Inserta o actualiza un registro en precios_compra_diarios (upsert).
 * Reemplaza 5 ocurrencias del mismo INSERT...ON CONFLICT.
 * 
 * @param {object} client - PostgreSQL client (within transaction)
 * @param {object} params
 * @param {number} params.ingredienteId - ID del ingrediente
 * @param {Date}   params.fecha - Fecha de la compra
 * @param {number} params.precioUnitario - Precio unitario
 * @param {number} params.cantidad - Cantidad comprada
 * @param {number} params.total - Total de la compra
 * @param {number} params.restauranteId - ID del restaurante
 * @param {number|null} params.proveedorId - ID del proveedor (optional)
 * @param {number|null} params.pedidoId - ID del pedido (optional)
 */
async function upsertCompraDiaria(client, { ingredienteId, fecha, precioUnitario, cantidad, total, restauranteId, proveedorId = null, pedidoId = null }) {
    await client.query(`
        INSERT INTO precios_compra_diarios 
        (ingrediente_id, fecha, precio_unitario, cantidad_comprada, total_compra, restaurante_id, proveedor_id, pedido_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (ingrediente_id, fecha, restaurante_id, (COALESCE(pedido_id, 0)))
        DO UPDATE SET 
            precio_unitario = EXCLUDED.precio_unitario,
            cantidad_comprada = precios_compra_diarios.cantidad_comprada + EXCLUDED.cantidad_comprada,
            total_compra = precios_compra_diarios.total_compra + EXCLUDED.total_compra
    `, [ingredienteId, fecha, precioUnitario, cantidad, total, restauranteId, proveedorId, pedidoId]);
}

/**
 * Builds a price map {ingredienteId: precioUnitario} from a list of ingredients.
 * Used in menu-engineering, balance, and monthly-summary endpoints.
 * 
 * @param {Array} ingredientes - Array of {id, precio, cantidad_por_formato}
 * @returns {object} Map of ingredienteId → precioUnitario
 */
function buildIngredientPriceMap(ingredientes) {
    const map = {};
    for (const ing of ingredientes) {
        map[ing.id] = calcularPrecioUnitario(ing);
    }
    return map;
}

module.exports = { calcularPrecioUnitario, upsertCompraDiaria, buildIngredientPriceMap };
