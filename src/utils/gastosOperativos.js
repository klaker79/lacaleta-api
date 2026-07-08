/**
 * Gastos fijos OPERATIVOS (de explotación).
 *
 * En el P&L operativo y en el punto de equilibrio cuentan los gastos que pagas
 * por tener el negocio abierto, vendas o no. Se excluyen SOLO los impuestos NO
 * operativos:
 *   - IVA / IGIC: pass-through (lo cobras y lo devuelves).
 *   - IRPF / Impuesto de Sociedades: se pagan sobre el BENEFICIO.
 * El IAE, IBI, tasas y licencias SÍ cuentan (son gasto de explotación).
 *
 * MISMA regla que el frontend (breakeven-calc.js `esImpuestoNoOperativo`).
 * La lista de gastos fijos del usuario NO se toca; solo se excluyen de los
 * agregados que alimentan indicadores financieros.
 *
 * Se detecta por PALABRA COMPLETA para no dar falsos positivos:
 * "Seguridad Social" NO matchea "sociedades".
 *
 * Límite de palabra EXPLÍCITO `(^|[^a-z0-9])...([^a-z0-9]|$)` en vez de `\y`:
 * el `\y` de Postgres trata el guion bajo como carácter de palabra, así que
 * "iva_trimestral" NO se excluía en backend pero SÍ en frontend (que separa
 * por [^a-z0-9]). Con la clase explícita ambos lados parten las palabras
 * EXACTAMENTE igual (con `~*` la clase también es case-insensitive).
 */

const IMPUESTOS_NO_OPERATIVOS_REGEX = '(^|[^a-z0-9])(iva|igic|irpf|sociedades)([^a-z0-9]|$)';

/**
 * Devuelve el fragmento SQL que, en un WHERE, deja SOLO los gastos operativos
 * (excluye los impuestos no operativos). Pensado para interpolar (la constante
 * es estática, no viene del usuario).
 *
 *   SELECT SUM(monto_mensual) FROM gastos_fijos
 *   WHERE restaurante_id = $1 AND ${condicionGastosOperativosSql()}
 *
 * @param {string} colConcepto - nombre de la columna de concepto (default 'concepto').
 * @returns {string}
 */
function condicionGastosOperativosSql(colConcepto = 'concepto') {
    return `${colConcepto} !~* '${IMPUESTOS_NO_OPERATIVOS_REGEX}'`;
}

module.exports = { condicionGastosOperativosSql, IMPUESTOS_NO_OPERATIVOS_REGEX };
