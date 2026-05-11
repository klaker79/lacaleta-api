/**
 * Unit tests para computePurchaseApproval — fórmula del aprovado de
 * compras pendientes que actualiza stock + precio en Diario.
 *
 * Bug class que blinda: doble multiplicación de stock al usar
 * formato_override. La Nave 5 sufrió un salto de 29k → 35.5k el
 * 2026-04-22 (project_incidente_stock_2026_04_22). Si la fórmula
 * vuelve a romperse, este test lo pilla antes del merge.
 */

const {
    computePurchaseApproval,
    STOCK_ABSURD_THRESHOLD
} = require('../../src/utils/purchaseApproveCalc');

describe('computePurchaseApproval — base', () => {
    test('formato_override NULL → multiplicador 1, stock = cantidad', () => {
        const r = computePurchaseApproval({
            cantidad: 5, precio: 12, formato_override: null
        });
        expect(r.formato).toBe(1);
        expect(r.stockToAdd).toBe(5);
        expect(r.totalAlbaran).toBe(60);
        // precio unitario = total / stock = 60 / 5 = 12
        expect(r.unitPrice).toBe(12);
        expect(r.rejected).toBe(false);
    });

    test('formato_override undefined → multiplicador 1', () => {
        const r = computePurchaseApproval({ cantidad: 10, precio: 5 });
        expect(r.formato).toBe(1);
        expect(r.stockToAdd).toBe(10);
    });

    test('formato_override = 6 (caja de 6) → stock = cantidad × 6', () => {
        // Caso clásico: usuario compra 2 cajas de vino de 6 botellas
        // → stock sube 12 botellas, precio €/botella = €/caja / 6.
        const r = computePurchaseApproval({
            cantidad: 2, precio: 48, formato_override: 6
        });
        expect(r.formato).toBe(6);
        expect(r.stockToAdd).toBe(12);
        expect(r.totalAlbaran).toBe(96);
        // €48 × 2 = €96 / 12 botellas = €8 por botella
        expect(r.unitPrice).toBe(8);
        expect(r.rejected).toBe(false);
    });

    test('formato_override = 1 explícito → comportamiento idéntico a NULL', () => {
        const r = computePurchaseApproval({
            cantidad: 5, precio: 10, formato_override: 1
        });
        expect(r.stockToAdd).toBe(5);
        expect(r.unitPrice).toBe(10);
    });
});

describe('computePurchaseApproval — fallbacks (valores raros)', () => {
    test('formato_override = 0 → fallback a 1 (división segura)', () => {
        const r = computePurchaseApproval({
            cantidad: 5, precio: 10, formato_override: 0
        });
        expect(r.formato).toBe(1);
        expect(r.stockToAdd).toBe(5);
    });

    test('formato_override negativo → fallback a 1 (parseFloat || 1)', () => {
        const r = computePurchaseApproval({
            cantidad: 5, precio: 10, formato_override: -3
        });
        // parseFloat(-3) = -3 → truthy → SE USA. El código original NO
        // protege contra negativos. Si cambia esta semántica, el test grita.
        expect(r.formato).toBe(-3);
        expect(r.stockToAdd).toBe(-15);
    });

    test('formato_override "abc" (string no numérico) → fallback a 1', () => {
        const r = computePurchaseApproval({
            cantidad: 5, precio: 10, formato_override: 'abc'
        });
        expect(r.formato).toBe(1);
        expect(r.stockToAdd).toBe(5);
    });

    test('formato_override como string numérico ("6") → se parsea', () => {
        const r = computePurchaseApproval({
            cantidad: 2, precio: 10, formato_override: '6'
        });
        expect(r.formato).toBe(6);
        expect(r.stockToAdd).toBe(12);
    });

    test('cantidad = 0 → stockToAdd = 0, unitPrice fallback a item.precio', () => {
        const r = computePurchaseApproval({
            cantidad: 0, precio: 12.5, formato_override: 1
        });
        expect(r.stockToAdd).toBe(0);
        // Sin unidades base, no se puede normalizar → fallback al precio raw
        expect(r.unitPrice).toBe(12.5);
    });
});

describe('computePurchaseApproval — guardrail anti-absurdo', () => {
    test('stockToAdd > 10000 → rejected = true', () => {
        // 100 cajas × 200 ud cada una = 20.000 → absurdo
        const r = computePurchaseApproval({
            cantidad: 100, precio: 50, formato_override: 200
        });
        expect(r.stockToAdd).toBe(20000);
        expect(r.rejected).toBe(true);
    });

    test('stockToAdd = 10000 (exactamente en el límite) → NO rechazado', () => {
        const r = computePurchaseApproval({
            cantidad: 1000, precio: 1, formato_override: 10
        });
        expect(r.stockToAdd).toBe(10000);
        expect(r.rejected).toBe(false); // > 10000, no >=
    });

    test('stockToAdd = 10001 → rejected', () => {
        const r = computePurchaseApproval({
            cantidad: 10001, precio: 1, formato_override: 1
        });
        expect(r.rejected).toBe(true);
    });

    test('STOCK_ABSURD_THRESHOLD exportado y vale 10000', () => {
        expect(STOCK_ABSURD_THRESHOLD).toBe(10000);
    });
});

describe('computePurchaseApproval — precio unitario normalizado (4 decimales)', () => {
    test('redondea a 4 decimales', () => {
        // 100€ / 3 unidades = 33.333333... → redondear a 33.3333
        const r = computePurchaseApproval({
            cantidad: 1, precio: 100, formato_override: 3
        });
        expect(r.unitPrice).toBeCloseTo(33.3333, 4);
    });

    test('no introduce flotante raro (.toFixed + +)', () => {
        // total 10€ / 3 unidades = 3.3333... €/ud — verificamos que NO sale
        // un decimal artefactual largo tipo 3.3333000000001.
        const r = computePurchaseApproval({
            cantidad: 1, precio: 10, formato_override: 3 // 1×3=3 ud, total=10€
        });
        expect(r.stockToAdd).toBe(3);
        expect(r.totalAlbaran).toBe(10);
        // toFixed(4) → "3.3333" → +"3.3333" → 3.3333 (decimal limpio)
        expect(r.unitPrice).toBe(3.3333);
        expect(String(r.unitPrice).length).toBeLessThan(10);
    });
});

describe('computePurchaseApproval — escenarios reales (regresión del 22-abril)', () => {
    test('escenario que provocó el salto 29k→35.5k de La Nave 5', () => {
        // El bug del 22-abril venía de approve-batch con formato_override
        // mal interpretado. El test garantiza que CON el helper la
        // cantidad × formato sigue siendo determinista, no se duplica.
        const r = computePurchaseApproval({
            cantidad: 50, precio: 100, formato_override: 12 // caja de 12
        });
        // Esperado: 50 × 12 = 600 unidades, no 600 × 12 ni nada similar
        expect(r.stockToAdd).toBe(600);
        // total = 50 cajas × 100€ = 5000€
        expect(r.totalAlbaran).toBe(5000);
        // precio por unidad = 5000 / 600 ≈ 8.3333
        expect(r.unitPrice).toBeCloseTo(8.3333, 4);
    });
});
