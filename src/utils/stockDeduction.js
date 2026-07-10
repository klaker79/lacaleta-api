/**
 * stockDeduction — utilidades para descontar stock de ventas sin deadlocks.
 *
 * CAUSA DEL DEADLOCK (incidente 2026-07-10, POST /api/sales): la venta bloqueaba
 * (`FOR UPDATE`) los ingredientes en el ORDEN DE LA RECETA. Dos ventas concurrentes
 * que comparten ingredientes los bloqueaban en orden distinto → abrazo mortal que
 * Postgres corta con "deadlock detected".
 *
 * REGLA DE ORO: todas las transacciones deben adquirir los locks en el MISMO orden.
 * Aquí ese orden es el `id` del ingrediente ascendente. Además se agregan los duplicados
 * (un mismo ingrediente base puede venir de varias subrecetas) para bloquear cada fila
 * una sola vez.
 */

/**
 * Agrega las cantidades a descontar por ingrediente y las devuelve ORDENADAS por id
 * ascendente. Filtra ids vacíos y cantidades no positivas.
 *
 * @param {Array<{ingredienteId:number|string, cantidadPorPorcion:number}>} baseIngs
 * @param {number} multiplicador  cantidad de la venta × factor de variante
 * @returns {Array<{ingredienteId:number, cantidad:number}>} orden determinista por id asc
 */
function agregarDeduccionesOrdenadas(baseIngs, multiplicador) {
    const porId = new Map();
    const mult = parseFloat(multiplicador);
    if (!Array.isArray(baseIngs) || isNaN(mult) || mult <= 0) return [];

    for (const it of baseIngs) {
        if (!it) continue;
        const id = parseInt(it.ingredienteId, 10);
        const porPorcion = parseFloat(it.cantidadPorPorcion);
        if (!id || isNaN(porPorcion)) continue;
        const add = porPorcion * mult;
        if (!(add > 0)) continue;
        porId.set(id, (porId.get(id) || 0) + add);
    }

    return [...porId.entries()]
        .map(([ingredienteId, cantidad]) => ({ ingredienteId, cantidad }))
        .sort((a, b) => a.ingredienteId - b.ingredienteId);
}

/**
 * ¿El error de Postgres es un deadlock (40P01) o un fallo de serialización (40001)?
 * Ambos son transitorios y seguros de reintentar (la transacción hizo rollback completo).
 */
function esDeadlock(err) {
    return !!err && (err.code === '40P01' || err.code === '40001');
}

module.exports = { agregarDeduccionesOrdenadas, esDeadlock };
