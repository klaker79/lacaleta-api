/**
 * tests/unit/menuEngineeringService.test.js
 *
 * Unit tests del servicio que es FUENTE ÚNICA DE VERDAD para BCG y Omnes.
 * Los endpoints REST y las tools del chat consumen este servicio — si
 * cambia su contrato sin que alguno de los dos se entere, los números
 * del chat empiezan a divergir de los de la UI sin que nadie lo note.
 *
 * Mockeamos `pool.query` para no necesitar DB. Verificamos:
 *   - Shape exacto del resultado (campos esperados).
 *   - Clasificación BCG con regla canónica (popular Y rentable = estrella, etc).
 *   - Promedios incluidos en `metricas` por plato (mismos en todos los items).
 *   - Filtro de periodo se inyecta cuando llegan {desde, hasta}.
 *   - Multi-tenancy: TODAS las queries reciben restauranteId.
 *   - Compat back: sin periodo, devuelve histórico.
 */

const path = require('path');

// Resolver el módulo a auditar
const SERVICE_PATH = path.resolve(__dirname, '../../src/services/menuEngineeringService');

/**
 * Helper para fabricar un fake pool que captura todas las llamadas a query()
 * y permite devolver respuestas pre-cocinadas en orden.
 */
function fakePool(responsesInOrder = []) {
    const calls = [];
    let idx = 0;
    return {
        calls,
        query: jest.fn((sql, params) => {
            calls.push({ sql, params });
            const next = responsesInOrder[idx++] ?? { rows: [] };
            return Promise.resolve(next);
        })
    };
}

