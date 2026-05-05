/**
 * Unit tests para recalcularPrecioPonderado en businessHelpers.js
 *
 * Cubre la lógica pura de recálculo:
 *  - Calcula media ponderada SUM(total)/SUM(cantidad) × cpf
 *  - Maneja cantidad_por_formato NULL (fallback a 1)
 *  - No actualiza si no hay compras
 *  - No actualiza si pmc resulta 0/NULL
 *
 * Fast-path: mock del client de pg, sin DB real.
 */

const { recalcularPrecioPonderado } = require('../../src/utils/businessHelpers');

function makeMockClient(rows) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            // Primera query es SELECT con GROUP BY → devuelve rows del SELECT.
            // Segunda query es UPDATE → devuelve OK.
            if (sql.trim().startsWith('UPDATE')) return { rowCount: 1 };
            return { rows };
        }
    };
}

describe('recalcularPrecioPonderado', () => {
    it('media ponderada con cpf=1 → precio = pmc', async () => {
        // 1×10 + 9×20 = 190 / 10 = 19; precio = 19 × 1 = 19
        const client = makeMockClient([{ pmc: '19', cantidad_por_formato: 1 }]);
        await recalcularPrecioPonderado(client, 100, 3);
        const updateCall = client.calls.find(c => c.sql.trim().startsWith('UPDATE'));
        expect(updateCall).toBeDefined();
        expect(updateCall.params[0]).toBeCloseTo(19, 4);
        expect(updateCall.params[1]).toBe(100);
        expect(updateCall.params[2]).toBe(3);
    });

    it('media ponderada con cpf=6 (caja 6 botellas) → precio = pmc × 6', async () => {
        // pmc por unidad = 13.33; precio del formato = 13.33 × 6 = 80
        const client = makeMockClient([{ pmc: '13.3333', cantidad_por_formato: 6 }]);
        await recalcularPrecioPonderado(client, 200, 3);
        const updateCall = client.calls.find(c => c.sql.trim().startsWith('UPDATE'));
        expect(updateCall.params[0]).toBeCloseTo(80, 1);
    });

    it('cantidad_por_formato NULL → fallback a 1', async () => {
        const client = makeMockClient([{ pmc: '4.35', cantidad_por_formato: null }]);
        await recalcularPrecioPonderado(client, 566, 3);
        const updateCall = client.calls.find(c => c.sql.trim().startsWith('UPDATE'));
        expect(updateCall.params[0]).toBeCloseTo(4.35, 4);
    });

    it('sin compras → no ejecuta UPDATE', async () => {
        const client = makeMockClient([]);
        await recalcularPrecioPonderado(client, 999, 3);
        const updateCall = client.calls.find(c => c.sql.trim().startsWith('UPDATE'));
        expect(updateCall).toBeUndefined();
    });

    it('pmc null (todas las cantidades a 0) → no ejecuta UPDATE', async () => {
        const client = makeMockClient([{ pmc: null, cantidad_por_formato: 1 }]);
        await recalcularPrecioPonderado(client, 999, 3);
        const updateCall = client.calls.find(c => c.sql.trim().startsWith('UPDATE'));
        expect(updateCall).toBeUndefined();
    });

    it('UPDATE filtra por restaurante_id (cross-tenant safety)', async () => {
        const client = makeMockClient([{ pmc: '15', cantidad_por_formato: 1 }]);
        await recalcularPrecioPonderado(client, 100, 28);
        const updateCall = client.calls.find(c => c.sql.trim().startsWith('UPDATE'));
        expect(updateCall.sql).toMatch(/restaurante_id\s*=\s*\$3/);
        expect(updateCall.params[2]).toBe(28);
    });

    it('SELECT incluye filtro deleted_at IS NULL para soft-delete safety', async () => {
        const client = makeMockClient([{ pmc: '10', cantidad_por_formato: 1 }]);
        await recalcularPrecioPonderado(client, 100, 3);
        const selectCall = client.calls.find(c => c.sql.includes('SELECT'));
        expect(selectCall.sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    });
});
