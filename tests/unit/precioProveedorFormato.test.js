/**
 * Red de seguridad del precio de proveedor — bug JOSEBA (2026-08-03).
 *
 * `ingredientes_proveedores.precio` es €/UNIDAD-BASE. El formulario de ingredientes
 * llamaba a `/ingredients/:id/suppliers` mandando SOLO `precio` con el valor de
 * `ingredientes.precio`, que es €/FORMATO — y sin los campos de formato, así que no
 * había con qué derivarlo. Luego el desplegable de pedidos multiplica por
 * cantidad_por_formato: una CAJA de 10 l a 23,10 € salía a **231 €**.
 *
 * POR QUÉ TARDÓ MESES EN APARECER: el carrito prioriza la ÚLTIMA COMPRA real sobre
 * este precio. La Nave 5, con historial, nunca llega a leerlo; 31 de sus 46 filas
 * defectuosas estaban "protegidas" por sus compras. Solo muerde a los clientes
 * NUEVOS — que es justo a quien vendemos Lite. Es el patrón de los bugs que solo
 * salen con una base de datos desde cero.
 */
const {
    completarFormatoDesdeIngrediente,
    cpfSeguro,
    precioUnitarioIngrediente
} = require('../../src/utils/supplierPricing');

// Casos REALES de JOSEBA (rid=2 en la BD de Lite), tal como se guardaron mal.
const ATLANTICA = { formato_compra: 'CAJA', cantidad_por_formato: 10 };      // 23,10 €/caja
const TOMATE = { formato_compra: 'BOTE', cantidad_por_formato: 750 };        // 4,45 €/bote
const GUANTES = { formato_compra: 'CAJA', cantidad_por_formato: 100 };       // 3,75 €/caja

describe('completa el formato cuando la petición no lo declara', () => {
    test('el precio suelto pasa a ser el precio DEL FORMATO', () => {
        const out = completarFormatoDesdeIngrediente({ precio: 23.10, proveedor_id: 8 }, ATLANTICA);
        expect(out.formato).toBe('CAJA');
        expect(out.cantidad_por_formato).toBe(10);
        expect(out.precio_formato).toBe(23.10);
        // Se conserva el resto del body.
        expect(out.proveedor_id).toBe(8);
    });

    // El caso que se veía en pantalla: 23,10 €/caja se guardaba como 23,10 €/litro
    // y el pedido mostraba 231 €.
    test('así el precio canónico sale en €/unidad-base, no ×10', () => {
        const out = completarFormatoDesdeIngrediente({ precio: 23.10 }, ATLANTICA);
        const canonico = out.precio_formato / out.cantidad_por_formato;
        expect(canonico).toBeCloseTo(2.31, 6);
        // Y al reconstruir el formato vuelve a dar el precio tecleado.
        expect(canonico * out.cantidad_por_formato).toBeCloseTo(23.10, 2);
    });

    test('funciona con formatos de miles de unidades (el peor caso real)', () => {
        // TOMATE FRITO: 4,45 €/bote de 750 g. Sin esto mostraba 3.337,50 €.
        const out = completarFormatoDesdeIngrediente({ precio: 4.45 }, TOMATE);
        expect(out.precio_formato / out.cantidad_por_formato).toBeCloseTo(0.005933, 6);
    });

    test('no muta el body original', () => {
        const original = { precio: 3.75 };
        const out = completarFormatoDesdeIngrediente(original, GUANTES);
        expect(original.formato).toBeUndefined();
        expect(out).not.toBe(original);
    });
});

