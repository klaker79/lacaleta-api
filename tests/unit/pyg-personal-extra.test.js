/**
 * tests/unit/pyg-personal-extra.test.js
 *
 * Blindaje del PyG: la tool resumen_pyg debe RESTAR personal_extra_periodo
 * del beneficio neto (margen_neto_aprox) y exponer el campo. Pool mockeado:
 * no necesita DB. Verifica el orden de queries y la fórmula del beneficio.
 */
const { runTool } = require('../../src/services/chatService');

// resumen_pyg ejecuta 5 queries en este orden:
//  1) ventas  2) compras  3) cogsSplit  4) gastos_fijos  5) personal_extra
function poolPyg({ ingresos, comida_personal, cogsFood, ingFood, gastosFijosMes, personalExtra }) {
    const query = jest.fn()
        .mockResolvedValueOnce({ rows: [{ ingresos: String(ingresos), num_tickets: '10' }] })
        .mockResolvedValueOnce({ rows: [{ total_compras: '0', comida_personal: String(comida_personal) }] })
        .mockResolvedValueOnce({ rows: [{ tipo: 'food', cogs: String(cogsFood), ingresos_cat: String(ingFood) }] })
        .mockResolvedValueOnce({ rows: [{ gastos_fijos_mes: String(gastosFijosMes) }] })
        .mockResolvedValueOnce({ rows: [{ personal_extra_periodo: String(personalExtra) }] });
    return { query };
}

// Mes cerrado en el pasado → gastos fijos se prorratean al mes completo (sin cambio).
const RANGO = { fecha_desde: '2026-05-01', fecha_hasta: '2026-05-31' };

const BASE = { ingresos: 1000, comida_personal: 50, cogsFood: 300, ingFood: 1000, gastosFijosMes: 200 };

describe('resumen_pyg — personal extra resta al beneficio', () => {
    test('expone personal_extra_periodo y NO afecta al margen bruto', async () => {
        const r = await runTool('resumen_pyg', poolPyg({ ...BASE, personalExtra: 80 }), 3, RANGO);
        expect(r.personal_extra_periodo).toBe(80);
        expect(r.margen_bruto).toBe(700); // ingresos − cogs, sin gastos ni extra
    });

    test('el beneficio neto baja EXACTAMENTE el importe del personal extra', async () => {
        const sin = await runTool('resumen_pyg', poolPyg({ ...BASE, personalExtra: 0 }), 3, RANGO);
        const con = await runTool('resumen_pyg', poolPyg({ ...BASE, personalExtra: 80 }), 3, RANGO);
        expect(sin.personal_extra_periodo).toBe(0);
        expect(con.personal_extra_periodo).toBe(80);
        // Aislamos el efecto del extra del prorrateo de gastos fijos:
        expect(Math.round((sin.margen_neto_aprox - con.margen_neto_aprox) * 100) / 100).toBe(80);
    });
});
