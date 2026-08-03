/**
 * El albarán tiene que poder VOLVER a la cola (Iker, 2026-08-03).
 *
 * Al recibir un pedido con un albarán escaneado, sus líneas pasan a
 * 'recibido_en_pedido' para que nadie las apruebe otra vez y el stock se cuente
 * doble. Dos agujeros:
 *
 *  1. `/purchases/batch/:id/consumido` recibía `pedidoId` y LO TIRABA (solo al
 *     log). Sin ese dato, borrar el pedido dejaba las líneas marcadas para
 *     siempre: el albarán no volvía a la cola.
 *  2. `/purchases/batch/:id/revert` solo miraba líneas 'aprobado', así que el
 *     botón "Pasarlo al pedido #N" —que existe justamente para líneas
 *     'recibido_en_pedido'— devolvía 404 SIEMPRE. Sin tocar la BD a mano no
 *     había forma de recuperar ese albarán.
 *
 * Estos tests leen el código fuente: verifican las CONSULTAS, sin necesidad de
 * levantar Postgres (la suite de integración sí lo necesita y aquí no hay).
 */
const fs = require('fs');
const path = require('path');

const balance = fs.readFileSync(path.join(__dirname, '../../src/routes/balance.routes.js'), 'utf8');
const orders = fs.readFileSync(path.join(__dirname, '../../src/routes/orders.routes.js'), 'utf8');
const init = fs.readFileSync(path.join(__dirname, '../../src/db/init.js'), 'utf8');

/** Cuerpo aproximado de un endpoint, desde su router.<verbo> hasta el siguiente. */
function bloqueEndpoint(src, marca) {
    const i = src.indexOf(marca);
    if (i === -1) return '';
    const sig = src.indexOf('router.', i + marca.length);
    return src.slice(i, sig === -1 ? src.length : sig);
}

describe('esquema', () => {
    test('compras_pendientes.pedido_id existe en init.js', () => {
        expect(init).toMatch(/ALTER TABLE compras_pendientes ADD COLUMN IF NOT EXISTS pedido_id/);
    });

    // Sin índice, liberar al borrar el pedido sería un seq scan por cada borrado.
    test('con índice para poder liberarlas por pedido', () => {
        expect(init).toMatch(/idx_compras_pendientes_pedido/);
    });
});

describe('/consumido guarda QUÉ pedido consumió el albarán', () => {
    const bloque = bloqueEndpoint(balance, "'/purchases/batch/:batchId/consumido'");

    test('el endpoint sigue existiendo', () => {
        expect(bloque).not.toBe('');
    });

    test('escribe pedido_id (antes solo lo logueaba)', () => {
        expect(bloque).toMatch(/SET estado = 'recibido_en_pedido'[\s\S]*pedido_id\s*=\s*\$3/);
    });

    // Llega por body: si viene basura, NULL antes que romper el UPDATE.
    test('sanea el pedidoId recibido', () => {
        expect(bloque).toMatch(/parseInt\(pedidoId/);
    });
});

describe('borrar un pedido LIBERA su albarán', () => {
    const bloque = orders.slice(orders.indexOf("router.delete('/orders/:id'"));

    test('devuelve las líneas a pendiente', () => {
        expect(bloque).toMatch(/UPDATE compras_pendientes[\s\S]{0,220}SET estado = 'pendiente'/);
    });

    test('busca por pedido_id y solo las de este pedido', () => {
        const upd = bloque.match(/UPDATE compras_pendientes[\s\S]{0,400}?`/);
        expect(upd).not.toBeNull();
        expect(upd[0]).toMatch(/WHERE pedido_id = \$1 AND restaurante_id = \$2/);
        expect(upd[0]).toMatch(/estado = 'recibido_en_pedido'/);
    });

    // Suelta también el vínculo: la línea vuelve a estar libre de verdad.
    test('limpia el pedido_id al liberar', () => {
        const upd = bloque.match(/UPDATE compras_pendientes[\s\S]{0,400}?`/);
        expect(upd[0]).toMatch(/pedido_id = NULL/);
    });

    // Va DENTRO de la transacción del borrado: o se libera y se borra, o nada.
    test('ocurre antes del COMMIT', () => {
        const iLib = bloque.indexOf('UPDATE compras_pendientes');
        const iCommit = bloque.indexOf("client.query('COMMIT')");
        expect(iLib).toBeGreaterThan(-1);
        expect(iLib).toBeLessThan(iCommit);
    });
});

describe('revert: "Pasarlo al pedido" ya no es un callejón sin salida', () => {
    const bloque = bloqueEndpoint(balance, "'/purchases/batch/:batchId/revert'");

    test('acepta los DOS estados, no solo aprobado', () => {
        expect(bloque).toMatch(/estado IN \('aprobado', 'recibido_en_pedido'\)/);
    });

    // 'recibido_en_pedido' no aplicó stock ni Diario por su cuenta (lo hizo la
    // recepción del pedido): restarlo aquí sería quitarlo dos veces.
    test('NO revierte stock de las líneas recibido_en_pedido', () => {
        expect(bloque).toMatch(/if \(item\.estado === 'recibido_en_pedido'\) continue;/);
    });

    // Si el pedido que lo consumió sigue vivo y recibido, liberar el albarán
    // permitiría aprobarlo otra vez → compra contada dos veces.
    test('rechaza si el pedido que lo consumió sigue recibido', () => {
        expect(bloque).toMatch(/estado = 'recibido'/);
        expect(bloque).toMatch(/status\(409\)/);
    });

    test('y el 409 dice qué pedido es', () => {
        expect(bloque).toMatch(/pedidoId: vivos\[0\]\.id/);
    });

    test('al liberar, limpia también el pedido_id', () => {
        expect(bloque).toMatch(/SET estado = 'pendiente', aprobado_at = NULL, pedido_id = NULL/);
    });
});
