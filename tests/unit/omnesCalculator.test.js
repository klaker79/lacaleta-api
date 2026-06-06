/**
 * Unit tests para omnesCalculator (Principios de Omnes).
 *
 * Funciones puras sin DB — testean la lógica de los 3 sub-análisis
 * + la recomendación global combinada.
 */
const {
    calcularDispersion,
    calcularDispersionPorCategoria,
    calcularAmplitud,
    calcularCalidadPrecio,
    generarRecomendacionGlobal
} = require('../../src/utils/omnesCalculator');

describe('omnesCalculator.calcularDispersion', () => {
    test('0 platos → sin_datos', () => {
        const r = calcularDispersion([]);
        expect(r.estado).toBe('sin_datos');
        expect(r.valor).toBeNull();
    });

    test('1 plato → ratio 1, ok', () => {
        const r = calcularDispersion([{ precio_venta: 10, nombre: 'A' }]);
        expect(r.valor).toBe(1);
        expect(r.estado).toBe('ok');
        expect(r.precio_min).toBe(10);
        expect(r.precio_max).toBe(10);
    });

    test('ratio exactamente 2.5 → ok', () => {
        const r = calcularDispersion([
            { precio_venta: 10, nombre: 'A' },
            { precio_venta: 25, nombre: 'B' }
        ]);
        expect(r.valor).toBe(2.5);
        expect(r.estado).toBe('ok');
    });

    test('ratio 3.2 → alta', () => {
        const r = calcularDispersion([
            { precio_venta: 5, nombre: 'A' },
            { precio_venta: 16, nombre: 'B' }
        ]);
        expect(r.valor).toBe(3.2);
        expect(r.estado).toBe('alta');
    });

    test('ratio 5 → muy_alta', () => {
        const r = calcularDispersion([
            { precio_venta: 4, nombre: 'A' },
            { precio_venta: 20, nombre: 'B' }
        ]);
        expect(r.estado).toBe('muy_alta');
    });

    test('todos los platos iguales → ratio 1, ok', () => {
        const r = calcularDispersion([
            { precio_venta: 12, nombre: 'A' },
            { precio_venta: 12, nombre: 'B' },
            { precio_venta: 12, nombre: 'C' }
        ]);
        expect(r.valor).toBe(1);
        expect(r.estado).toBe('ok');
    });

    test('plato con precio 0 → se ignora', () => {
        const r = calcularDispersion([
            { precio_venta: 0, nombre: 'Inválido' },
            { precio_venta: 10, nombre: 'A' },
            { precio_venta: 15, nombre: 'B' }
        ]);
        expect(r.precio_min).toBe(10);
        expect(r.precio_max).toBe(15);
    });

    test('input no-array → sin_datos', () => {
        expect(calcularDispersion(null).estado).toBe('sin_datos');
        expect(calcularDispersion(undefined).estado).toBe('sin_datos');
    });
});

