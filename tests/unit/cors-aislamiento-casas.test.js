/**
 * Guardián: cada casa acepta CORS solo de su propio frontend.
 *
 * Bug que previene (2026-07-29): `defaultOrigins` era una lista escrita a mano
 * que incluía `https://app.mindloop.cloud` (el frontend de PRODUCCIÓN). Como se
 * aplicaba en todas las casas, la API de la casa Lite aceptaba peticiones con
 * ese Origin. Comprobado en vivo contra lite-api: devolvía 401, no 403 — es
 * decir, pasaba el filtro de CORS y solo la frenaba el token.
 *
 * En producción los orígenes deben salir SOLO de ALLOWED_ORIGINS.
 */

const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'src', 'config', 'index.js');

/**
 * Carga src/config con un entorno concreto, sin caché entre casos.
 *
 * Restaura clave a clave en vez de reasignar `process.env` entero: bajo jest,
 * `process.env` no es un objeto normal y reemplazarlo deja el entorno en un
 * estado raro que se arrastra al siguiente test.
 */
function cargarConfig(env) {
    const claves = { JWT_SECRET: 'test-secret-para-el-guardian', ...env };
    const previo = {};
    for (const k of Object.keys(claves)) previo[k] = process.env[k];

    for (const [k, v] of Object.entries(claves)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }

    // jest.resetModules(), no require.cache: jest tiene su propio registro de
    // módulos y tocar require.cache no lo invalida — el config quedaría cacheado
    // del caso anterior y el test mediría el entorno equivocado.
    jest.resetModules();
    try {
        return require(CONFIG);
    } finally {
        for (const [k, v] of Object.entries(previo)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        jest.resetModules();
    }
}

describe('Aislamiento CORS entre casas', () => {
    test('en producción los orígenes salen SOLO de ALLOWED_ORIGINS', () => {
        const cfg = cargarConfig({
            NODE_ENV: 'production',
            ALLOWED_ORIGINS: 'https://lite.mindloop.cloud',
        });
        expect(cfg.cors.allowedOrigins).toEqual(['https://lite.mindloop.cloud']);
    });

    test('en producción NO se cuela el frontend de otra casa', () => {
        const cfg = cargarConfig({
            NODE_ENV: 'production',
            ALLOWED_ORIGINS: 'https://lite.mindloop.cloud',
        });
        expect(cfg.cors.allowedOrigins).not.toContain('https://app.mindloop.cloud');
        expect(cfg.cors.allowedOrigins).not.toContain('https://staging.mindloop.cloud');
        // Y ningún localhost: en producción no pinta nada.
        expect(cfg.cors.allowedOrigins.filter(o => o.includes('localhost'))).toEqual([]);
    });

    test('en desarrollo sí valen los localhost', () => {
        const cfg = cargarConfig({ NODE_ENV: 'development', ALLOWED_ORIGINS: '' });
        expect(cfg.cors.allowedOrigins.some(o => o.includes('localhost'))).toBe(true);
    });

    test('ALLOWED_ORIGINS admite varios, con espacios sueltos', () => {
        const cfg = cargarConfig({
            NODE_ENV: 'production',
            ALLOWED_ORIGINS: 'https://lite.mindloop.cloud, https://otra.mindloop.cloud ',
        });
        expect(cfg.cors.allowedOrigins).toEqual([
            'https://lite.mindloop.cloud',
            'https://otra.mindloop.cloud',
        ]);
    });

    test('el fichero de config no lleva dominios de producción escritos a mano', () => {
        const fuente = require('fs').readFileSync(CONFIG, 'utf8');
        // Solo dentro de comentarios (la explicación del porqué). Fuera, ninguno.
        const sinComentarios = fuente
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(sinComentarios).not.toContain('app.mindloop.cloud');
        expect(sinComentarios).not.toContain('klaker79.github.io');
    });
});
