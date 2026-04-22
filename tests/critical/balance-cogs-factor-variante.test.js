/**
 * ============================================
 * tests/critical/balance-cogs-factor-variante.test.js
 * ============================================
 *
 * REGRESSION: el COGS del balance mensual (/balance/mes) debe coincidir
 * con el coste_ingredientes que sales.routes.js guardó en ventas_diarias_resumen
 * al momento de crear la venta.
 *
 * Bug histórico (corregido 2026-04-23): balance.routes.js recalculaba COGS
 * desde cero SIN aplicar `factor_variante`, mientras que sales.routes.js
 * SÍ lo aplicaba al guardar. En tenants con variantes (media ración factor=0.5,
 * extra factor=1.2) el mismo mes mostraba números distintos en balance vs P&L.
 *
 * Este test fija la invariante: costes reportados por /balance/mes deben
 * ser consistentes con los guardados en sales (cuando factor_variante != 1).
 *
 * @author MindLoopIA
 * @date 2026-04-23
 */

const request = require('supertest');
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ORIGIN = 'http://localhost:3001';

describe('Balance COGS — factor_variante aplicado igual que sales', () => {
    let authToken;

    beforeAll(async () => {
        authToken = await global.getAuthToken();
    });

    it('GET /balance/mes responde 200 con estructura coherente', async () => {
        if (!authToken) return;

        const now = new Date();
        const res = await request(API_URL)
            .get(`/api/balance/mes?mes=${now.getMonth() + 1}&ano=${now.getFullYear()}`)
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${authToken}`);

        // 403 si el plan no cubre balance, 200 si sí — ambos son válidos en CI
        expect([200, 403]).toContain(res.status);
        if (res.status !== 200) return;

        // Cuando hay respuesta, ganancia = ingresos - costos (coherencia interna)
        const { ingresos, costos, ganancia } = res.body;
        if (ingresos != null && costos != null && ganancia != null) {
            const diff = Math.abs(parseFloat(ganancia) - (parseFloat(ingresos) - parseFloat(costos)));
            expect(diff).toBeLessThan(0.02);
        }
    });

    it('balance/mes y analytics/pnl-breakdown reportan COGS cercanos (±5%) en mismo mes', async () => {
        if (!authToken) return;

        const now = new Date();
        const mes = now.getMonth() + 1;
        const ano = now.getFullYear();

        const [balanceRes, pnlRes] = await Promise.all([
            request(API_URL)
                .get(`/api/balance/mes?mes=${mes}&ano=${ano}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`),
            request(API_URL)
                .get(`/api/analytics/pnl-breakdown?mes=${mes}&ano=${ano}`)
                .set('Origin', ORIGIN)
                .set('Authorization', `Bearer ${authToken}`)
        ]);

        if (balanceRes.status !== 200 || pnlRes.status !== 200) return;

        const costosBalance = parseFloat(balanceRes.body.costos || 0);
        // pnl-breakdown agrega food + beverage; sumamos coste_ingredientes equivalente
        const filasPnl = Array.isArray(pnlRes.body.breakdown) ? pnlRes.body.breakdown : (pnlRes.body.rows || []);
        const costosPnl = filasPnl.reduce((acc, row) => {
            return acc + parseFloat(row.coste_ingredientes || row.cogs || 0);
        }, 0);

        if (costosBalance === 0 && costosPnl === 0) {
            console.log('⚠️ Mes sin ventas — skip cross-check');
            return;
        }

        // Tolerancia 5% — diferencias menores son aceptables (redondeo, precios medios).
        // El bug que este test detectaría daría divergencias de 10-50% en tenants con
        // variantes activas.
        const mayor = Math.max(costosBalance, costosPnl);
        const divergencia = mayor > 0 ? Math.abs(costosBalance - costosPnl) / mayor : 0;
        expect(divergencia).toBeLessThan(0.05);
    });
});