describe('omnesCalculator.calcularDispersionPorCategoria', () => {
    test('array vacío → []', () => {
        expect(calcularDispersionPorCategoria([])).toEqual([]);
    });

    test('omite categorías con 1 solo plato (no hay dispersión posible)', () => {
        const result = calcularDispersionPorCategoria([
            { nombre: 'A', categoria: 'entrantes', precio_venta: 10 },
            { nombre: 'B', categoria: 'principales', precio_venta: 20 }
        ]);
        expect(result).toEqual([]);
    });

    test('agrupa por categoría y calcula la dispersión interna', () => {
        const result = calcularDispersionPorCategoria([
            { nombre: 'Pulpo', categoria: 'entrantes', precio_venta: 12 },
            { nombre: 'Ostra', categoria: 'entrantes', precio_venta: 4 },
            { nombre: 'Lubina', categoria: 'principales', precio_venta: 24 },
            { nombre: 'Solomillo', categoria: 'principales', precio_venta: 30 }
        ]);
        expect(result).toHaveLength(2);
        const ent = result.find(c => c.categoria === 'entrantes');
        const pri = result.find(c => c.categoria === 'principales');
        expect(ent.valor).toBeCloseTo(3); // 12/4
        expect(ent.plato_max).toBe('Pulpo');
        expect(ent.plato_min).toBe('Ostra');
        expect(ent.n_platos).toBe(2);
        expect(pri.valor).toBeCloseTo(1.25); // 30/24
        expect(pri.estado).toBe('ok');
    });

    test('ordena por n_platos descendente', () => {
        const result = calcularDispersionPorCategoria([
            { nombre: 'A', categoria: 'pocos', precio_venta: 10 },
            { nombre: 'B', categoria: 'pocos', precio_venta: 15 },
            { nombre: 'C', categoria: 'muchos', precio_venta: 8 },
            { nombre: 'D', categoria: 'muchos', precio_venta: 10 },
            { nombre: 'E', categoria: 'muchos', precio_venta: 18 }
        ]);
        expect(result[0].categoria).toBe('muchos'); // 3 platos
        expect(result[1].categoria).toBe('pocos');  // 2 platos
    });

    test('categoría vacía o null se agrupa como "Sin categoría"', () => {
        const result = calcularDispersionPorCategoria([
            { nombre: 'A', categoria: null, precio_venta: 8 },
            { nombre: 'B', categoria: '', precio_venta: 15 }
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].categoria).toBe('Sin categoría');
    });
});

describe('omnesCalculator.calcularAmplitud', () => {
    test('0 platos → sin_datos', () => {
        const r = calcularAmplitud([]);
        expect(r.estado).toBe('sin_datos');
    });

    test('1 plato → sin_datos', () => {
        const r = calcularAmplitud([{ precio_venta: 10, nombre: 'A' }]);
        expect(r.estado).toBe('sin_datos');
        expect(r.total_platos).toBe(1);
    });

    test('distribución 25/50/25 ideal → equilibrada', () => {
        // 4 platos: 1 baja, 2 media, 1 alta.
        // precio_medio = (5+10+10+15)/4 = 10. umbral_baja = 7.5, umbral_alta = 12.5
        // baja: <7.5 → solo 5 (1)
        // alta: >12.5 → solo 15 (1)
        // media: 10, 10 (2)
        const r = calcularAmplitud([
            { precio_venta: 5, nombre: 'A' },
            { precio_venta: 10, nombre: 'B' },
            { precio_venta: 10, nombre: 'C' },
            { precio_venta: 15, nombre: 'D' }
        ]);
        expect(r.baja_pct).toBe(25);
        expect(r.media_pct).toBe(50);
        expect(r.alta_pct).toBe(25);
        expect(r.estado).toBe('equilibrada');
    });

    test('todos iguales → todos en media → desbalance', () => {
        const r = calcularAmplitud([
            { precio_venta: 10, nombre: 'A' },
            { precio_venta: 10, nombre: 'B' },
            { precio_venta: 10, nombre: 'C' },
            { precio_venta: 10, nombre: 'D' }
        ]);
        expect(r.media_pct).toBe(100);
        expect(r.baja_pct).toBe(0);
        expect(r.alta_pct).toBe(0);
        expect(r.desviacion).toBe(100); // |0-25| + |100-50| + |0-25| = 100
        expect(r.estado).toBe('muy_desbalanceada');
    });

    test('suma de % siempre = 100', () => {
        const r = calcularAmplitud([
            { precio_venta: 3, nombre: 'A' },
            { precio_venta: 7, nombre: 'B' },
            { precio_venta: 17, nombre: 'C' }
        ]);
        expect(r.baja_pct + r.media_pct + r.alta_pct).toBe(100);
    });
});

