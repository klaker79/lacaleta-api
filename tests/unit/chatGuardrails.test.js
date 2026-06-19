// Guardarraíles del system prompt del chat (Omnes).
// NO testean el comportamiento del modelo (eso requeriría llamar a Claude).
// Garantizan que las REGLAS que evitan errores de cálculo / inconsistencias
// SIGUEN presentes en el prompt — que un refactor futuro no las borre sin querer.
// Cada una nació de un fallo real cazado el 15-16 jun 2026.
const { SYSTEM_PROMPT_STATIC } = require('../../src/services/chatService');

describe('System prompt — guardarraíles críticos presentes', () => {
    test('el prompt estático existe y no está vacío', () => {
        expect(typeof SYSTEM_PROMPT_STATIC).toBe('string');
        expect(SYSTEM_PROMPT_STATIC.length).toBeGreaterThan(1000);
    });

    // Extrapolación mensual — evitaba contar la ventana de 60 días como mensual (cifra x2).
    test('regla de cifras mensuales (usar *_mes_estimado, no el total de la ventana)', () => {
        expect(SYSTEM_PROMPT_STATIC).toContain('unidades_mes_estimado');
        expect(SYSTEM_PROMPT_STATIC).toMatch(/VENTAS Y CIFRAS|al mes|mensual/i);
    });

    // Superlativos — evitaba coronar el ítem de la conversación en vez del top real.
    test('regla anti-sesgo en superlativos/rankings', () => {
        expect(SYSTEM_PROMPT_STATIC).toContain('SUPERLATIVOS');
    });

    // No inventar la ventana temporal — evitaba "90 días / 3 meses" a ojo.
    test('regla de no inventar la ventana temporal', () => {
        expect(SYSTEM_PROMPT_STATIC).toContain('NUNCA INVENTES LA VENTANA');
    });

    // Cálculo de impacto — evitaba "perdona, me equivoqué" tras una cifra mala.
    test('regla de cálculo de impacto sin autocorrección', () => {
        expect(SYSTEM_PROMPT_STATIC).toContain('CÁLCULOS DE IMPACTO ECONÓMICO');
    });

    // Reconciliación stock — "qué reponer" debe cuadrar con el "Stock Bajo" del dashboard.
    test('regla de reconciliar stock con el dashboard', () => {
        expect(SYSTEM_PROMPT_STATIC).toMatch(/RECONCILIA con el dashboard/i);
        expect(SYSTEM_PROMPT_STATIC).toContain('bajo_minimo');
    });

    // Umbrales food cost por categoría (comida vs vino) — semáforo no contradictorio.
    test('regla de umbral por categoría (comida vs vino)', () => {
        expect(SYSTEM_PROMPT_STATIC).toMatch(/umbral por CATEGORÍA/i);
    });

    // Definición de periodos — "semana"/"mes" deben ser naturales (lun→hoy / día 1→hoy)
    // igual que el toggle del dashboard. Nació del fallo 17-jun: Omnes usó "últimos 7
    // días" para "semanal" y dio 33,6% cuando el dashboard mostraba 31% (semana natural).
    test('regla de definición de periodos alineada con el dashboard', () => {
        expect(SYSTEM_PROMPT_STATIC).toMatch(/DEFINICIÓN DE PERIODOS/i);
        expect(SYSTEM_PROMPT_STATIC).toMatch(/SEMANA NATURAL EN CURSO/i);
        expect(SYSTEM_PROMPT_STATIC).toMatch(/MES NATURAL EN CURSO/i);
        // No debe usar ventana móvil salvo petición literal.
        expect(SYSTEM_PROMPT_STATIC).toMatch(/LITERALMENTE/i);
    });

    // "Últimos N días" determinista — misma pregunta mismo día = misma ventana.
    // Nació del fallo 19-jun: dos ordenadores daban 16-18 vs 17-19 para "últimos 3 días".
    test('regla de ventana móvil determinista (últimos N días incluye hoy)', () => {
        expect(SYSTEM_PROMPT_STATIC).toMatch(/ÚLTIMOS N DÍAS/i);
        expect(SYSTEM_PROMPT_STATIC).toMatch(/SIEMPRE INCLUYE HOY/i);
        expect(SYSTEM_PROMPT_STATIC).toMatch(/misma ventana/i);
    });
});
