/**
 * Snapshot test del informe HTML — detecta regresiones visuales/estructurales.
 *
 * Cualquier cambio inadvertido en CSS embebido, estructura de secciones, etiquetas
 * traducidas, etc., se detecta antes de llegar a producción.
 *
 * Cuando un cambio sea intencional, regenerar el snapshot con:
 *   npx jest tests/unit/informeMensualHtml.snapshot.test.js -u
 *
 * 4 snapshots: ES con datos / EN con datos / ES sin datos / RM (Malasia)
 * — cubren combinaciones de idioma y moneda que el cliente final ve.
 */

const { renderHtml } = require('../../src/services/informeMensualHtml')._internals;

// Fecha fija para que el footer "Generado el ..." NO cambie entre runs.
const FECHA_FIJA = '2026-04-30T12:00:00.000Z';

/**
 * Normaliza el HTML antes del snapshot para evitar dependencias del runtime:
 *   - ICU del runner: separador de miles (presente en local, ausente en CI)
 *   - Formato de fecha del footer "Generado el ..." (cambia con ICU/locale)
 *   - Espacios no-rompibles (U+00A0) que Intl introduce a veces entre número y €
 *
 * El snapshot resultante captura estructura, CSS, etiquetas traducidas,
 * orden de secciones — no valores formateados de moneda/fecha (esos los
 * cubren los unit tests granulares con asserts flexibles).
 */
function normalizeForSnapshot(html) {
    return html
        // Espacios no-rompibles → espacio normal
        .replace(/ /g, ' ')
        // Separador es-ES de miles (1.234,56 → 1234,56). Lookahead [\d,] para
        // no romper URLs como "v1.0.0".
        .replace(/(\d)\.(\d{3})(?=[\d,])/g, '$1$2')
        // Separador en-US de miles (1,234.56 → 1234.56) por si el runner cae
        // a en-US como fallback.
        .replace(/(\d),(\d{3})(?=[\d.])/g, '$1$2')
        // Footer "Generado el ... · MindLoop CostOS" → placeholder.
        // El formato exacto de la fecha depende del ICU del runtime.
        .replace(
            /(Generado el|Generated on)\s+[^<·]+·\s+MindLoop CostOS/g,
            '$1 <FECHA_GEN> · MindLoop CostOS'
        );
}

function fixtureCompleto(moneda = '€') {
    return {
        periodo: {
            mes: '2026-04', mes_anterior: '2026-03',
            inicio: '2026-04-01', fin: '2026-05-01',
            fecha_generacion: FECHA_FIJA
        },
        restaurante: { nombre: 'La Caleta 102', moneda },
        ingresos: { mes_actual: 47200, mes_anterior: 42100, variacion_pct: 12.1 },
        food_cost: { mes_actual_pct: 33.8, cogs_actual: 15953.6 },
        pyg: {
            ingresos: 47200, cogs: 15953.6, margen_bruto: 31246.4,
            gastos_fijos: 18500, gastos_fijos_conceptos: 8,
            beneficio_neto: 12746.4, margen_neto_pct: 27
        },
        top_rentables: [
            { nombre: 'Pulpo a la gallega', vendidas: 142, ingresos: 4118, margen_pct: 71 },
            { nombre: 'Cocido madrileño', vendidas: 98, ingresos: 1862, margen_pct: 65 }
        ],
        top_problematicos: [
            { nombre: 'Solomillo Wellington', vendidas: 35, food_cost_pct: 48 }
        ],
        cambios_precio: [
            { ingrediente: 'Pulpo', precio_anterior: 18.5, precio_actual: 21, variacion_pct: 13.5 }
        ],
        stock: { valor_total: 8400, items_bajo_minimo: 4, items_sin_stock: 1 },
        top_proveedores: [
            { proveedor: 'Pescados Pepe', gasto_actual: 6200, gasto_anterior: 5800, variacion_pct: 6.9 },
            { proveedor: 'Frutas García', gasto_actual: 2100, gasto_anterior: 2050, variacion_pct: 2.4 }
        ],
        mermas: {
            valor_total: 145, num_registros: 3,
            top_motivos: [
                { motivo: 'caducado', num: 2, valor: 95 },
                { motivo: 'rotura', num: 1, valor: 50 }
            ]
        },
        evolucion_diaria: [
            { dia: '2026-04-01', ingresos: 1450 },
            { dia: '2026-04-08', ingresos: 1820 },
            { dia: '2026-04-15', ingresos: 1690 },
            { dia: '2026-04-22', ingresos: 2100 },
            { dia: '2026-04-29', ingresos: 1950 }
        ]
    };
}