describe('omnesCalculator.calcularCalidadPrecio', () => {
    test('0 platos → sin_datos', () => {
        const r = calcularCalidadPrecio([]);
        expect(r.estado).toBe('sin_datos');
    });

    test('platos sin ventas → sin_ventas con ofertado calculado', () => {
        const r = calcularCalidadPrecio([
            { precio_venta: 10, cantidad_vendida: 0, nombre: 'A' },
            { precio_venta: 20, cantidad_vendida: 0, nombre: 'B' }
        ]);
        expect(r.estado).toBe('sin_ventas');
        expect(r.ofertado).toBe(15);
        expect(r.ratio).toBeNull();
    });

    test('ratio ≈ 1 → equilibrado', () => {
        // 3 platos a 10/15/20, se vende 1 de cada → vendido = 15 = ofertado
        const r = calcularCalidadPrecio([
            { precio_venta: 10, cantidad_vendida: 1, nombre: 'A' },
            { precio_venta: 15, cantidad_vendida: 1, nombre: 'B' },
            { precio_venta: 20, cantidad_vendida: 1, nombre: 'C' }
        ]);
        expect(r.ratio).toBe(1);
        expect(r.estado).toBe('equilibrado');
        expect(r.unidades_vendidas).toBe(3);
    });

    test('cliente prefiere los baratos → ratio < 0.95 → bajan', () => {
        // platos ofertados a 10/20/30 (medio=20), solo se vende el de 10
        const r = calcularCalidadPrecio([
            { precio_venta: 10, cantidad_vendida: 100, nombre: 'A' },
            { precio_venta: 20, cantidad_vendida: 0, nombre: 'B' },
            { precio_venta: 30, cantidad_vendida: 0, nombre: 'C' }
        ]);
        expect(r.estado).toBe('bajan');
        expect(r.vendido).toBe(10);
        expect(r.ofertado).toBe(20);
        expect(r.ratio).toBe(0.5);
    });

    test('cliente prefiere los caros → ratio > 1.05 → suben', () => {
        const r = calcularCalidadPrecio([
            { precio_venta: 10, cantidad_vendida: 0, nombre: 'A' },
            { precio_venta: 20, cantidad_vendida: 0, nombre: 'B' },
            { precio_venta: 30, cantidad_vendida: 100, nombre: 'C' }
        ]);
        expect(r.estado).toBe('suben');
        expect(r.vendido).toBe(30);
        expect(r.ratio).toBe(1.5);
    });
});

describe('omnesCalculator.generarRecomendacionGlobal', () => {
    test('todo ok → mensaje positivo', () => {
        const r = generarRecomendacionGlobal({
            dispersion: { estado: 'ok' },
            amplitud: { estado: 'equilibrada' },
            calidad_precio: { estado: 'equilibrado' }
        });
        expect(r).toContain('bien equilibrada');
    });

    test('dispersión alta → frase de dispersión', () => {
        const r = generarRecomendacionGlobal({
            dispersion: { estado: 'alta' },
            amplitud: { estado: 'equilibrada' },
            calidad_precio: { estado: 'equilibrado' }
        });
        expect(r).toContain('Reduce dispersión');
    });

    test('los 3 problemas → 3 frases combinadas', () => {
        const r = generarRecomendacionGlobal({
            dispersion: { estado: 'muy_alta' },
            amplitud: { estado: 'desbalance' },
            calidad_precio: { estado: 'bajan' }
        });
        expect(r).toContain('Reduce mucho la dispersión');
        expect(r).toContain('Reequilibra');
        expect(r).toContain('sube precios');
    });

    test('máximo 3 frases (si hay más, recorta)', () => {
        // Hoy hay máx 3 sub-análisis. Test de seguridad por si en el futuro se añade
        // otro y la slice no se ajusta.
        const r = generarRecomendacionGlobal({
            dispersion: { estado: 'muy_alta' },
            amplitud: { estado: 'muy_desbalanceada' },
            calidad_precio: { estado: 'suben' }
        });
        // No debería tener más de 3 frases (cuenta puntos finales).
        const frases = r.split('. ').filter(s => s.length > 0);
        expect(frases.length).toBeLessThanOrEqual(3);
    });
});
