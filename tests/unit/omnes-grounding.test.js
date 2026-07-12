'use strict';
/**
 * Tests del blindaje de fundamentación numérica de Omnes (módulo PURO, sin LLM ni BD).
 * Verifica el extractor de cifras, el recolector de números de tools y el verificador.
 */
const g = require('../../src/services/omnesGrounding');

// Helper: construye el array `messages` con un tool_result JSON como en el bucle real.
function turnoConTool(obj) {
    return [
        { role: 'user', content: 'pregunta' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify(obj) }] },
    ];
}

describe('toFloat (formatos es-ES y estándar)', () => {
    test('miles con punto y decimal con coma', () => {
        expect(g.toFloat('48.298,02')).toBeCloseTo(48298.02, 2);
    });
    test('miles con punto sin decimales', () => {
        expect(g.toFloat('3.387')).toBe(3387);
    });
    test('decimal con coma', () => {
        expect(g.toFloat('12,44')).toBeCloseTo(12.44, 2);
        expect(g.toFloat('37,8')).toBeCloseTo(37.8, 1);
    });
    test('entero simple y con símbolo', () => {
        expect(g.toFloat('216')).toBe(216);
        expect(g.toFloat('612€')).toBe(612);
        expect(g.toFloat('RM 20')).toBe(20);
    });
});

describe('collectToolNumbers', () => {
    test('recoge números de campos y de strings embebidos', () => {
        const msgs = turnoConTool({ total: { total_compras: 48298.02, num_pedidos: 216 }, nota: 'precio 17,50€/kg' });
        const nums = g.collectToolNumbers(msgs);
        expect(nums).toEqual(expect.arrayContaining([48298.02, 216, 17.5]));
    });
    test('ignora bloques que no son tool_result', () => {
        const nums = g.collectToolNumbers([{ role: 'assistant', content: 'texto 999' }]);
        expect(nums).toEqual([]);
    });
});

describe('extractHardNumbers', () => {
    test('importe, porcentaje y conteo', () => {
        const nums = g.extractHardNumbers('En junio hubo 216 pedidos por 48.298,02€, food cost 37,8%.');
        const vals = nums.map(n => n.value);
        expect(vals).toEqual(expect.arrayContaining([216, 48298.02, 37.8]));
    });
    test('NO marca años como cifras', () => {
        const nums = g.extractHardNumbers('El histórico 2026 es bueno.');
        expect(nums.find(n => n.value === 2026)).toBeUndefined();
    });
});

describe('verifyAnswer — el caso real de los pedidos', () => {
    test('216 fundamentado por la tool → ok', () => {
        const msgs = turnoConTool({ total: { total_compras: 48298.02, num_pedidos: 216 } });
        const r = g.verifyAnswer('En junio se realizaron 216 pedidos, por un total de 48.298,02€.', msgs);
        expect(r.ok).toBe(true);
        expect(r.ungrounded).toHaveLength(0);
    });
    test('23 inventado (no está en la tool) → NO fundamentado', () => {
        const msgs = turnoConTool({ total: { total_compras: 48298.02, num_pedidos: 216 } });
        const r = g.verifyAnswer('En junio se realizaron 23 pedidos a proveedores.', msgs);
        expect(r.ok).toBe(false);
        expect(r.ungrounded.map(u => u.value)).toContain(23);
    });
});

describe('isGrounded — derivaciones legítimas', () => {
    test('margen = precio − coste (derivable de dos números de tool)', () => {
        const toolNums = [20, 7.56]; // precio y coste
        const ok = g.isGrounded({ value: 12.44, kind: 'money', decimals: 2 }, toolNums);
        expect(ok).toBe(true);
    });
    test('food cost % = coste/precio*100', () => {
        const toolNums = [20, 7.56];
        const ok = g.isGrounded({ value: 37.8, kind: 'percent', decimals: 1 }, toolNums);
        expect(ok).toBe(true);
    });
    test('cifra sin relación con las tools → no fundamentada', () => {
        const ok = g.isGrounded({ value: 999, kind: 'count', decimals: 0 }, [20, 7.56, 216]);
        expect(ok).toBe(false);
    });
});