function fixtureVacio() {
    return {
        periodo: {
            mes: '2026-04', mes_anterior: '2026-03',
            inicio: '2026-04-01', fin: '2026-05-01',
            fecha_generacion: FECHA_FIJA
        },
        restaurante: { nombre: 'Restaurante Test', moneda: '€' },
        ingresos: { mes_actual: 0, mes_anterior: 0, variacion_pct: null },
        food_cost: { mes_actual_pct: 0, cogs_actual: 0 },
        pyg: {
            ingresos: 0, cogs: 0, margen_bruto: 0,
            gastos_fijos: 0, gastos_fijos_conceptos: 0,
            beneficio_neto: 0, margen_neto_pct: 0
        },
        top_rentables: [],
        top_problematicos: [],
        cambios_precio: [],
        stock: { valor_total: 0, items_bajo_minimo: 0, items_sin_stock: 0 },
        top_proveedores: [],
        mermas: { valor_total: 0, num_registros: 0, top_motivos: [] },
        evolucion_diaria: []
    };
}

const ANALISIS_FIJO = {
    resumen_ejecutivo:
        // Sin separador de miles en el texto literal para que el snapshot
        // sea idéntico en CI (Node sin ICU completo) y en local.
        'Mes positivo con **beneficio neto de 12746 €** (+12% vs mes anterior). Food cost dentro del rango objetivo.',
    observaciones: [
        'Ingresos crecen 12.1% vs marzo.',
        'Pulpo subió 13.5% — revisar precio venta de Pulpo a la gallega.',
        'Solomillo Wellington con food cost 48%, fuera de rango.'
    ],
    recomendaciones: [
        {
            titulo: 'Resubir precio de Pulpo a la gallega',
            detalle: 'El plato bandera está a 71% de margen — buen colchón para repercutir +1€ sin perder volumen.',
            impacto: '+142 ud × 1€ = 142 €/mes'
        },
        {
            titulo: 'Revisar receta de Wellington',
            detalle: 'Food cost 48% indica raciones desproporcionadas o precio venta bajo.',
            impacto: 'reducir 8% food cost = 110 €/mes'
        }
    ],
    alertas: [
        { tipo: 'warning', mensaje: 'Pulpo +13.5%: revisar margen.' }
    ]
};

describe('informeMensualHtml — snapshots', () => {
    test('HTML completo en ES con datos reales', () => {
        const html = renderHtml({
            datos: fixtureCompleto('€'),
            analisis: ANALISIS_FIJO,
            restauranteNombre: 'La Caleta 102',
            moneda: '€',
            lang: 'es'
        });
        expect(normalizeForSnapshot(html)).toMatchSnapshot();
    });

    test('HTML completo en EN con moneda RM (tenant Malasia)', () => {
        const html = renderHtml({
            datos: fixtureCompleto('RM'),
            analisis: ANALISIS_FIJO,
            restauranteNombre: 'KL Restaurant',
            moneda: 'RM',
            lang: 'en'
        });
        expect(normalizeForSnapshot(html)).toMatchSnapshot();
    });

    test('HTML "estado vacío" — sin actividad operativa', () => {
        const html = renderHtml({
            datos: fixtureVacio(),
            analisis: {
                resumen_ejecutivo: 'Sin actividad este mes.',
                observaciones: [],
                recomendaciones: [],
                alertas: []
            },
            restauranteNombre: 'Restaurante Test',
            moneda: '€',
            lang: 'es'
        });
        expect(normalizeForSnapshot(html)).toMatchSnapshot();
    });

    test('HTML con análisis IA vacío — secciones opcionales desaparecen', () => {
        // Importante: cuando Claude no devuelve observaciones / recomendaciones,
        // las secciones correspondientes NO deben aparecer (no headers fantasma).
        const html = renderHtml({
            datos: fixtureCompleto('€'),
            analisis: {
                resumen_ejecutivo: 'Mes correcto.',
                observaciones: [],
                recomendaciones: [],
                alertas: []
            },
            restauranteNombre: 'Test',
            moneda: '€',
            lang: 'es'
        });
        // No queremos headers de secciones vacías
        expect(html).not.toMatch(/<h2>[^<]*Observaciones[^<]*<\/h2>\s*<ul[^>]*>\s*<\/ul>/);
        expect(html).not.toMatch(/<h2>[^<]*Recomendaciones[^<]*<\/h2>\s*<\/section>/);
        expect(normalizeForSnapshot(html)).toMatchSnapshot();
    });
});
