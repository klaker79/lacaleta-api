/**
 * prorrateo.js — prorrateo de gastos fijos mensuales a un periodo parcial.
 *
 * Problema que resuelve: un P&L de un periodo parcial (p.ej. "este mes" a día 9)
 * comparaba ingresos de 9 días contra un mes ENTERO de gastos fijos, dando un
 * beneficio neto catastrófico irreal. Los gastos fijos se devengan por día
 * natural, así que hay que prorratearlos a los días reales del periodo.
 *
 * Pensado como fuente única: lo usa el chat (resumen_pyg) y puede usarlo el
 * informe mensual (informeMensualService), que tiene el mismo patrón.
 */

/**
 * @param {number} gastosFijosMes  SUM(monto_mensual) del tenant (mes completo)
 * @param {string} desde           YYYY-MM-DD inclusive
 * @param {string} hasta           YYYY-MM-DD exclusive (rango pedido)
 * @param {string} hoyExclusivo    YYYY-MM-DD = hoy+1 (inyectable para tests).
 *                                  Recorta `hasta` para no contar días futuros
 *                                  sin datos de ventas.
 * @returns {{ hasta_efectivo: string, dias_periodo: number, dias_mes: number,
 *             parcial: boolean, gastos_fijos_periodo: number }}
 */
function prorratearGastosFijos(gastosFijosMes, desde, hasta, hoyExclusivo) {
    const MS_DIA = 86400000;
    const monto = Number(gastosFijosMes) || 0;
    const hastaEfectivo = hasta < hoyExclusivo ? hasta : hoyExclusivo;
    const diasPeriodo = Math.max(
        0,
        Math.round((Date.parse(hastaEfectivo) - Date.parse(desde)) / MS_DIA)
    );
    // Días naturales del mes de `desde` → tarifa diaria correcta en el caso
    // común de un único mes (mayo=31, junio=30, febrero=28/29...).
    const d = new Date(`${desde}T00:00:00Z`);
    const diasMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const gastosFijosPeriodo = diasMes > 0
        ? Math.round((monto * diasPeriodo / diasMes) * 100) / 100
        : 0;
    return {
        hasta_efectivo: hastaEfectivo,
        dias_periodo: diasPeriodo,
        dias_mes: diasMes,
        parcial: hastaEfectivo < hasta,
        gastos_fijos_periodo: gastosFijosPeriodo
    };
}

module.exports = { prorratearGastosFijos };
