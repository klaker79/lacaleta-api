/**
 * Punto de pedido recomendado (idea del "recommended reorder level" de ERPNext):
 * consumo diario real × plazo del proveedor + stock de seguridad. Solo SUGIERE —
 * no crea pedidos ni toca stock (el stock virtual es una aproximación, ley
 * 2026-08-02, así que la última palabra es del usuario).
 */
const { computeReorderSuggestions } = require('../../src/utils/businessHelpers');

// 90 uds consumidas en 90 días = 1 ud/día. Lead real de 3 días. Mínimo 2.
const fila = (extra = {}) => ({
    id: 1,
    nombre: 'PULPO',
    unidad: 'kg',
    stock_actual: 4,
    stock_minimo: 2,
    proveedor_id: 7,
    proveedor_nombre: 'Mariscos Paco',
    consumido_ventana: 90,
    lead_dias_medio: 3,
    ...extra
});

describe('computeReorderSuggestions', () => {
    test('stock por debajo del punto de pedido ⇒ sugiere', () => {
        // punto = 1·3 + 2 = 5; stock 4 ≤ 5 ⇒ avisa
        const [s] = computeReorderSuggestions([fila()]);
        expect(s).toBeDefined();
        expect(s.punto_pedido).toBe(5);
        expect(s.consumo_diario).toBe(1);
        expect(s.lead_dias).toBe(3);
        expect(s.lead_estimado).toBe(false);
        // pedir lead+cobertura(7)+mínimo−stock = 1·10 + 2 − 4 = 8
        expect(s.cantidad_sugerida).toBe(8);
        expect(s.cobertura_dias).toBe(4);
    });

    test('stock holgado ⇒ silencio', () => {
        expect(computeReorderSuggestions([fila({ stock_actual: 50 })])).toHaveLength(0);
    });

    test('sin consumo en la ventana ⇒ fuera (no se sugiere lo que no se vende)', () => {
        expect(computeReorderSuggestions([fila({ consumido_ventana: 0 })])).toHaveLength(0);
        expect(computeReorderSuggestions([fila({ consumido_ventana: null })])).toHaveLength(0);
    });

    test('proveedor sin historial ⇒ lead por defecto y se marca estimado', () => {
        const [s] = computeReorderSuggestions(
            [fila({ lead_dias_medio: null, stock_actual: 3 })],
            { leadDefault: 2 }
        );
        expect(s.lead_dias).toBe(2);
        expect(s.lead_estimado).toBe(true);
    });

    test('sin stock_minimo configurado cuenta como 0, no rompe', () => {
        // punto = 1·3 + 0 = 3; stock 4 > 3 ⇒ silencio
        expect(computeReorderSuggestions([fila({ stock_minimo: null })])).toHaveLength(0);
    });

    test('ordena por urgencia: menos días de cobertura primero', () => {
        const out = computeReorderSuggestions([
            fila({ id: 1, stock_actual: 4 }),                 // 4 días de cobertura
            fila({ id: 2, nombre: 'PAN', stock_actual: 1 })   // 1 día de cobertura
        ]);
        expect(out.map(s => s.id)).toEqual([2, 1]);
    });

    test('la cantidad sugerida nunca es negativa', () => {
        // stock justo en el punto de pedido con cobertura 0
        const [s] = computeReorderSuggestions([fila({ stock_actual: 5 })], { coberturaObjetivoDias: 1 });
        expect(s.cantidad_sugerida).toBeGreaterThanOrEqual(0);
    });
});