describe('menuEngineeringService.getMenuEngineering', () => {
    let service;
    beforeAll(() => {
        // require dentro de beforeAll para que jest no cachee si ya se requiere arriba
        service = require(SERVICE_PATH);
    });

    test('todas las queries SQL reciben restauranteId en $1 (multi-tenancy)', async () => {
        const pool = fakePool([
            { rows: [] }, // ventas vacías → early return
        ]);
        await service.getMenuEngineering(pool, 99);
        // La primera query (siempre) debe incluir restauranteId
        expect(pool.calls[0].params[0]).toBe(99);
        // Toda query subsiguiente, también
        pool.calls.forEach(call => {
            expect(call.params).toEqual(expect.arrayContaining([99]));
        });
    });

    test('si no hay ventas, devuelve array vacío', async () => {
        const pool = fakePool([{ rows: [] }]);
        const result = await service.getMenuEngineering(pool, 1);
        expect(result).toEqual([]);
        // Solo una query (la primera, ventas) cuando entra al early return
        expect(pool.calls).toHaveLength(1);
    });

    test('inyecta filtro de periodo cuando llegan desde+hasta válidos', async () => {
        const pool = fakePool([{ rows: [] }]);
        await service.getMenuEngineering(pool, 7, {
            desde: '2026-01-01',
            hasta: '2026-02-01'
        });
        // Q1 (ventas) debe llevar 3 params: [restauranteId, desde, hasta]
        expect(pool.calls[0].params).toEqual([7, '2026-01-01', '2026-02-01']);
        expect(pool.calls[0].sql).toMatch(/v\.fecha\s*>=\s*\$2/);
        expect(pool.calls[0].sql).toMatch(/v\.fecha\s*<\s*\$3/);
    });

    test('sin periodo, NO inyecta el filtro de fecha (compat back)', async () => {
        const pool = fakePool([{ rows: [] }]);
        await service.getMenuEngineering(pool, 7);
        expect(pool.calls[0].params).toEqual([7]);
        expect(pool.calls[0].sql).not.toMatch(/v\.fecha\s*>=/);
    });

    test('clasifica plato popular+rentable como ESTRELLA', async () => {
        // 2 platos: uno con muchas ventas + margen alto, otro con pocas
        // y margen bajo. Esperamos estrella + perro.
        const pool = fakePool([
            {
                rows: [
                    { id: 1, nombre: 'Plato A', categoria: 'alimentos', precio_venta: '20', ingredientes: '[]', porciones: 1, cantidad_vendida: '100', total_ventas: '2000' },
                    { id: 2, nombre: 'Plato B', categoria: 'alimentos', precio_venta: '10', ingredientes: '[]', porciones: 1, cantidad_vendida: '10', total_ventas: '100' }
                ]
            },
            { rows: [] }, // ingredientes
            { rows: [{ id: 1, porciones: 1, ingredientes: '[]' }, { id: 2, porciones: 1, ingredientes: '[]' }] }
        ]);
        const result = await service.getMenuEngineering(pool, 1);
        expect(result).toHaveLength(2);

        const a = result.find(p => p.id === 1);
        const b = result.find(p => p.id === 2);
        // Sin ingredientes → coste 0, así que margen = precio_venta
        expect(a.margen).toBeCloseTo(20);
        expect(b.margen).toBeCloseTo(10);
        // A es popular (100 ≥ 0.7×media=38.5) y rentable (20 ≥ promedioMargen)
        expect(a.clasificacion).toBe('estrella');
        // B no popular (10 < 38.5) → puzzle si rentable, perro si no
        expect(['puzzle', 'perro']).toContain(b.clasificacion);
    });

    test('cada plato incluye metricas.promedio* idénticas (misma media para todos)', async () => {
        const pool = fakePool([
            {
                rows: [
                    { id: 1, nombre: 'X', categoria: 'alimentos', precio_venta: '15', ingredientes: '[]', porciones: 1, cantidad_vendida: '50', total_ventas: '750' },
                    { id: 2, nombre: 'Y', categoria: 'alimentos', precio_venta: '12', ingredientes: '[]', porciones: 1, cantidad_vendida: '30', total_ventas: '360' }
                ]
            },
            { rows: [] },
            { rows: [{ id: 1, porciones: 1, ingredientes: '[]' }, { id: 2, porciones: 1, ingredientes: '[]' }] }
        ]);
        const result = await service.getMenuEngineering(pool, 3);
        const m1 = result[0].metricas;
        const m2 = result[1].metricas;
        expect(m1.promedioPopularidad).toBeCloseTo(m2.promedioPopularidad);
        expect(m1.promedioMargen).toBeCloseTo(m2.promedioMargen);
        expect(m1.promedioFoodCost).toBeCloseTo(m2.promedioFoodCost);
        // promedioMargen es PONDERADO por ventas, no aritmético simple
        // sumaMargenes = 15×50 + 12×30 = 750 + 360 = 1110
        // total_ventas = 50 + 30 = 80
        // promedioMargen = 1110/80 = 13.875
        expect(m1.promedioMargen).toBeCloseTo(13.875, 2);
    });

    test('shape: cada plato lleva los campos esperados por la UI y el chat', async () => {
        const pool = fakePool([
            {
                rows: [
                    { id: 99, nombre: 'TEST', categoria: 'alimentos', precio_venta: '20', ingredientes: '[]', porciones: 1, cantidad_vendida: '40', total_ventas: '800' }
                ]
            },
            { rows: [] },
            { rows: [{ id: 99, porciones: 1, ingredientes: '[]' }] }
        ]);
        const [p] = await service.getMenuEngineering(pool, 1);
        const expectedKeys = ['id', 'nombre', 'categoria', 'precio_venta', 'cantidad_vendida',
            'total_ventas', 'coste', 'margen', 'foodCost', 'popularidad', 'clasificacion', 'metricas'];
        expectedKeys.forEach(k => expect(p).toHaveProperty(k));
    });
});

