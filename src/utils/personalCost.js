/**
 * Expresión SQL del coste de las líneas de COMIDA PERSONAL de un pedido.
 *
 * El total de un pedido (`pedidos.total`) incluye las líneas marcadas
 * `personal: true` (la app las suma al total para cuadrar con el albarán, igual
 * que las líneas normales). Pero esas líneas NO son gasto del restaurante: van
 * solo a la pestaña "Comida Personal". Por eso, en cualquier agregado de gasto
 * (gasto por proveedor, total de compras, P&L del chat IA) hay que RESTAR su
 * coste de `p.total`.
 *
 * El coste de cada línea personal se calcula con el MISMO COALESCE de
 * cantidad/precio que usa la pestaña Búsqueda al desglosar pedidos, de modo que
 * la resta cuadra al céntimo tanto en pedidos pendientes (cantidad/precio_unitario)
 * como recibidos (cantidadRecibida/precioReal). Las líneas no-entregado cuentan 0,
 * igual que en el resto de cálculos.
 *
 * @param {string} alias  Alias de la tabla `pedidos` en la query (p.ej. 'p').
 * @returns {string} Expresión SQL escalar (numeric) — el coste personal del pedido.
 */
function personalCostExpr(alias = 'p') {
    return `COALESCE((
        SELECT SUM(
            CASE WHEN e->>'estado' = 'no-entregado' THEN 0 ELSE
                COALESCE((e->>'cantidadRecibida')::numeric, (e->>'cantidad')::numeric, 0) *
                COALESCE((e->>'precioReal')::numeric, (e->>'precioUnitario')::numeric, (e->>'precio_unitario')::numeric, 0)
            END
        )
        FROM jsonb_array_elements(COALESCE(${alias}.ingredientes, '[]'::jsonb)) AS e
        WHERE COALESCE((e->>'personal')::boolean, false) = true
    ), 0)`;
}

module.exports = { personalCostExpr };
