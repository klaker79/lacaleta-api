/**
 * Guardián anti-deriva de esquema.
 *
 * `init.js` es lo ÚNICO que corre al levantar una base de datos nueva. Si el
 * código consulta una tabla o una columna que init.js no crea, la BD de
 * producción sigue funcionando (allí se añadió a mano en su día) pero **toda
 * casa nueva nace rota**.
 *
 * Así se descubrió (2026-07-29): comparando el esquema de producción con el de
 * la BD de la casa Lite, recién creada, faltaban 13 columnas y 2 tablas.
 * /onboarding y /chat-status daban error, y stock_movements no existía — el
 * histórico de movimientos de stock se perdía en silencio porque
 * InventoryService captura la excepción y sigue.
 *
 * Este test compara, sin necesidad de base de datos:
 *   lo que el código ESCRIBE (INSERT INTO … (cols) / UPDATE … SET col = …)
 *   contra
 *   lo que init.js CREA (CREATE TABLE … / ADD COLUMN IF NOT EXISTS …)
 *
 * Se limita a las escrituras porque son las que se pueden extraer del SQL sin
 * ambigüedad. Un SELECT con alias y joins no se puede atribuir a una tabla de
 * forma fiable, y un guardián con falsos positivos acaba desactivado —
 * exactamente lo que le pasó al escáner multi-tenant.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const INIT_JS = path.join(SRC, 'db', 'init.js');

// ---------------------------------------------------------------- init.js ---

const initSql = fs.readFileSync(INIT_JS, 'utf8');

/** Tablas que init.js crea. */
function tablasCreadas(sql) {
    const out = new Set();
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        out.add(m[1].toLowerCase());
    }
    return out;
}

/**
 * Columnas que init.js crea, por tabla: las del cuerpo del CREATE TABLE más
 * las de cada ADD COLUMN.
 */
function columnasCreadas(sql) {
    const porTabla = new Map();
    const add = (tabla, col) => {
        const t = tabla.toLowerCase();
        if (!porTabla.has(t)) porTabla.set(t, new Set());
        porTabla.get(t).add(col.toLowerCase());
    };

    // CREATE TABLE x ( ... )  → primera palabra de cada línea del cuerpo
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
        const [, tabla, cuerpo] = m;
        for (const linea of cuerpo.split('\n')) {
            const l = linea.trim();
            if (!l || l.startsWith('--')) continue;
            // Saltar constraints de tabla, no son columnas.
            if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l)) continue;
            const col = l.match(/^([a-z_][a-z0-9_]*)/i);
            if (col) add(tabla, col[1]);
        }
    }

    // ALTER TABLE x ADD COLUMN [IF NOT EXISTS] col
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        add(m[1], m[2]);
    }

    return porTabla;
}

// ------------------------------------------------------------ el código ---

function ficherosJs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return ficherosJs(p);
        return e.isFile() && p.endsWith('.js') ? [p] : [];
    });
}

/**
 * Escrituras que hace el código: `INSERT INTO tabla (col, col…)` y
 * `UPDATE tabla SET col = …`.
 * @returns {Map<string, Map<string, string>>} tabla → (columna → fichero)
 */
function escriturasDelCodigo() {
    const porTabla = new Map();
    const add = (tabla, col, fichero) => {
        const t = tabla.toLowerCase();
        const c = col.toLowerCase();
        if (!porTabla.has(t)) porTabla.set(t, new Map());
        if (!porTabla.get(t).has(c)) porTabla.get(t).set(c, fichero);
    };

    for (const fichero of ficherosJs(SRC)) {
        if (path.resolve(fichero) === path.resolve(INIT_JS)) continue;
        const rel = path.relative(SRC, fichero).replace(/\\/g, '/');
        const sql = fs.readFileSync(fichero, 'utf8');

        // INSERT INTO tabla (a, b, c)
        for (const m of sql.matchAll(/INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
            const [, tabla, cols] = m;
            for (const raw of cols.split(',')) {
                const col = raw.trim().match(/^([a-z_][a-z0-9_]*)$/i);
                if (col) add(tabla, col[1], rel);
            }
        }

        // UPDATE tabla SET col = …   (solo la primera columna del SET: es la
        // única que se puede aislar sin parsear la expresión entera)
        for (const m of sql.matchAll(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([a-z_][a-z0-9_]*)\s*=/gi)) {
            add(m[1], m[2], rel);
        }
    }
    return porTabla;
}

// ------------------------------------------------------------------ test ---

/**
 * Tablas que el código toca pero que NO las crea init.js a propósito.
 * Si añades algo aquí, explica por qué.
 */
const TABLAS_EXTERNAS = new Set([
    'information_schema.columns', // catálogo de Postgres
    'pg_indexes',

    // Aquí estuvo `ingrediente_proveedor` (SINGULAR), una tabla que no existe
    // en ninguna base de datos —la real es `ingredientes_proveedores`, en
    // plural— y que solo escribía un repositorio huérfano. Ese fichero ya se
    // borró, así que la excepción sobra: si el nombre vuelve a aparecer, es un
    // error de verdad y este test tiene que cantarlo.
]);

describe('init.js cubre todo lo que el código escribe', () => {
    const creadas = tablasCreadas(initSql);
    const columnas = columnasCreadas(initSql);
    const escrituras = escriturasDelCodigo();

    test('el parseo de init.js encuentra algo (sanity check)', () => {
        expect(creadas.size).toBeGreaterThan(15);
        expect(columnas.get('restaurantes')?.size ?? 0).toBeGreaterThan(5);
    });

    test('toda tabla en la que el código INSERTA está creada en init.js', () => {
        const faltan = [...escrituras.keys()]
            .filter((t) => !TABLAS_EXTERNAS.has(t) && !creadas.has(t))
            .map((t) => `  ${t}  (la escribe ${[...escrituras.get(t).values()][0]})`);

        if (faltan.length > 0) {
            throw new Error(
                'El código escribe en tablas que init.js no crea:\n\n' + faltan.join('\n')
                + '\n\nEn producción existen (se añadieron a mano), pero una BD nueva'
                + '\nnace sin ellas y la casa nueva arranca rota.'
            );
        }
    });

    test('toda columna en la que el código ESCRIBE está creada en init.js', () => {
        const faltan = [];

        for (const [tabla, cols] of escrituras) {
            if (TABLAS_EXTERNAS.has(tabla) || !creadas.has(tabla)) continue; // cubierto por el test anterior
            const conocidas = columnas.get(tabla) ?? new Set();
            for (const [col, fichero] of cols) {
                if (!conocidas.has(col)) faltan.push(`  ${tabla}.${col}  (la escribe ${fichero})`);
            }
        }

        if (faltan.length > 0) {
            throw new Error(
                'El código escribe en columnas que init.js no crea:\n\n' + faltan.join('\n')
                + '\n\nAñade el ALTER TABLE ... ADD COLUMN IF NOT EXISTS en src/db/init.js.'
                + '\nEn producción existen (se añadieron a mano); una BD nueva no las tiene.'
            );
        }
    });
});
