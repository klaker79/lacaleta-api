/**
 * resolverRango / resolverRangoArgs — ARREGLO DE RAÍZ de los fallos de fecha del chat.
 *
 * Antes el MODELO calculaba las fechas de cada período ("últimos 3 días", "semana"…):
 * aritmética poco fiable y NO determinista → la misma pregunta el mismo día daba
 * ventanas distintas en dos ordenadores. Ahora el modelo solo ELIGE un `periodo` de
 * una lista cerrada y el backend lo convierte aquí, determinista. Estos tests son la
 * red que garantiza que cada período cae SIEMPRE en el mismo rango [desde, hasta).
 *
 * Anclamos "hoy" = viernes 19-jun-2026 (mes 5 = junio en hora local).
 */
const { resolverRango, resolverRangoArgs, PERIODOS_VALIDOS, TOOLS } = require('../../src/services/chatService');

const HOY = new Date(2026, 5, 19); // viernes 19 jun 2026

describe('resolverRango — cada período cae en su rango exacto', () => {
    const casos = [
        ['hoy',            { desde: '2026-06-19', hasta: '2026-06-20' }],
        ['ayer',           { desde: '2026-06-18', hasta: '2026-06-19' }],
        ['semana',         { desde: '2026-06-15', hasta: '2026-06-22' }], // lunes 15 → +7
        ['semana_pasada',  { desde: '2026-06-08', hasta: '2026-06-15' }],
        ['mes',            { desde: '2026-06-01', hasta: '2026-07-01' }],
        ['mes_pasado',     { desde: '2026-05-01', hasta: '2026-06-01' }],
        ['ultimos_3_dias', { desde: '2026-06-17', hasta: '2026-06-20' }], // incluye hoy
        ['ultimos_7_dias', { desde: '2026-06-13', hasta: '2026-06-20' }],
        ['ultimos_30_dias',{ desde: '2026-05-21', hasta: '2026-06-20' }],
        ['año',            { desde: '2026-01-01', hasta: '2027-01-01' }],
        ['año_pasado',     { desde: '2025-01-01', hasta: '2026-01-01' }],
    ];
    test.each(casos)('%s', (periodo, esperado) => {
        expect(resolverRango(periodo, HOY)).toEqual(esperado);
    });

    test('período desconocido → null', () => {
        expect(resolverRango('este_trimestre', HOY)).toBeNull();
    });

    test('determinista: mismo período + mismo día → SIEMPRE el mismo rango', () => {
        expect(resolverRango('ultimos_3_dias', HOY)).toEqual(resolverRango('ultimos_3_dias', HOY));
        expect(resolverRango('semana', HOY)).toEqual(resolverRango('semana', HOY));
    });

    test('todos los PERIODOS_VALIDOS resuelven (ninguno cae en null)', () => {
        for (const p of PERIODOS_VALIDOS) {
            expect(resolverRango(p, HOY)).not.toBeNull();
        }
    });

    test('cruce de año: ayer/semana_pasada el 1-ene cruzan a diciembre', () => {
        const finDeAño = new Date(2026, 0, 1); // jueves 1 ene 2026
        expect(resolverRango('ayer', finDeAño)).toEqual({ desde: '2025-12-31', hasta: '2026-01-01' });
        expect(resolverRango('mes_pasado', finDeAño)).toEqual({ desde: '2025-12-01', hasta: '2026-01-01' });
    });
});

describe('resolverRangoArgs — período vs rango explícito vs error', () => {
    test('periodo tiene prioridad y se resuelve por el backend', () => {
        expect(resolverRangoArgs({ periodo: 'mes' }, HOY)).toEqual({ desde: '2026-06-01', hasta: '2026-07-01' });
    });

    test('rango explícito del usuario (fechas concretas) se respeta', () => {
        expect(resolverRangoArgs({ fecha_desde: '2026-03-01', fecha_hasta: '2026-03-16' }, HOY))
            .toEqual({ desde: '2026-03-01', hasta: '2026-03-16' });
    });

    test('periodo inválido → error claro', () => {
        expect(() => resolverRangoArgs({ periodo: 'la_semana_de_la_feria' }, HOY)).toThrow(/no reconocido/);
    });

    test('ni periodo ni fechas → error que obliga a reintentar', () => {
        expect(() => resolverRangoArgs({}, HOY)).toThrow(/periodo/);
    });
});

describe('estructura: las 4 tools de período exponen `periodo` y no exigen fechas', () => {
    const TOOLS_PERIODO = ['resumen_ventas_periodo', 'resumen_pyg', 'resumen_compras_periodo', 'resumen_mermas'];
    test.each(TOOLS_PERIODO)('%s tiene enum periodo y required vacío', (nombre) => {
        const tool = TOOLS.find(t => t.name === nombre);
        expect(tool).toBeTruthy();
        expect(tool.input_schema.properties.periodo).toBeTruthy();
        expect(Array.isArray(tool.input_schema.properties.periodo.enum)).toBe(true);
        expect(tool.input_schema.properties.periodo.enum).toEqual(PERIODOS_VALIDOS);
        // Ya NO se exige fecha_desde/fecha_hasta (el modelo usa periodo).
        expect(tool.input_schema.required).toEqual([]);
    });
});
