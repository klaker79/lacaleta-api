/**
 * supplierPricing — matemática de precio para la propagación del formato del proveedor
 * PRINCIPAL al ingrediente (Opción A).
 *
 * INVARIANTE CRÍTICA DEL SISTEMA:
 *   `ingredientes.precio` se almacena en €/FORMATO, no en €/unidad-base.
 *   - getIngredientUnitPrice()  hace  precio / cantidad_por_formato  → €/unidad-base
 *   - recalcularPrecioPonderado hace  precio = precio_medio_compra × cantidad_por_formato
 *
 * Por eso, cuando propagamos el formato del proveedor principal (que en la pivote guarda el
 * precio ya en €/unidad-base) al ingrediente, hay que reexpresar el precio a €/FORMATO usando
 * el cpf que quedará en el ingrediente. Si se tocara el cpf sin ajustar el precio, el food cost
 * se dividiría por el cpf → escandallo reventado.
 */

/** cpf saneado: número > 0, o 1 por defecto (NUNCA 0 ni NaN). */
function cpfSeguro(cpf) {
    const c = parseFloat(cpf);
    return (!isNaN(c) && c > 0) ? c : 1;
}

/**
 * Precio a escribir en `ingredientes.precio` (€/FORMATO) dado el precio €/unidad-base
 * canónico del proveedor y el cpf que quedará en el ingrediente. Redondeado a 2 decimales
 * (misma escala que la columna DECIMAL(10,2)).
 */
function precioFichaDesdeBase(precioBase, cpf) {
    const base = parseFloat(precioBase);
    if (isNaN(base)) return null;
    return Math.round(base * cpfSeguro(cpf) * 100) / 100;
}

/**
 * Precio UNITARIO (€/unidad-base) actual del ingrediente = precio de ficha / cpf.
 * Se usa para comparar manzana con manzana en el guard ±70% (no comparar €/formato con €/base).
 */
function precioUnitarioIngrediente(precioFicha, cpf) {
    const p = parseFloat(precioFicha);
    if (isNaN(p)) return 0;
    return p / cpfSeguro(cpf);
}

/**
 * ¿La desviación entre dos precios unitarios (€/base) supera el umbral (por defecto 70%)?
 * Devuelve false si el actual es 0/indefinido (no hay base contra la que comparar → no bloquea).
 */
function desviacionSupera(unitNuevo, unitActual, umbral = 0.70) {
    const a = parseFloat(unitActual);
    const n = parseFloat(unitNuevo);
    if (isNaN(a) || a <= 0 || isNaN(n)) return false;
    return Math.abs(n - a) / a > umbral;
}

module.exports = { cpfSeguro, precioFichaDesdeBase, precioUnitarioIngrediente, desviacionSupera };
