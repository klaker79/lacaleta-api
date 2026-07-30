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

describe('Un parámetro reutilizado en dos columnas lleva cast explícito', () => {
    /**
     * La misma fecha va a `fecha` (DATE) y a `fecha_recepcion` (TIMESTAMP). Si
     * el parámetro no se castea, Postgres intenta deducir UN tipo a partir de
     * dos columnas distintas y aborta:
     *
     *     ERROR: inconsistent types deduced for parameter $2
     *
     * En la base de datos de Lite no se veía, porque ahí `fecha_recepcion` ya
     * es DATE por deriva de esquema. Pero en una base NUEVA —la de cualquier
     * cliente nuevo— consolidar un albarán devolvía un 500. Lo cazó el CI, que
     * sí levanta la base desde cero.
     */
    const inserts = fuente.match(/INSERT INTO pedidos[\s\S]{0,400}?RETURNING/g) || [];

    test('hay INSERTs de pedidos que analizar (sanity check)', () => {
        expect(inserts.length).toBeGreaterThan(0);
    });

    test.each(inserts.map((s, i) => [i, s]))('INSERT #%i castea el parámetro repetido', (_i, sql) => {
        const values = sql.match(/VALUES\s*\(([^)]*)\)/)?.[1] || '';
        const usos = values.match(/\$\d+/g) || [];
        const repetidos = usos.filter((p, i, a) => a.indexOf(p) !== i);
        for (const p of new Set(repetidos)) {
            // Cada aparición del parámetro repetido debe llevar `::tipo`.
            const escapado = p.replace('$', '\\$');
            const sinCast = new RegExp(`${escapado}(?!::)`, 'g');
            expect(values.match(sinCast)).toBeNull();
        }
    });
});

describe('Los índices de init.js no usan columnas que aún no existen', () => {
    /**
     * `idx_precios_compra_pedido` se creaba sobre `pedido_id` ANTES del ALTER
     * que añadía esa columna. En una base nueva fallaba — y como las sentencias
     * van juntas en una sola query, se caía el BLOQUE ENTERO de índices, no
     * solo ese: los siguientes tampoco llegaban a crearse.
     */
    const initSql = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'init.js'), 'utf8');

    /** Posición en el fichero donde cada columna pasa a existir. */
    function primeraAparicionDeColumna(tabla, columna) {
        // En su CREATE TABLE...
        const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`);
        const m = initSql.match(create);
        if (m && new RegExp(`^\\s*${columna}\\s`, 'm').test(m[1])) return m.index;
        // ...o en un ALTER que la añade.
        const alter = new RegExp(`ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS ${columna}\\b`);
        const a = initSql.search(alter);
        return a === -1 ? Infinity : a;
    }

    const indices = [...initSql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s*\n?\s*ON (\w+)\s*\(([^)]*)\)/g)];

    test('se encuentran índices que analizar (sanity check)', () => {
        expect(indices.length).toBeGreaterThan(5);
    });

    test.each(indices.map(m => [m[1], m[2], m[3], m.index]))(
        '%s (sobre %s) usa columnas que ya existen',
        (_nombre, tabla, columnas, posIndice) => {
            const nombres = columnas
                .split(',')
                .map(c => c.trim().replace(/\s+(ASC|DESC)$/i, ''))
                // Solo identificadores simples: nada de expresiones ni funciones.
                .filter(c => /^\w+$/.test(c));
            for (const col of nombres) {
                expect(primeraAparicionDeColumna(tabla, col)).toBeLessThan(posIndice);
            }
        }
    );
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
