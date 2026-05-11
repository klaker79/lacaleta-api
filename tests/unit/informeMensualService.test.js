/**
 * Unit tests para informeMensualService.
 *
 * Cubre:
 *   - Cálculo del P&L (margen bruto, beneficio neto, margen neto %)
 *   - Cálculo de food cost (cogs/ingresos)
 *   - Variación vs mes anterior (incluye edge case anterior=0 → null)
 *   - Estructura del informe completo (todas las secciones presentes)
 *
 * Sin DB real: mock del pool que devuelve filas fijas según el SQL recibido.
 * El mock NO valida sintaxis SQL — solo responde al patrón de tabla.
 */

const { generarInformeMensual } = require('../../src/services/informeMensualService');

/**
 * Construye un mock del pool de pg que devuelve la fila correspondiente
 * según la tabla mencionada en el SQL. Permite simular cualquier escenario
 * de datos (ingresos altos, food cost alto, sin mermas, etc.) sin DB real.
 */
function makePoolMock({
    restaurante = { nombre: 'Test Resto', moneda: '€' },
    ingresos_actual = 0,
    ingresos_anterior = 0,
    cogs_actual = 0,
    gastos_fijos_total = 0,
    gastos_fijos_count = 0,
    stock_valor = 0,
    stock_bajo = 0,
    stock_sin = 0,
    top_rentables = [],
    top_problematicos = [],
    cambios_precio = [],
    top_proveedores = [],
    mermas_valor = 0,
    mermas_count = 0,
    mermas_motivos = [],
    evolucion = []
} = {}) {
    return {
        async query(sql) {
            const s = sql.toLowerCase();

            // SELECT nombre, moneda FROM restaurantes
            if (/from restaurantes/.test(s) && /nombre/.test(s) && /moneda/.test(s)) {
                return { rows: [restaurante] };
            }

            // Ingresos (ventas con CASE WHEN actual/anterior)
            if (/from ventas/.test(s) && /coalesce\(sum\(case when/.test(s)) {
                return { rows: [{ actual: ingresos_actual, anterior: ingresos_anterior }] };
            }

            // Top rentables / problematicos (JOIN ventas_diarias_resumen + recetas)
            if (/from ventas_diarias_resumen vdr/.test(s) && /food_cost_pct/.test(s)) {
                return { rows: top_problematicos };
            }
            if (/from ventas_diarias_resumen vdr/.test(s) && /margen_pct/.test(s)) {
                return { rows: top_rentables };
            }

            // Cambios de precio (precios_compra_diarios)
            if (/with actual as/.test(s) && /precios_compra_diarios/.test(s)) {
                return { rows: cambios_precio };
            }

            // Stock (ingredientes)
            if (/from ingredientes/.test(s) && /valor_total/.test(s)) {
                return { rows: [{
                    valor_total: stock_valor,
                    items_bajo_minimo: stock_bajo,
                    items_sin_stock: stock_sin
                }] };
            }

            // COGS (ventas_diarias_resumen sin join con recetas)
            if (/from ventas_diarias_resumen/.test(s) && /coalesce\(sum\(coste_ingredientes\)/.test(s)) {
                return { rows: [{ cogs_actual: cogs_actual }] };
            }

            // Gastos fijos
            if (/from gastos_fijos/.test(s)) {
                return { rows: [{ total: gastos_fijos_total, num_conceptos: gastos_fijos_count }] };
            }

            // Top proveedores
            if (/with actual as/.test(s) && /from pedidos/.test(s)) {
                return { rows: top_proveedores };
            }

            // Mermas total
            if (/from mermas/.test(s) && /num_registros/.test(s) && !/group by/.test(s)) {
                return { rows: [{ valor_total: mermas_valor, num_registros: mermas_count }] };
            }
            // Mermas top motivos
            if (/from mermas/.test(s) && /group by/.test(s)) {
                return { rows: mermas_motivos };
            }

            // Evolución diaria (ventas group by DATE(fecha))
            if (/from ventas/.test(s) && /group by date\(fecha\)/.test(s)) {
                return { rows: evolucion };
            }

            // Fallback
            return { rows: [] };
        }
    };
}

describe('informeMensualService — cálculos del P&L', () => {
    test('throws si no se pasa restauranteId', async () => {
        await expect(generarInformeMensual(makePoolMock(), null, '2026-04'))
            .rejects.toThrow(/restauranteId requerido/);
    });

    test('caso completo: ingresos 10.000€, COGS 3.500€, gastos 4.000€ → beneficio 2.500€, margen 25%', async () => {
        const pool = makePoolMock({
            ingresos_actual: 10000,
            ingresos_anterior: 8000,
            cogs_actual: 3500,
            gastos_fijos_total: 4000,
            gastos_fijos_count: 5
        });
        const r = await generarInformeMensual(pool, 3, '2026-04');

        expect(r.pyg.ingresos).toBe(10000);
        expect(r.pyg.cogs).toBe(3500);
        expect(r.pyg.margen_bruto).toBe(6500);
        expect(r.pyg.gastos_fijos).toBe(4000);
        expect(r.pyg.gastos_fijos_conceptos).toBe(5);
        expect(r.pyg.beneficio_neto).toBe(2500);
        expect(r.pyg.margen_neto_pct).toBe(25);
        // food cost = 3500/10000 = 35%
        expect(r.food_cost.mes_actual_pct).toBe(35);
        // variación ingresos = (10000-8000)/8000 = 25%
        expect(r.ingresos.variacion_pct).toBe(25);
    });

    test('beneficio NEGATIVO: ingresos 5.000€, COGS 2.500€, gastos 3.500€ → beneficio -1.000€', async () => {
        const pool = makePoolMock({
            ingresos_actual: 5000,
            cogs_actual: 2500,
            gastos_fijos_total: 3500
        });
        const r = await generarInformeMensual(pool, 3, '2026-04');

        expect(r.pyg.margen_bruto).toBe(2500);
        expect(r.pyg.beneficio_neto).toBe(-1000);
        expect(r.pyg.margen_neto_pct).toBe(-20);
    });

    test('edge: ingresos = 0 NO causa división por cero', async () => {
        const pool = makePoolMock({
            ingresos_actual: 0,
            cogs_actual: 100,
            gastos_fijos_total: 500
        });
        const r = await generarInformeMensual(pool, 3, '2026-04');

        expect(r.food_cost.mes_actual_pct).toBe(0);
        expect(r.pyg.margen_neto_pct).toBe(0);
        expect(r.pyg.beneficio_neto).toBe(-600); // -100 - 500
        expect(r.ingresos.variacion_pct).toBeNull();
    });

    test('edge: mes_anterior = 0 → variacion_pct es null (no Infinity)', async () => {
        const pool = makePoolMock({
            ingresos_actual: 5000,
            ingresos_anterior: 0
        });
        const r = await generarInformeMensual(pool, 3, '2026-04');
        expect(r.ingresos.variacion_pct).toBeNull();
    });

    test('redondeos: ingresos 100.005€ COGS 33.333,33€ → food_cost a 2 decimales', async () => {
        const pool = makePoolMock({
            ingresos_actual: 100005,
            cogs_actual: 33333.33
        });
        const r = await generarInformeMensual(pool, 3, '2026-04');
        // 33333.33 / 100005 * 100 = 33.331...
        // Redondeado a 2 decimales
        expect(r.food_cost.mes_actual_pct).toBeCloseTo(33.33, 2);
        // cogs_actual también redondeado
        expect(r.food_cost.cogs_actual).toBe(33333.33);
    });
});

describe('informeMensualService — estructura del informe', () => {
    test('devuelve TODAS las secciones requeridas con shape correcto', async () => {
        const pool = makePoolMock({
            ingresos_actual: 1000,
            cogs_actual: 300,
            gastos_fijos_total: 400,
            top_rentables: [{ nombre: 'Plato A', vendidas: 10, ingresos: 200, margen_pct: 60 }],
            top_problematicos: [{ nombre: 'Plato B', vendidas: 5, food_cost_pct: 55 }],
            cambios_precio: [{ ingrediente: 'tomate', precio_anterior: 1, precio_actual: 1.5, variacion_pct: 50 }],
            top_proveedores: [{ proveedor: 'Frutas SA', gasto_actual: 500, gasto_anterior: 400, variacion_pct: 25 }],
            mermas_valor: 30,
            mermas_count: 2,
            mermas_motivos: [{ motivo: 'caducado', num: 1, valor: 20 }],
            evolucion: [{ dia: '2026-04-01', ingresos: 100 }, { dia: '2026-04-02', ingresos: 200 }]
        });
        const r = await generarInformeMensual(pool, 3, '2026-04');

        // Periodo
        expect(r.periodo).toMatchObject({
            mes: '2026-04',
            mes_anterior: '2026-03',
            inicio: '2026-04-01',
            fin: '2026-05-01'
        });
        expect(r.periodo.fecha_generacion).toBeDefined();

        // Restaurante
        expect(r.restaurante).toMatchObject({ nombre: 'Test Resto', moneda: '€' });

        // Todas las secciones presentes
        expect(r.ingresos).toBeDefined();
        expect(r.food_cost).toBeDefined();
        expect(r.pyg).toBeDefined();
        expect(r.top_rentables).toHaveLength(1);
        expect(r.top_problematicos).toHaveLength(1);
        expect(r.cambios_precio).toHaveLength(1);
        expect(r.stock).toBeDefined();
        expect(r.top_proveedores).toHaveLength(1);
        expect(r.mermas).toMatchObject({ valor_total: 30, num_registros: 2 });
        expect(r.mermas.top_motivos).toHaveLength(1);
        expect(r.evolucion_diaria).toHaveLength(2);
    });

    test('sin datos: arrays vacíos, valores 0, sin crashes', async () => {
        const pool = makePoolMock(); // todos los defaults a 0/[]
        const r = await generarInformeMensual(pool, 3, '2026-04');

        expect(r.pyg.beneficio_neto).toBe(0);
        expect(r.food_cost.mes_actual_pct).toBe(0);
        expect(r.top_rentables).toEqual([]);
        expect(r.top_problematicos).toEqual([]);
        expect(r.mermas.num_registros).toBe(0);
        expect(r.evolucion_diaria).toEqual([]);
    });
});

describe('informeMensualService — rangoMes / parsing de mes', () => {
    test('mes válido YYYY-MM produce inicio/fin correctos y mes_anterior', async () => {
        const pool = makePoolMock();
        const r = await generarInformeMensual(pool, 3, '2026-03');
        expect(r.periodo.mes).toBe('2026-03');
        expect(r.periodo.inicio).toBe('2026-03-01');
        expect(r.periodo.fin).toBe('2026-04-01');
        expect(r.periodo.mes_anterior).toBe('2026-02');
    });

    test('transición de año: enero 2026 → mes_anterior = diciembre 2025', async () => {
        const pool = makePoolMock();
        const r = await generarInformeMensual(pool, 3, '2026-01');
        expect(r.periodo.mes).toBe('2026-01');
        expect(r.periodo.inicio).toBe('2026-01-01');
        expect(r.periodo.fin).toBe('2026-02-01');
        expect(r.periodo.mes_anterior).toBe('2025-12');
    });

    test('formato inválido (YYYY-M, no 2 dígitos) cae a mes actual sin crash', async () => {
        const pool = makePoolMock();
        const r = await generarInformeMensual(pool, 3, '2026-4'); // formato malo
        // No throw — usa mes actual. La etiqueta tendrá el mes actual.
        expect(r.periodo.mes).toMatch(/^\d{4}-\d{2}$/);
    });

    test('mes undefined → coge mes en curso', async () => {
        const pool = makePoolMock();
        const r = await generarInformeMensual(pool, 3);
        expect(r.periodo.mes).toMatch(/^\d{4}-\d{2}$/);
        // mes_anterior debe ser válido también
        expect(r.periodo.mes_anterior).toMatch(/^\d{4}-\d{2}$/);
    });
});
