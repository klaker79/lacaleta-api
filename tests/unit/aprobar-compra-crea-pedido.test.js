/**
 * Aprobar una compra de albarán TIENE que dejar un pedido.
 *
 * Iker lo encontró probando en el móvil: mandó la foto de un albarán sin haber
 * hecho el pedido antes, la aceptó, y la compra no aparecía por ningún lado en
 * Pedidos. Se sumaba el stock y se escribía el Diario, pero sin pedido: la fila
 * del Diario quedaba suelta (`pedido_id NULL`) y —lo más serio— no había forma
 * de deshacer la compra desde la app, porque el único borrado con reversión es
 * el de pedidos.
 *
 * Se arregló en `approve-batch`. Pero hay DOS puertas de aprobación, y la otra
 * —aprobar una línea suelta— se quedó con el comportamiento viejo. Hoy la
 * interfaz no la usa (el móvil consolida siempre por lote), y eso es justo lo
 * que la hace peligrosa: una segunda puerta lista para reintroducir el bug en
 * cuanto alguien la conecte.
 *
 * Este test lee el código de las dos rutas y exige que ambas hagan lo mismo.
 */
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', '..', 'src', 'routes', 'balance.routes.js');
const fuente = fs.readFileSync(RUTA, 'utf8');

/**
 * Recorta el cuerpo de un `router.post('<ruta>', ...)` contando paréntesis, para
 * no depender de la indentación ni de dónde acabe el siguiente endpoint.
 */
function cuerpoDeRuta(ruta) {
    const marca = `router.post('${ruta}'`;
    const i = fuente.indexOf(marca);
    if (i === -1) throw new Error(`No existe la ruta ${ruta} (¿renombrada o borrada?)`);
    // Empezar a contar en el paréntesis de `router.post(`, no en la comilla de
    // la ruta: si no, el primer cierre que se encuentra es el de `(req, res)`.
    let nivel = 0;
    for (let p = fuente.lastIndexOf('(', i + marca.length); p < fuente.length; p++) {
        if (fuente[p] === '(') nivel++;
        else if (fuente[p] === ')' && --nivel === 0) return fuente.slice(i, p + 1);
    }
    throw new Error(`Paréntesis sin cerrar en ${ruta}`);
}

const RUTAS = {
    'línea suelta': '/purchases/pending/:id/approve',
    lote: '/purchases/pending/approve-batch',
};

describe.each(Object.entries(RUTAS))('Aprobar por %s crea un pedido', (_nombre, ruta) => {
    const cuerpo = cuerpoDeRuta(ruta);

    test('inserta en la tabla pedidos', () => {
        expect(cuerpo).toMatch(/INSERT INTO pedidos/i);
    });

    test("el pedido nace en estado 'recibido', no pendiente", () => {
        // Si naciera 'pendiente' aparecería en Pedidos como algo por recibir,
        // cuando el albarán ya está en la cocina y el stock ya está sumado.
        const insert = cuerpo.slice(cuerpo.search(/INSERT INTO pedidos/i));
        expect(insert.slice(0, 500)).toMatch(/'recibido'/);
    });

    test('usa la fecha del ALBARÁN, no la de hoy', () => {
        // La compra pertenece contablemente al día que la hizo el proveedor.
        // NOW()/CURRENT_DATE en el INSERT significaría fechar todo al día de
        // la consolidación, que puede ser semanas después.
        const insert = cuerpo.slice(cuerpo.search(/INSERT INTO pedidos/i), cuerpo.search(/INSERT INTO pedidos/i) + 500);
        expect(insert).not.toMatch(/NOW\(\)|CURRENT_DATE/i);
    });

    test('enlaza la fila del Diario con el pedido (pedidoId)', () => {
        // Sin este enlace, borrar el pedido no revierte la compra por el camino
        // preciso y cae al fallback legacy de restar cantidades.
        // La LLAMADA, no la primera mención (el nombre también sale en comentarios).
        const llamada = cuerpo.search(/await\s+upsertCompraDiaria\s*\(/);
        expect(llamada).toBeGreaterThan(-1);
        expect(cuerpo.slice(llamada, llamada + 600)).toMatch(/pedidoId/);
    });

    test('el pedido lleva restaurante_id (multi-tenant)', () => {
        const insert = cuerpo.slice(cuerpo.search(/INSERT INTO pedidos/i), cuerpo.search(/INSERT INTO pedidos/i) + 500);
        expect(insert).toMatch(/restaurante_id/);
    });

    test('escribe las líneas con el mismo formato que una recepción manual', () => {
        // La pestaña Pedidos y el rollback de DELETE /orders/:id leen estas
        // claves. Si falta cantidadRecibida, la recepción se ve vacía.
        for (const clave of ['ingredienteId', 'cantidadRecibida', 'precioUnitario', 'estado']) {
            expect(cuerpo).toContain(clave);
        }
    });

    test('devuelve el pedidoId al frontend', () => {
        // El móvil lo necesita para enlazar con la pantalla de Pedidos.
        const respuesta = cuerpo.slice(cuerpo.indexOf('res.json('));
        expect(respuesta).toMatch(/pedidoId/);
    });
});

describe('Las dos puertas siguen compartiendo las fórmulas', () => {
    // Lo que separó a las dos rutas fue tener el cuerpo duplicado. El cálculo sí
    // está en un helper común; que siga así.
    test.each(Object.values(RUTAS))('%s usa computePurchaseApproval', (ruta) => {
        expect(cuerpoDeRuta(ruta)).toContain('computePurchaseApproval');
    });

    test.each(Object.values(RUTAS))('%s resuelve el proveedor con el mismo helper', (ruta) => {
        expect(cuerpoDeRuta(ruta)).toContain('resolveProveedorId');
    });
});