// ⚠️ EL FORMATO PUEDE SER UNA FRACCIÓN de la unidad base — una BOTELLA de vino son
// 0,75 l. Estos 15 ingredientes existen en La Nave 5 y la primera versión del arreglo
// (`cpf > 1`) los dejaba fuera: el bug volvía INVERTIDO, guardando 6,08 €/botella como
// 6,08 €/l y mostrando 4,56 €. Un −25 % que no canta y se cuela en el food cost.
describe('formatos MENORES que la unidad base (cpf < 1)', () => {
    const BOTELLA = { formato_compra: 'BOTELLA', cantidad_por_formato: 0.75 };  // aguardiente
    const BOTE_MOSTAZA = { formato_compra: 'BOTE', cantidad_por_formato: 0.24 };

    test('AGUARDIENTE: 6,08 €/botella de 0,75 l → 8,106666 €/l', () => {
        const out = completarFormatoDesdeIngrediente({ precio: 6.08 }, BOTELLA);
        expect(out.cantidad_por_formato).toBe(0.75);
        expect(out.precio_formato).toBe(6.08);
        // Lo que importa: el precio canónico SUBE, no baja.
        const canonico = out.precio_formato / out.cantidad_por_formato;
        expect(canonico).toBeCloseTo(8.106667, 5);
        expect(canonico).toBeGreaterThan(6.08);
    });

    test('reconstruir el formato devuelve el precio tecleado', () => {
        const out = completarFormatoDesdeIngrediente({ precio: 3.45 }, BOTE_MOSTAZA);
        const canonico = out.precio_formato / out.cantidad_por_formato;
        expect(canonico * 0.24).toBeCloseTo(3.45, 6);
    });

    // El fallo concreto que tenía `cpf > 1`: devolvía el body intacto.
    test('NO devuelve el body sin tocar (regresión de la condición cpf > 1)', () => {
        const body = { precio: 5.50 };
        const out = completarFormatoDesdeIngrediente(body, { formato_compra: 'BOTELLA', cantidad_por_formato: 0.75 });
        expect(out).not.toBe(body);
        expect(out.formato).toBe('BOTELLA');
    });
});

describe('cuándo NO debe tocar nada', () => {
    // Si el caller ya declara el formato, sabe lo que hace: el alta manual de
    // proveedores manda los 3 campos y el precio ya viene bien derivado.
    test('la petición ya declara formato', () => {
        const body = { precio: 2.31, formato: 'CAJA', cantidad_por_formato: 10, precio_formato: 23.10 };
        expect(completarFormatoDesdeIngrediente(body, ATLANTICA)).toBe(body);
    });

    test('el ingrediente NO se compra por formato (cpf = 1)', () => {
        const body = { precio: 17.49 };
        expect(completarFormatoDesdeIngrediente(body, { formato_compra: null, cantidad_por_formato: 1 })).toBe(body);
    });

    test('cpf ausente o cero', () => {
        const body = { precio: 5 };
        expect(completarFormatoDesdeIngrediente(body, { formato_compra: 'CAJA' })).toBe(body);
        expect(completarFormatoDesdeIngrediente(body, { formato_compra: 'CAJA', cantidad_por_formato: 0 })).toBe(body);
    });

    // El PUT puede llamarse solo para marcar principal, sin tocar el precio.
    test('la petición no trae precio', () => {
        const body = { es_proveedor_principal: true };
        expect(completarFormatoDesdeIngrediente(body, ATLANTICA)).toBe(body);
    });

    test('entradas nulas no rompen', () => {
        expect(completarFormatoDesdeIngrediente(null, ATLANTICA)).toBeNull();
        expect(completarFormatoDesdeIngrediente({ precio: 1 }, null)).toEqual({ precio: 1 });
        expect(completarFormatoDesdeIngrediente({ precio: 1 }, undefined)).toEqual({ precio: 1 });
    });
});

describe('coherencia con el resto de la matemática de precios', () => {
    // La invariante del sistema: ingredientes.precio es €/FORMATO y la pivot €/base.
    // Ir y volver tiene que dar el mismo número.
    test('ida y vuelta: ficha → base → ficha', () => {
        const out = completarFormatoDesdeIngrediente({ precio: 16.98 }, { formato_compra: 'GARRAFA', cantidad_por_formato: 10 });
        const base = out.precio_formato / cpfSeguro(out.cantidad_por_formato);
        expect(base).toBeCloseTo(precioUnitarioIngrediente(16.98, 10), 6);
        expect(base * 10).toBeCloseTo(16.98, 2);
    });
});
