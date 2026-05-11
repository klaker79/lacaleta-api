/**
 * Cálculo del stock a sumar al aprobar un item de compras_pendientes.
 *
 * Esta función vive aparte para que se pueda testear sin DB. La fórmula
 * estaba inline en `balance.routes.js` (single approve + batch approve)
 * duplicada. Extraerla aquí:
 *   1. Garantiza que ambos endpoints usan exactamente la misma lógica.
 *   2. Permite tests unitarios que blindan el bug histórico del
 *      2026-04-22 (stock de La Nave 5 saltó 29k → 35.5k tras un batch
 *      Smart Order — formato_override mal interpretado).
 *
 * Reglas (sin cambios respecto al código previo):
 *   - formato = parseFloat(formato_override) || 1
 *       (NULL, 0, NaN, string raro → fallback a 1, igual que antes)
 *   - stockToAdd = cantidad × formato
 *   - rejected = stockToAdd > 10000  → guardrail anti absurdo (caja 1k uds)
 *   - unitPrice = totalAlbaran / stockToAdd  (precio €/unidad-base)
 *     Si stockToAdd = 0 → fallback a item.precio.
 *
 * @param {object} item — fila de compras_pendientes (campos: cantidad,
 *                        precio, formato_override)
 * @returns {{ stockToAdd: number, unitPrice: number,
 *            rejected: boolean, formato: number, totalAlbaran: number }}
 */
function computePurchaseApproval(item) {
    const cantidad = parseFloat(item.cantidad);
    const precio = parseFloat(item.precio);
    const formato = parseFloat(item.formato_override) || 1;
    const stockToAdd = cantidad * formato;
    const totalAlbaran = precio * cantidad;
    const rejected = stockToAdd > 10000;
    // Precio unitario normalizado: total albarán / unidades base.
    // Si stockToAdd = 0 (no debería pasar tras parseFloat sano) caemos al
    // precio del item directamente — mismo comportamiento que el código
    // previo.
    const unitPrice = stockToAdd > 0
        ? +(totalAlbaran / stockToAdd).toFixed(4)
        : precio;
    return { stockToAdd, unitPrice, rejected, formato, totalAlbaran };
}

module.exports = { computePurchaseApproval, STOCK_ABSURD_THRESHOLD: 10000 };
