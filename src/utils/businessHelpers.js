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
 * Expande una receta a sus ingredientes BASE (no subrecetas), resolviendo recursivamente.
 * Convención: ingredienteId >= 100000 codifica una subreceta (recetaId = ingredienteId - 100000).
 * La cantidad en un escandallo con subreceta representa "porciones de subreceta".
 *
 * Originalmente vivía en `sales.routes.js` y solo se usaba para descontar stock al cerrar
 * ventas (POST /sales, POST /sales/bulk, DELETE /sales fallback). Movida aquí en Capa 3 de
 * la auditoría 2026-04-28 para poder reutilizarla también desde el helper canónico de coste
 * de receta backend (`getRecipeCostBase`) — el frontend ya expandía subrecetas para coste
 * (recetas-crud.js calcularCosteRecetaCompleto) pero el backend no, lo que causaba que el
 * COGS de recetas con preparación base se subestimara (food cost falso óptimo).
 *
 * @param {object} receta - Receta con { id, porciones, ingredientes }
 * @param {object} client - Cliente PostgreSQL (puede ser pool o connection dentro de transacción)
 * @param {number} restauranteId - ID del restaurante (multi-tenant)
 * @param {Set<number>} [visited] - Set interno para detectar ciclos
 * @returns {Promise<Array<{ingredienteId:number, cantidadPorPorcion:number}>>}
 *          Mapa de ingredientes BASE con cuánto se gasta de cada uno por CADA porción
 *          vendida de la receta raíz.
 */
async function expandRecipeToBase(receta, client, restauranteId, visited = new Set()) {
    if (!receta || visited.has(receta.id)) return [];
    visited.add(receta.id);
    const porciones = Math.max(1, parseInt(receta.porciones) || 1);
    const items = receta.ingredientes || [];
    const acc = new Map();
    for (const ing of items) {
        const ingId = ing.ingredienteId || ing.ingrediente_id || ing.ingredientId || ing.id;
        const cantidad = parseFloat(ing.cantidad ?? ing.quantity) || 0;
        if (!ingId || cantidad <= 0) continue;
        if (ingId > 100000) {
            const subRecetaId = ingId - 100000;
            const subRes = await client.query(
                'SELECT id, porciones, ingredientes FROM recetas WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [subRecetaId, restauranteId]
            );
            if (subRes.rows.length === 0) {
                // Subreceta no encontrada (posible borrado soft o tenant cruzado): la ignoramos
                // silenciosamente para no romper la venta. Caller puede loguear si lo necesita.
                continue;
            }
            const subExpanded = await expandRecipeToBase(subRes.rows[0], client, restauranteId, new Set(visited));
            const factor = cantidad / porciones;
            for (const it of subExpanded) {
                acc.set(it.ingredienteId, (acc.get(it.ingredienteId) || 0) + it.cantidadPorPorcion * factor);
            }
        } else {
            acc.set(ingId, (acc.get(ingId) || 0) + cantidad / porciones);
        }
    }
    return Array.from(acc.entries()).map(([ingredienteId, cantidadPorPorcion]) => ({ ingredienteId, cantidadPorPorcion }));
}

/**
 * Canonical backend cost-of-recipe helper. Mirrors frontend
 * `calcularCosteRecetaCompleto` (recetas-crud.js:211-262):
 *   - Expands subrecetas recursively via `expandRecipeToBase` so subreceta
 *     ingredientes (ingredienteId > 100000) resolve to base ingredients
 *     instead of contributing 0 (the bug Capa 3 closes).
 *   - Applies rendimiento per-line (`costeReal = precio / (rendimiento/100)`),
 *     falling back to the ingrediente-base rendimiento if not stored on the
 *     recipe line.
 *   - Returns coste TOTAL del lote (en €/receta), NO €/porción. The caller
 *     divides by `receta.porciones` if it wants coste por porción.
 *
 * The returned number cuadra con el frontend para el mismo input (recipe +
 * preciosMap), siempre que `recetasMap` incluya las subrecetas necesarias.
 *
 * @param {object} receta - Receta con { id, porciones, ingredientes (JSONB) }
 * @param {Map<number, number>} preciosMap - Map ingredienteId → precio unitario (€)
 * @param {Map<number, object>} [recetasMap] - Map recetaId → receta (para subrecetas)
 * @param {Map<number, number>} [rendimientoBaseMap] - Map ingredienteId → rendimiento base
 * @param {Set<number>} [visited] - Internal cycle detection
 * @returns {number} Coste total del lote (€/receta).
 */
