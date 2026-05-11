/**
 * Unit tests para informeMensualHtml — helpers internos del renderizado.
 *
 * Bug class que previenen:
 *   - XSS si el nombre de un proveedor / receta / motivo de merma contiene
 *     HTML/JS. El informe se imprime y se enseña a clientes — un script
 *     ejecutado ahí es ridículo.
 *   - Moneda incorrecta en tenants Malasia. La regla canónica (memoria
 *     feedback_multicurrency_rm): nunca hardcodear €.
 *   - Crash en sparkline cuando hay 0 o 1 puntos (mes en blanco / día 1).
 *
 * Los helpers están exportados como `_internals` solo-test desde el módulo.
 */

const {
    escapeHtml, fmtMoneda, fmtPct, fmtVariacion,
    classFoodCost, mdToHtml, renderSparkline, renderHtml
} = require('../../src/services/informeMensualHtml')._internals;

describe('escapeHtml — anti XSS', () => {
    test('escapa <script> y atributos peligrosos', () => {
        const r = escapeHtml('<script>alert(1)</script>');
        expect(r).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(r).not.toContain('<script>');
    });

    test('escapa comillas y ampersand', () => {
        expect(escapeHtml('"hola" & \'mundo\''))
            .toBe('&quot;hola&quot; &amp; &#39;mundo&#39;');
    });

    test('null/undefined devuelven cadena vacía sin crash', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    test('texto sin caracteres especiales pasa intacto', () => {
        expect(escapeHtml('Pulpo a la gallega')).toBe('Pulpo a la gallega');
    });

    test('convierte números a string sin romper', () => {
        expect(escapeHtml(123)).toBe('123');
    });
});

describe('fmtMoneda — multi-currency', () => {
    // Nota: el separador de miles depende del ICU del Node runtime. Usamos
    // regex flexibles para tolerar tanto "1.234,56 €" (ICU completo) como
    // "1234,56 €" (ICU minimal de CI). Lo que importa es: símbolo correcto,
    // posición correcta, 2 decimales con coma.
    test('€: símbolo al final con espacio', () => {
        expect(fmtMoneda(1234.56, '€')).toMatch(/^1\.?234,56 €$/);
    });

    test('RM: símbolo al principio con espacio', () => {
        expect(fmtMoneda(1234.56, 'RM')).toMatch(/^RM 1\.?234,56$/);
    });

    test('USD: símbolo al principio', () => {
        expect(fmtMoneda(99.5, '$')).toBe('$ 99,50');
    });

    test('valor 0', () => {
        expect(fmtMoneda(0, '€')).toBe('0,00 €');
        expect(fmtMoneda(0, 'RM')).toBe('RM 0,00');
    });

    test('valor negativo', () => {
        expect(fmtMoneda(-150, '€')).toBe('-150,00 €');
    });

    test('valor null/undefined/NaN → 0 respetando posición del símbolo', () => {
        expect(fmtMoneda(null, '€')).toBe('0,00 €');
        expect(fmtMoneda(undefined, 'RM')).toBe('RM 0,00');
        expect(fmtMoneda(NaN, '€')).toBe('0,00 €');
        expect(fmtMoneda('abc', '€')).toBe('0,00 €');
    });

    test('string numérico se parsea', () => {
        expect(fmtMoneda('1234.5', '€')).toMatch(/^1\.?234,50 €$/);
    });
});

describe('fmtPct y fmtVariacion', () => {
    test('fmtPct: 1 decimal con %', () => {
        expect(fmtPct(33.456)).toBe('33.5%');
        expect(fmtPct(0)).toBe('0.0%');
    });

    test('fmtPct: null/undefined/NaN → "—"', () => {
        expect(fmtPct(null)).toBe('—');
        expect(fmtPct(undefined)).toBe('—');
        expect(fmtPct('foo')).toBe('—');
    });

    test('fmtVariacion: positivo lleva "+"', () => {
        expect(fmtVariacion(25.5)).toBe('+25.5%');
        expect(fmtVariacion(0)).toBe('0.0%'); // 0 no es positivo, no + prefix
    });

    test('fmtVariacion: negativo lleva "-" automático', () => {
        expect(fmtVariacion(-12.3)).toBe('-12.3%');
    });

    test('fmtVariacion: null → "—"', () => {
        expect(fmtVariacion(null)).toBe('—');
    });
});

describe('classFoodCost — clasificación de food cost por umbrales', () => {
    test('≤30 → kpi-good', () => {
        expect(classFoodCost(25)).toBe('kpi-good');
        expect(classFoodCost(30)).toBe('kpi-good');
    });
    test('31-35 → kpi-warn', () => {
        expect(classFoodCost(31)).toBe('kpi-warn');
        expect(classFoodCost(35)).toBe('kpi-warn');
    });
    test('36-40 → kpi-orange', () => {
        expect(classFoodCost(36)).toBe('kpi-orange');
        expect(classFoodCost(40)).toBe('kpi-orange');
    });
    test('>40 → kpi-bad', () => {
        expect(classFoodCost(41)).toBe('kpi-bad');
        expect(classFoodCost(99)).toBe('kpi-bad');
    });
    test('null → kpi-neutral', () => {
        expect(classFoodCost(null)).toBe('kpi-neutral');
    });
});

describe('mdToHtml — mini parser markdown', () => {
    test('**negrita** se convierte a <strong>', () => {
        expect(mdToHtml('Hola **mundo**'))
            .toBe('Hola <strong>mundo</strong>');
    });

    test('saltos de línea → <br>', () => {
        expect(mdToHtml('línea 1\nlínea 2'))
            .toBe('línea 1<br>línea 2');
    });

    test('escapa HTML antes de aplicar markdown (anti XSS)', () => {
        // El < y > se escapan ANTES del parser markdown → no debe quedar HTML ejecutable
        const r = mdToHtml('<script>alert(1)</script>');
        expect(r).not.toContain('<script>');
        expect(r).toContain('&lt;script&gt;');
    });

    test('null/empty → string vacío', () => {
        expect(mdToHtml(null)).toBe('');
        expect(mdToHtml('')).toBe('');
    });
});

describe('renderSparkline — SVG edge cases', () => {
    test('array vacío → string vacío (no crash)', () => {
        expect(renderSparkline([], '€', 'es')).toBe('');
    });

    test('1 solo punto → string vacío (necesita ≥2)', () => {
        expect(renderSparkline([{ dia: '2026-04-01', ingresos: 100 }], '€', 'es')).toBe('');
    });

    test('2 puntos → SVG válido con polyline y area', () => {
        const svg = renderSparkline([
            { dia: '2026-04-01', ingresos: 100 },
            { dia: '2026-04-02', ingresos: 200 }
        ], '€', 'es');
        expect(svg).toContain('<svg');
        expect(svg).toContain('<polyline');
        // gradient fill area
        expect(svg).toContain('url(#sl-area)');
        // marca el pico con la cifra (cantidad y moneda, separador miles flexible)
        expect(svg).toMatch(/200,00 €/);
    });

    test('nombre de moneda no €: símbolo correcto en label del pico', () => {
        const svg = renderSparkline([
            { dia: '2026-04-01', ingresos: 100 },
            { dia: '2026-04-02', ingresos: 500 }
        ], 'RM', 'en');
        expect(svg).toMatch(/RM 500,00/);
        expect(svg).not.toContain('€');
    });

    test('valores 0 no rompen división (max=1 fallback)', () => {
        const svg = renderSparkline([
            { dia: '2026-04-01', ingresos: 0 },
            { dia: '2026-04-02', ingresos: 0 }
        ], '€', 'es');
        expect(svg).toContain('<svg');
        expect(svg).not.toContain('NaN');
        expect(svg).not.toContain('Infinity');
    });
});

describe('renderHtml — integración (sin Claude)', () => {
    function makeDatos(overrides = {}) {
        return {
            periodo: {
                mes: '2026-04', mes_anterior: '2026-03',
                inicio: '2026-04-01', fin: '2026-05-01',
                fecha_generacion: '2026-04-30T12:00:00Z'
            },
            restaurante: { nombre: 'Test Resto', moneda: '€' },
            ingresos: { mes_actual: 10000, mes_anterior: 8000, variacion_pct: 25 },
            food_cost: { mes_actual_pct: 35, cogs_actual: 3500 },
            pyg: {
                ingresos: 10000, cogs: 3500, margen_bruto: 6500,
                gastos_fijos: 4000, gastos_fijos_conceptos: 5,
                beneficio_neto: 2500, margen_neto_pct: 25
            },
            top_rentables: [],
            top_problematicos: [],
            cambios_precio: [],
            stock: { valor_total: 1000, items_bajo_minimo: 2, items_sin_stock: 0 },
            top_proveedores: [],
            mermas: { valor_total: 0, num_registros: 0, top_motivos: [] },
            evolucion_diaria: [],
            ...overrides
        };
    }
    const ANALISIS_OK = {
        resumen_ejecutivo: 'Buen mes', observaciones: [], recomendaciones: [], alertas: []
    };

    test('XSS: nombre del restaurante con <script> no se ejecuta', () => {
        const datos = makeDatos();
        const html = renderHtml({
            datos, analisis: ANALISIS_OK,
            restauranteNombre: '<script>alert(1)</script>',
            moneda: '€', lang: 'es'
        });
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    test('XSS: nombre de plato malicioso queda escapado', () => {
        const datos = makeDatos({
            top_rentables: [{
                nombre: '<img src=x onerror=alert(1)>',
                vendidas: 5, ingresos: 100, margen_pct: 50
            }]
        });
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: '€', lang: 'es'
        });
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    test('Multi-currency RM: NO aparece "€" en ningún sitio del HTML', () => {
        const datos = makeDatos({ restaurante: { nombre: 'KL Resto', moneda: 'RM' } });
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'KL Resto',
            moneda: 'RM', lang: 'en'
        });
        // Verificamos que TODOS los importes monetarios usan RM, no €
        // (tolera "RM 10.000,00" o "RM 10000,00" según ICU del Node runtime)
        expect(html).toMatch(/RM 10\.?000,00/);
        // No queremos "€" en cifras (puede aparecer en CSS gradient names? no debería)
        // El CSS no usa el símbolo, así que cualquier € sería un bug.
        expect(html).not.toMatch(/\d[\s.,]\d*\s*€/);
    });

    test('lang=en: textos en inglés en el HTML', () => {
        const datos = makeDatos();
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: 'RM', lang: 'en'
        });
        expect(html).toContain('Monthly Executive Report');
        expect(html).toContain('Net profit');
        expect(html).not.toContain('Beneficio neto');
    });

    test('lang=es: textos en español', () => {
        const datos = makeDatos();
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: '€', lang: 'es'
        });
        expect(html).toContain('Informe Ejecutivo Mensual');
        expect(html).toContain('Beneficio neto');
        expect(html).not.toContain('Monthly Executive Report');
    });

    test('beneficio neto NEGATIVO → clase kpi-bad aplicada', () => {
        const datos = makeDatos({
            pyg: {
                ingresos: 5000, cogs: 2500, margen_bruto: 2500,
                gastos_fijos: 3500, gastos_fijos_conceptos: 3,
                beneficio_neto: -1000, margen_neto_pct: -20
            }
        });
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: '€', lang: 'es'
        });
        expect(html).toMatch(/<strong class="kpi-bad">/);
    });

    test('mermas vacías muestran mensaje "perfecto" en lugar de tabla', () => {
        const datos = makeDatos({ mermas: { valor_total: 0, num_registros: 0, top_motivos: [] } });
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: '€', lang: 'es'
        });
        expect(html).toContain('Ningún registro de merma');
    });

    test('botón imprimir/PDF presente en el HTML', () => {
        const datos = makeDatos();
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: '€', lang: 'es'
        });
        expect(html).toContain('window.print()');
        expect(html).toContain('Imprimir');
    });

    test('@media print regla CSS presente (PDF-friendly)', () => {
        const datos = makeDatos();
        const html = renderHtml({
            datos, analisis: ANALISIS_OK, restauranteNombre: 'OK',
            moneda: '€', lang: 'es'
        });
        expect(html).toContain('@media print');
    });
});
