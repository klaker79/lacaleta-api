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
 * NOTE: prefer `getBackendIngredientUnitPrice()` for recipe-cost calculations.
 * This helper only knows about `precio` and `cantidad_por_formato` (legacy).
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
 * Canonical backend equivalent of frontend `getIngredientUnitPrice()`
 * (`MindLoop-CostOS/src/utils/cost-calculator.js`). Returns the unit price
 * (€/unidad base) for an ingredient, applying the SAME priority used in the
 * frontend so dashboard, chat IA and any backend calculation agree:
 *
 *   1. row.precio_medio_compra — real weighted average from precios_compra_diarios
 *   2. row.precio_medio        — configured price / cantidad_por_formato (precomputed)
 *   3. row.precio / row.cantidad_por_formato — raw fallback
 *
 * The result is rounded to 4 decimals for parity with the SQL projections of
 * `precio_medio_compra` (`ROUND(..., 4)`).
 *
 * Use this helper EVERY time a route reads an ingredient row and needs the
 * unit price for cost/COGS aggregation. NEVER inline the priority elsewhere.
 *
 * @param {object|null} row - Ingredient row including {precio, cantidad_por_formato, precio_medio?, precio_medio_compra?}
 * @returns {number} Unit price (>= 0) rounded to 4 decimals.
 */
function getBackendIngredientUnitPrice(row) {
    if (!row) return 0;

    if (row.precio_medio_compra !== null && row.precio_medio_compra !== undefined) {
        const v = parseFloat(row.precio_medio_compra);
        if (v > 0) return Math.round(v * 10000) / 10000;
    }

    if (row.precio_medio !== null && row.precio_medio !== undefined) {
        const v = parseFloat(row.precio_medio);
        if (v > 0) return Math.round(v * 10000) / 10000;
    }

    const precio = parseFloat(row.precio);
    if (precio > 0) {
        const cpf = parseFloat(row.cantidad_por_formato) || 1;
        const fallback = cpf > 0 ? precio / cpf : precio;
        return Math.round(fallback * 10000) / 10000;
    }

    return 0;
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

/**
 * Resolves a proveedor_id from:
 *   1. Fuzzy text match on compras_pendientes.proveedor → proveedores.nombre
 *   2. Fallback: ingrediente's principal supplier from ingredientes_proveedores
 *   3. Fallback: ingrediente.proveedor_id (legacy column)
 *
 * @param {object} client - PostgreSQL client
 * @param {object} params
 * @param {string|null} params.proveedorTexto - Provider name from OCR/albaran
 * @param {number} params.ingredienteId - Ingredient ID
 * @param {number} params.restauranteId - Restaurant ID
 * @returns {number|null} proveedor_id or null
 */
async function resolveProveedorId(client, { proveedorTexto, ingredienteId, restauranteId }) {
    // 1. Try matching proveedor text against proveedores table
    if (proveedorTexto && proveedorTexto.trim()) {
        const normalizado = proveedorTexto.trim();
        const provResult = await client.query(
            `SELECT id FROM proveedores
             WHERE restaurante_id = $1 AND deleted_at IS NULL
               AND LOWER(nombre) = LOWER($2)
             LIMIT 1`,
            [restauranteId, normalizado]
        );
        if (provResult.rows.length > 0) return provResult.rows[0].id;

        // Fuzzy: check if proveedor name contains or is contained in the text
        const provFuzzy = await client.query(
            `SELECT id, nombre FROM proveedores
             WHERE restaurante_id = $1 AND deleted_at IS NULL
               AND (LOWER(nombre) LIKE '%' || LOWER($2) || '%' OR LOWER($2) LIKE '%' || LOWER(nombre) || '%')
             ORDER BY LENGTH(nombre) DESC
             LIMIT 1`,
            [restauranteId, normalizado]
        );
        if (provFuzzy.rows.length > 0) return provFuzzy.rows[0].id;
    }

    // 2. Fallback: principal supplier from ingredientes_proveedores
    const ipResult = await client.query(
        `SELECT proveedor_id FROM ingredientes_proveedores
         WHERE ingrediente_id = $1 AND es_proveedor_principal = true
         LIMIT 1`,
        [ingredienteId]
    );
    if (ipResult.rows.length > 0) return ipResult.rows[0].proveedor_id;

    // 3. Fallback: legacy proveedor_id on ingredientes
    const ingResult = await client.query(
        'SELECT proveedor_id FROM ingredientes WHERE id = $1 AND restaurante_id = $2',
        [ingredienteId, restauranteId]
    );
    if (ingResult.rows.length > 0 && ingResult.rows[0].proveedor_id) return ingResult.rows[0].proveedor_id;

    return null;
}

/**
 * Updates the price for a specific ingredient-provider relationship.
 * Called after approving a purchase to keep ingredientes_proveedores prices current.
 */
async function updateProveedorPrecio(client, { ingredienteId, proveedorId, precio }) {
    if (!proveedorId || !ingredienteId) return;
    await client.query(
        `UPDATE ingredientes_proveedores SET precio = $1
         WHERE ingrediente_id = $2 AND proveedor_id = $3`,
        [precio, ingredienteId, proveedorId]
    );
}

module.exports = { calcularPrecioUnitario, getBackendIngredientUnitPrice, upsertCompraDiaria, buildIngredientPriceMap, resolveProveedorId, updateProveedorPrecio };