function getRecipeCostBase(receta, preciosMap, recetasMap = new Map(), rendimientoBaseMap = new Map(), visited = new Set()) {
    if (!receta || !Array.isArray(receta.ingredientes)) return 0;
    if (visited.has(receta.id)) return 0; // ciclo detectado
    visited.add(receta.id);

    let costeLote = 0;
    for (const item of receta.ingredientes) {
        const ingId = item.ingredienteId || item.ingrediente_id || item.id;
        const cantidad = parseFloat(item.cantidad) || 0;
        if (!ingId || cantidad <= 0) continue;

        if (ingId > 100000) {
            // Subreceta: recurse y multiplicar por nº de "porciones de subreceta" gastadas.
            const subRecetaId = ingId - 100000;
            const subReceta = recetasMap.get(subRecetaId);
            if (!subReceta) continue; // subreceta no cargada → ignorar (mismo comportamiento que frontend)
            const subPorciones = Math.max(1, parseInt(subReceta.porciones) || 1);
            const costeSubLote = getRecipeCostBase(subReceta, preciosMap, recetasMap, rendimientoBaseMap, new Set(visited));
            const costePorPorcionSub = costeSubLote / subPorciones;
            costeLote += costePorPorcionSub * cantidad;
        } else {
            const precio = preciosMap.get(ingId) || 0;
            let rendimiento = parseFloat(item.rendimiento);
            if (!rendimiento) rendimiento = rendimientoBaseMap.get(ingId) || 100;
            const factorRendimiento = rendimiento / 100;
            const costeReal = factorRendimiento > 0 ? (precio / factorRendimiento) : precio;
            costeLote += costeReal * cantidad;
        }
    }
    return costeLote;
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
 * Recalcula el precio del ingrediente como `precio_medio_compra_ponderado × cantidad_por_formato`.
 * Tras cada recepción de pedido sincroniza el precio configurado con la realidad de las compras,
 * de forma que el inventario (que muestra `precio_medio = precio / cantidad_por_formato`) refleje
 * lo que realmente se ha pagado en lugar del precio inicial estático.
 *
 * Mantiene la regla "stock valuation usa precio_medio" (feedback 2026-04-09) — solo cambia el origen
 * de ese precio_medio: ya no es config manual sino media ponderada de compras reales.
 *
 * @param {object} client - PostgreSQL client (dentro de la misma transacción que la recepción)
 * @param {number} ingredienteId
 * @param {number} restauranteId
 */
async function recalcularPrecioPonderado(client, ingredienteId, restauranteId) {
    const result = await client.query(`
        SELECT
            SUM(pcd.total_compra) / NULLIF(SUM(pcd.cantidad_comprada), 0) AS pmc,
            i.cantidad_por_formato
        FROM precios_compra_diarios pcd
        JOIN ingredientes i ON i.id = pcd.ingrediente_id AND i.restaurante_id = pcd.restaurante_id
        WHERE pcd.ingrediente_id = $1
          AND pcd.restaurante_id = $2
          AND i.deleted_at IS NULL
        GROUP BY i.cantidad_por_formato
    `, [ingredienteId, restauranteId]);

    if (result.rows.length === 0 || !result.rows[0].pmc) return;

    const pmc = parseFloat(result.rows[0].pmc);
    const cpf = parseFloat(result.rows[0].cantidad_por_formato) || 1;
    const nuevoPrecio = pmc * cpf;

    await client.query(
        'UPDATE ingredientes SET precio = $1, fecha_actualizacion = NOW() WHERE id = $2 AND restaurante_id = $3',
        [nuevoPrecio, ingredienteId, restauranteId]
    );
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

module.exports = {
    calcularPrecioUnitario,
    getBackendIngredientUnitPrice,
    expandRecipeToBase,
    getRecipeCostBase,
    upsertCompraDiaria,
    recalcularPrecioPonderado,
    buildIngredientPriceMap,
    resolveProveedorId,
    updateProveedorPrecio
};