describe('menuEngineeringService.getOmnesAnalysis', () => {
    let service;
    beforeAll(() => {
        service = require(SERVICE_PATH);
    });

    test('multi-tenancy: la query SQL recibe restauranteId en $1', async () => {
        const pool = fakePool([{ rows: [] }]);
        await service.getOmnesAnalysis(pool, 42);
        expect(pool.calls[0].params[0]).toBe(42);
    });

    test('sin platos devuelve los 3 sub-análisis con estado sin_datos', async () => {
        const pool = fakePool([{ rows: [] }]);
        const result = await service.getOmnesAnalysis(pool, 1);
        expect(result.dispersion.estado).toBe('sin_datos');
        expect(result.amplitud.estado).toBe('sin_datos');
        expect(result.calidad_precio.estado).toBe('sin_datos');
        expect(typeof result.recomendacion_global).toBe('string');
    });

    test('con periodo válido, filtra ventas al rango', async () => {
        const pool = fakePool([{ rows: [] }]);
        await service.getOmnesAnalysis(pool, 5, {
            desde: '2026-03-01',
            hasta: '2026-04-01'
        });
        expect(pool.calls[0].params).toEqual([5, '2026-03-01', '2026-04-01']);
    });

    test('shape de la respuesta: periodo + dispersion + dispersion_por_categoria + amplitud + calidad_precio + recomendacion_global', async () => {
        const pool = fakePool([
            {
                rows: [
                    { id: 1, nombre: 'A', categoria: 'entrantes', precio_venta: '10', cantidad_vendida: '5' },
                    { id: 2, nombre: 'B', categoria: 'principales', precio_venta: '25', cantidad_vendida: '3' }
                ]
            }
        ]);
        const result = await service.getOmnesAnalysis(pool, 1);
        expect(Object.keys(result).sort()).toEqual(
            ['amplitud', 'calidad_precio', 'dispersion', 'dispersion_por_categoria', 'periodo', 'recomendacion_global']
        );
        // Dispersión global: 25/10 = 2.5×
        expect(result.dispersion.valor).toBeCloseTo(2.5);
        expect(result.dispersion.plato_max).toBe('B');
        expect(result.dispersion.plato_min).toBe('A');
        // Por categoría: cada cat solo tiene 1 plato → array vacío
        expect(result.dispersion_por_categoria).toEqual([]);
    });

    test('dispersion_por_categoria solo incluye categorías con ≥ 2 platos', async () => {
        const pool = fakePool([
            {
                rows: [
                    { id: 1, nombre: 'Pulpo', categoria: 'entrantes', precio_venta: '12', cantidad_vendida: '5' },
                    { id: 2, nombre: 'Ostra', categoria: 'entrantes', precio_venta: '4', cantidad_vendida: '3' },
                    { id: 3, nombre: 'Lubina', categoria: 'principales', precio_venta: '24', cantidad_vendida: '2' },
                    { id: 4, nombre: 'Solomillo', categoria: 'principales', precio_venta: '30', cantidad_vendida: '1' },
                    { id: 5, nombre: 'Tarta', categoria: 'postres', precio_venta: '6', cantidad_vendida: '4' }
                ]
            }
        ]);
        const result = await service.getOmnesAnalysis(pool, 1);
        // entrantes y principales tienen 2 platos cada uno; postres solo 1
        const cats = result.dispersion_por_categoria.map(c => c.categoria);
        expect(cats).toContain('entrantes');
        expect(cats).toContain('principales');
        expect(cats).not.toContain('postres');
        // entrantes: 12/4 = 3×
        const ent = result.dispersion_por_categoria.find(c => c.categoria === 'entrantes');
        expect(ent.valor).toBeCloseTo(3);
        // principales: 30/24 = 1.25×
        const pri = result.dispersion_por_categoria.find(c => c.categoria === 'principales');
        expect(pri.valor).toBeCloseTo(1.25);
        // Verifica que la global cuenta TODOS (incluida la tarta): 30/4 = 7.5×
        expect(result.dispersion.valor).toBeCloseTo(7.5);
    });
});

describe('menuEngineeringService.resolverPeriodo', () => {
    let service;
    beforeAll(() => {
        service = require(SERVICE_PATH);
    });

    test('sin desde ni hasta → null (compat back)', () => {
        expect(service.resolverPeriodo(undefined, undefined)).toBeNull();
        expect(service.resolverPeriodo(null, null)).toBeNull();
        expect(service.resolverPeriodo('', '')).toBeNull();
    });

    test('con fechas válidas → devuelve el objeto periodo', () => {
        const p = service.resolverPeriodo('2026-01-01', '2026-02-01');
        expect(p).toEqual({ desde: '2026-01-01', hasta: '2026-02-01' });
    });

    test('con fecha inválida (formato malo) → null', () => {
        expect(service.resolverPeriodo('hola', '2026-02-01')).toBeNull();
        expect(service.resolverPeriodo('2026-01-01', 'mundo')).toBeNull();
    });
});
