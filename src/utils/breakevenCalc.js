/**
 * Cálculo PURO del Punto de Equilibrio para la tool de Omnes.
 *
 * MISMA fórmula, redondeos y convenciones que el frontend
 * (MindLoop-CostOS/src/modules/analisis/breakeven-calc.js::computeBreakeven
 * en su rama de food cost canónico), para que Omnes y el bloque de Análisis
 * den los MISMOS números:
 *
 *   margen/plato       = ticket × (1 − foodCost/100)
 *   platos equilibrio  = ceil(gastosOperativosMes / margenPlato)
 *   ventas equilibrio  = platosMes × ticket   (≈ gastos / (1 − fc))
 *   €/día              = ventasMes / diasServicio
 *
 * El food cost se pasa ya redondeado a 1 decimal (como getFoodCostCanonical
 * del frontend) y es el GLOBAL (comida+bebida) de la ventana de 90 días.
 *
 * @param {Object} opts
 * @param {number} opts.gastosOperativosMes - gastos fijos DE EXPLOTACIÓN (€/mes).
 * @param {number} opts.foodCostPct - food cost global % (0-100, 1 decimal).
 * @param {number} opts.ticketMedio - € de venta por plato (ponderado real).
 * @param {number} [opts.diasServicio=26] - días de servicio al mes.
 * @returns {Object|null} números del equilibrio, o null si faltan datos válidos.
 */
const DIAS_SERVICIO_MES_DEFAULT = 26;

function computeBreakevenBackend({ gastosOperativosMes, foodCostPct, ticketMedio, diasServicio = DIAS_SERVICIO_MES_DEFAULT } = {}) {
    const gastos = parseFloat(gastosOperativosMes);
    const fc = parseFloat(foodCostPct);
    const ticket = parseFloat(ticketMedio);
    const dias = parseInt(diasServicio) > 0 ? parseInt(diasServicio) : DIAS_SERVICIO_MES_DEFAULT;

    if (!(gastos > 0) || !(fc > 0 && fc < 100) || !(ticket > 0)) return null;

    const margenPlato = ticket * (1 - fc / 100);
    if (!(margenPlato > 0)) return null;

    const platosMes = Math.ceil(gastos / margenPlato);
    const ventasMes = platosMes * ticket;
    const ventasDia = ventasMes / dias;
    const platosDia = Math.ceil(platosMes / dias);

    return {
        gastos_operativos_mes: Math.round(gastos * 100) / 100,
        food_cost_pct: fc,
        ticket_medio: Math.round(ticket * 100) / 100,
        margen_por_plato: Math.round(margenPlato * 100) / 100,
        dias_servicio: dias,
        platos_equilibrio_mes: platosMes,
        platos_equilibrio_dia: platosDia,
        ventas_equilibrio_mes: Math.round(ventasMes * 100) / 100,
        ventas_equilibrio_dia: Math.round(ventasDia * 100) / 100
    };
}

module.exports = { computeBreakevenBackend, DIAS_SERVICIO_MES_DEFAULT };
