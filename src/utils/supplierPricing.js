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


/**
 * 🛡️ Red de seguridad del precio de proveedor (bug JOSEBA, 2026-08-03).
 *
 * `ingredientes_proveedores.precio` es €/UNIDAD-BASE. El formulario de ingredientes
 * llamaba a POST/PUT `/ingredients/:id/suppliers` mandando SOLO `precio` con el valor
 * de `ingredientes.precio`, que es €/FORMATO — y sin los campos de formato, así que no
 * había con qué derivarlo y se guardaba tal cual. Después, el desplegable de pedidos lo
 * multiplica por cantidad_por_formato para mostrarlo por formato: una CAJA de 10 l a
 * 23,10 € salía a **231 €**.
 *
 * Los 6 ingredientes de JOSEBA nacieron así. En La Nave 5 el defecto llevaba MESES
 * latente: el carrito prioriza la ÚLTIMA COMPRA real sobre este precio, y un
 * restaurante con historial nunca llega a leerlo. Solo muerde a los clientes NUEVOS
 * — que es justo a quien vendemos Lite.
 *
 * Si el ingrediente se compra por formato y la petición NO lo declara, se asume que el
 * precio recibido es el DEL FORMATO (que es lo que tiene sentido para quien lo teclea)
 * y se completan los campos para que `resolverFormatoProveedor` lo derive.
 *
 * Arreglar solo el frontend no basta: hay bundles viejos desplegados, la casa Lite no
 * tiene autodeploy y el flujo OCR entra por los mismos endpoints.
 *
 * @param {object} body - req.body original (no se muta)
 * @param {object} ingRow - fila del ingrediente {formato_compra, cantidad_por_formato}
 * @returns {object} el body original, o una COPIA con los campos de formato completados
 */
function completarFormatoDesdeIngrediente(body, ingRow) {
    if (!body || !ingRow) return body;
    // Si ya declara formato, el caller sabe lo que hace: no tocar.
    if (body.formato !== undefined && body.precio_formato !== undefined) return body;
    if (body.precio === undefined || body.precio === null || body.precio === '') return body;

    // cpf de 1 (o ausente) significa "se compra por unidad base": no hay nada que derivar.
    const cpf = parseFloat(ingRow.cantidad_por_formato);
    if (!(cpf > 1) || !ingRow.formato_compra) return body;

    return {
        ...body,
        formato: ingRow.formato_compra,
        cantidad_por_formato: cpf,
        precio_formato: body.precio,
    };
}

module.exports = { cpfSeguro, precioFichaDesdeBase, precioUnitarioIngrediente, desviacionSupera, completarFormatoDesdeIngrediente };
