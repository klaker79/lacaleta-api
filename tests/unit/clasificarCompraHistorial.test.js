// Blindaje del fallo de Omnes 2026-07-06: la tool diagnostico_ingrediente
// marcaba como "error de captura" cualquier compra que se desviara >30% del
// precio configurado. Un lote barato REAL de volandeira (7€ vs 13,50€) lo
// disparaba y Omnes recomendaba "corregir el albarán" (destruir dato bueno).
//
// clasificarCompraHistorial ahora separa:
//   - dato_incoherente (total ≠ precio×cantidad) → error REAL
//   - desviacion_alta (lejos del configurado pero coherente) → variación NORMAL
const { clasificarCompraHistorial } = require('../../src/services/chatService');

describe('clasificarCompraHistorial — variación de precio ≠ error de captura', () => {
    test('EL CASO VOLANDEIRA: lote barato coherente (7€, total cuadra) NO es error', () => {
        // 30 kg × 7€ = 210€ (cuadra). Configurado 13,50€ → −48% de desviación.
        const r = clasificarCompraHistorial({
            precio_unitario: 7, cantidad_comprada: 30, total_compra: 210,
            precio_por_formato: 7, precio_configurado: 13.5, formato_compra: 'kg'
        });
        expect(r.dato_incoherente).toBe(false);      // el total cuadra → NO error
        expect(r.desviacion_alta).toBe(true);         // sí se desvía mucho (info)
        expect(r.desviacion_vs_precio_configurado_pct).toBe(-48);
        expect(r.nota).toMatch(/variación/i);
        expect(r.nota).toMatch(/NO un error|precio REAL/i);
        expect(r.nota).not.toMatch(/error de captura/i);
    });

    test('lote caro coherente (+40%) tampoco es error, es variación', () => {
        const r = clasificarCompraHistorial({
            precio_unitario: 18, cantidad_comprada: 10, total_compra: 180,
            precio_por_formato: 18, precio_configurado: 12, formato_compra: 'kg'
        });
        expect(r.dato_incoherente).toBe(false);
        expect(r.desviacion_alta).toBe(true);
        expect(r.nota).toMatch(/más caro/i);
    });

    test('dato INCOHERENTE (total ≠ precio×cantidad) SÍ es posible error de captura', () => {
        // 30 kg × 7€ debería ser 210€, pero el total dice 420€ → incoherente.
        const r = clasificarCompraHistorial({
            precio_unitario: 7, cantidad_comprada: 30, total_compra: 420,
            precio_por_formato: 7, precio_configurado: 13.5, formato_compra: 'kg'
        });
        expect(r.dato_incoherente).toBe(true);
        expect(r.nota).toMatch(/incoherente|error de captura|revisar el albarán/i);
    });

    test('precio normal (cerca del configurado) → sin nota, sin flags', () => {
        const r = clasificarCompraHistorial({
            precio_unitario: 13, cantidad_comprada: 20, total_compra: 260,
            precio_por_formato: 13, precio_configurado: 13.5, formato_compra: 'kg'
        });
        expect(r.dato_incoherente).toBe(false);
        expect(r.desviacion_alta).toBe(false);
        expect(r.nota).toBeNull();
    });

    test('tolerancia: pequeño redondeo NO se marca incoherente', () => {
        // 3 × 4,33 = 12,99 pero total 13,00 (diferencia 0,01 < tolerancia).
        const r = clasificarCompraHistorial({
            precio_unitario: 4.33, cantidad_comprada: 3, total_compra: 13.0,
            precio_por_formato: 4.33, precio_configurado: 4.3, formato_compra: 'kg'
        });
        expect(r.dato_incoherente).toBe(false);
    });

    test('sin precio configurado → desviación null, no peta', () => {
        const r = clasificarCompraHistorial({
            precio_unitario: 7, cantidad_comprada: 10, total_compra: 70,
            precio_por_formato: 7, precio_configurado: 0, formato_compra: 'kg'
        });
        expect(r.desviacion_vs_precio_configurado_pct).toBeNull();
        expect(r.desviacion_alta).toBe(false);
        expect(r.dato_incoherente).toBe(false);
    });
});
