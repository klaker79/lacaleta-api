/**
 * Guardián: el id del modelo de Anthropic vive en UN solo sitio.
 *
 * Bug que previene (2026-07-29): el id estaba escrito a mano en 4 sitios.
 * Al actualizar el modelo se cambiaron 2 y los otros 2 se quedaron en
 * `claude-sonnet-4-20250514`, que fue retirado → la API devuelve 404 y
 * `POST /sales/parse-pdf` (importar ventas del TPV desde el PDF) llevaba
 * tiempo roto en producción sin que saltara ninguna alarma.
 *
 * Si este test falla: no añadas el modelo a la lista de excepciones —
 * importa `ANTHROPIC_MODEL` de `src/config/aiModels.js`.
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const FUENTE_UNICA = path.join(SRC_DIR, 'config', 'aiModels.js');

/** Todos los .js bajo src/, recursivo. */
function ficherosJs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
        const p = path.join(dir, entrada.name);
        if (entrada.isDirectory()) return ficherosJs(p);
        return entrada.isFile() && p.endsWith('.js') ? [p] : [];
    });
}

// Un id de modelo entre comillas: 'claude-…' o "claude-…".
// Solo cuenta como literal si va entrecomillado — así no salta con el texto
// de los comentarios explicativos.
const LITERAL_MODELO = /['"](claude-[a-z0-9.-]+)['"]/gi;

describe('El id del modelo de Anthropic tiene una única fuente', () => {
    test('src/config/aiModels.js existe y exporta ANTHROPIC_MODEL', () => {
        expect(fs.existsSync(FUENTE_UNICA)).toBe(true);
        const { ANTHROPIC_MODEL } = require(FUENTE_UNICA);
        expect(typeof ANTHROPIC_MODEL).toBe('string');
        expect(ANTHROPIC_MODEL).toMatch(/^claude-/);
    });

    test('ningún otro fichero de src/ escribe un id de modelo a mano', () => {
        const infractores = [];

        for (const fichero of ficherosJs(SRC_DIR)) {
            if (path.resolve(fichero) === path.resolve(FUENTE_UNICA)) continue;

            const contenido = fs.readFileSync(fichero, 'utf8');
            for (const m of contenido.matchAll(LITERAL_MODELO)) {
                const linea = contenido.slice(0, m.index).split('\n').length;
                const rel = path.relative(SRC_DIR, fichero).replace(/\\/g, '/');
                infractores.push(`  src/${rel}:${linea} → ${m[1]}`);
            }
        }

        if (infractores.length > 0) {
            throw new Error(
                'Hay ids de modelo escritos a mano fuera de src/config/aiModels.js:\n\n'
                + infractores.join('\n')
                + "\n\nImporta { ANTHROPIC_MODEL } de '../config/aiModels' en su lugar."
                + '\nUn id duplicado se queda atrás en la siguiente actualización y,'
                + '\ncuando el modelo se retira, el endpoint devuelve 404 en silencio.'
            );
        }
    });

    test('el modelo configurado no es uno de los ya retirados', () => {
        const { ANTHROPIC_MODEL } = require(FUENTE_UNICA);
        // Retirados verificados contra GET /v1/models (404 not_found_error).
        const RETIRADOS = [
            'claude-sonnet-4-20250514',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-20240229',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-20240620',
        ];
        expect(RETIRADOS).not.toContain(ANTHROPIC_MODEL);
    });
});
