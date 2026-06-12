/**
 * Multi-tenant scan — análisis estático de TODAS las queries en src/routes/.
 *
 * Regla: cualquier query SQL que toque una tabla tenant-scoped (ver lista
 * abajo) DEBE incluir `restaurante_id`. Sin restaurante_id no hay forma
 * de que la query esté filtrando por tenant correctamente.
 *
 * Bug class que previene: el tenant leak — un usuario del restaurante A
 * ve / modifica datos del restaurante B. Catastrófico. Esta clase de fallo
 * es difícil de pillar en runtime (a menos que el bug afecte al tenant
 * desarrollando), pero un grep estático sí lo detecta el día que se
 * introduzca.
 *
 * Cómo funciona:
 *   1. Lee todos los archivos en src/routes/*.routes.js
 *   2. Para cada archivo, encuentra todos los template literals que
 *      parecen SQL (contienen FROM, INTO, UPDATE, DELETE FROM).
 *   3. Si la query toca una tabla tenant-scoped y NO contiene
 *      'restaurante_id', falla con el archivo + snippet de la query.
 *
 * Falsos positivos esperados (whitelist):
 *   - Queries de auth/login/registro (todavía no hay tenant en sesión).
 *   - Webhooks de Polar (el tenant viene del metadata del payload).
 *   - Health checks / system info.
 *   - Queries que INSERTAN restaurantes (no tienen restaurante_id porque
 *     se está CREANDO ese tenant ahora).
 *
 * Si añades un caso legítimo nuevo, mételo en EXCEPTION_FILES o
 * EXCEPTION_PATTERNS, NO cambies la regla.
 */

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', '..', 'src', 'routes');
// 🛡️ v2 (auditoría 2026-06-12): los services con SQL también se escanean.
// El leak de chatService.js:1141 (JOIN a proveedores sin tenant) vivía aquí.
const SERVICES_DIR = path.join(__dirname, '..', '..', 'src', 'services');
const UTILS_SQL_FILES = [
    path.join(__dirname, '..', '..', 'src', 'utils', 'businessHelpers.js'),
];

// Tablas con columna restaurante_id (verified contra database-schema.md
// y `\d <tabla>` en producción). Si añades una tabla tenant-scoped al
// schema, añádela aquí.
//
// NO incluir tablas de unión que NO tienen restaurante_id (ej.
// ingredientes_proveedores): el scope se hereda del ingrediente_id que
// SÍ está validado en el call site.
const TENANT_TABLES = [
    'ingredientes',
    'ingredientes_alias',
    'recetas',
    'recetas_variantes',
    'pedidos',
    'ventas',
    'ventas_diarias_resumen',
    'mermas',
    'empleados',
    'horarios',
    'proveedores',
    'gastos_fijos',
    'precios_compra_diarios',
    'compras_pendientes',
    'inventory_adjustments_v2',
    'inventory_snapshots_v2',
    'perdidas_stock',
    'api_tokens',
    'usuario_restaurantes',
    'chat_addon_subscriptions',
    'transferencias_stock', // origen/destino, ambos tenants
    'coach_reports', // 2026-06-08 audit
    'onboarding_progress'
];

// Archivos enteros que están EXENTOS de la regla (justificación arriba).
const EXCEPTION_FILES = [
    // Auth: login/registro/verificación no tiene tenant en sesión todavía
    'auth.routes.js',
    // Polar webhook: el tenant viene del metadata del payload firmado, no del JWT
    'webhooks.routes.js',
    // Superadmin: opera CROSS-tenant intencionalmente
    'superadmin.routes.js',
    // System: health, version, etc.
    'system.routes.js'
];

// Patrones de SQL que están exentos aunque el archivo no lo esté:
//   - INSERT INTO restaurantes (...) → es el alta del tenant; restaurante_id es la PK
//   - SELECT ... FROM restaurantes WHERE id = $1 → la propia tabla restaurantes usa `id`, no `restaurante_id`
//   - SELECT version() / current_timestamp / pg_* → no toca tabla tenant
const EXCEPTION_PATTERNS = [
    /FROM\s+restaurantes\s+WHERE\s+id\s*=/i,
    /UPDATE\s+restaurantes\s+SET[\s\S]*WHERE\s+id\s*=/i,
    /INSERT\s+INTO\s+restaurantes\s*\(/i,
    /DELETE\s+FROM\s+restaurantes\s+WHERE\s+id\s*=/i,
    /\bpg_/i,
    /SELECT\s+version\s*\(/i
];

// Excepciones explícitas — queries que NO incluyen restaurante_id en su SQL
// PERO tienen validación scope previa en el call site. Auditadas a mano.
// Si añades una excepción aquí, comenta el commit/PR donde se auditó.
//
// Cada entrada: snippet único de la query (subcadena, case-insensitive).
// Las cadenas se comparan con whitespace normalizado, así que da igual la
// indentación / saltos de línea reales del código fuente.
const AUDITED_EXCEPTIONS = [
    // ingredients.routes.js:692 — UPDATE proveedores sync de array ingredientes.
    // El proveedor_id ya fue validado con `checkProv` (líneas 651-656) contra
    // req.restauranteId. Defense-in-depth opcional pendiente.
    "UPDATE proveedores SET ingredientes",
    // ingredients.routes.js:610-616 — GET /ingredients/:id/suppliers, listing
    // de proveedores de un ingrediente. checkIng (línea 597-604) valida el
    // ingrediente_id contra el tenant antes de hacer el SELECT por JOIN.
    "FROM ingredientes_proveedores ip JOIN proveedores p ON ip.proveedor_id = p.id WHERE ip.ingrediente_id",
    // transfers.routes.js — UPDATE ingrediente_id_destino y SET estado='aprobada'.
    // El transfer.id viene de SELECT FOR UPDATE previo que filtró por
    // destino_restaurante_id.
    "UPDATE transferencias_stock SET ingrediente_id_destino",
    "UPDATE transferencias_stock SET estado = 'aprobada'"
];

function normalizeSql(s) {
    return s.replace(/\s+/g, ' ').trim();
}

function readRouteFiles() {
    if (!fs.existsSync(ROUTES_DIR)) return [];
    return fs.readdirSync(ROUTES_DIR)
        .filter(f => f.endsWith('.routes.js'))
        .filter(f => !EXCEPTION_FILES.includes(f))
        .map(f => ({
            file: f,
            content: fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')
        }));
}

// 🛡️ v2: services con SQL (mismas reglas que routes).
function readServiceFiles() {
    if (!fs.existsSync(SERVICES_DIR)) return [];
    return fs.readdirSync(SERVICES_DIR)
        .filter(f => f.endsWith('.js'))
        .map(f => ({
            file: `services/${f}`,
            content: fs.readFileSync(path.join(SERVICES_DIR, f), 'utf8')
        }));
}

/**
 * Extrae todos los template literals que parecen SQL del contenido.
 * Detecta:
 *   - `SELECT ... FROM ...`
 *   - `INSERT INTO ...`
 *   - `UPDATE ... SET ...`
 *   - `DELETE FROM ...`
 *   - WITH ... AS (...) ... (CTEs)
 *
 * Heurística: cualquier backtick string que tenga FROM/INTO/UPDATE/DELETE
 * en mayúscula (las queries del codebase respetan SQL caps).
 */
function extractSqlLiterals(content) {
    const out = [];
    // Captura template literals: `...` permitiendo \n y `${...}` interpolaciones
    const re = /`([\s\S]*?)`/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        const lit = m[1];
        // Forma REAL de SQL, case-sensitive (el codebase respeta SQL caps).
        // Evita falsos positivos con prosa (ej. el system prompt de Omnes en
        // chatService.js menciona "recetas/proveedores" sin ser una query).
        const looksLikeSql =
            (/\bSELECT\b/.test(lit) && /\bFROM\b/.test(lit)) ||
            /\bINSERT\s+INTO\b/.test(lit) ||
            (/\bUPDATE\b/.test(lit) && /\bSET\b/.test(lit)) ||
            /\bDELETE\s+FROM\b/.test(lit) ||
            (/\bWITH\b/.test(lit) && /\bAS\s*\(/.test(lit));
        if (looksLikeSql) {
            out.push(lit);
        }
    }
    return out;
}

/**
 * Devuelve la lista de tablas tenant-scoped referenciadas en una query SQL.
 * Match palabra completa para evitar falsos positivos (ventas vs ventas_diarias_resumen).
 */
function tenantTablesUsed(sql) {
    const found = new Set();
    for (const tab of TENANT_TABLES) {
        const re = new RegExp(`\\b${tab}\\b`, 'i');
        if (re.test(sql)) found.add(tab);
    }
    return [...found];
}

function isWhitelisted(sql) {
    if (EXCEPTION_PATTERNS.some(re => re.test(sql))) return true;
    const norm = normalizeSql(sql);
    if (AUDITED_EXCEPTIONS.some(snippet => norm.includes(normalizeSql(snippet)))) return true;
    return false;
}

/**
 * Heurística: si una query tiene placeholders `${var}` para construir el WHERE
 * dinámicamente, asumimos que la variable se construye con `restaurante_id`
 * (patrón usado en search.routes.js y similar). Es seguro siempre que el
 * archivo entero contenga `restaurante_id` (lo verifica el caller).
 */
function hasDynamicWhere(sql) {
    return /WHERE\s+\$\{[a-zA-Z_]+\}/.test(sql);
}

describe('Multi-tenant: queries con tablas tenant-scoped DEBEN filtrar por restaurante_id', () => {
    const files = [...readRouteFiles(), ...readServiceFiles()];

    test('al menos hay archivos de rutas para analizar (sanity check)', () => {
        expect(files.length).toBeGreaterThan(5);
    });

    files.forEach(({ file, content }) => {
        const queries = extractSqlLiterals(content);
        if (queries.length === 0) return;

        test(`${file}: todas las queries con tablas tenant-scoped incluyen restaurante_id`, () => {
            const fileMentionsRestauranteId = /restaurante_id/i.test(content);
            const violations = [];
            for (const sql of queries) {
                const tables = tenantTablesUsed(sql);
                if (tables.length === 0) continue;
                if (isWhitelisted(sql)) continue;
                if (/restaurante_id/i.test(sql)) continue;
                // WHERE dinámico construido en variable: confiamos si el
                // archivo entero contiene restaurante_id (la variable
                // suele empezar por 'restaurante_id = $1').
                if (hasDynamicWhere(sql) && fileMentionsRestauranteId) continue;

                // Snippet de 200 chars + tabla(s) violadora(s) para diagnóstico
                const snippet = sql.replace(/\s+/g, ' ').slice(0, 200);
                violations.push(`  tablas=${tables.join(',')}\n  sql=${snippet}…`);
            }
            if (violations.length > 0) {
                throw new Error(
                    `Queries SIN restaurante_id en ${file}:\n\n` +
                    violations.join('\n\n')
                );
            }
        });
    });
});

// ============================================================
// 🛡️ v2 (auditoría 2026-06-12): locks FOR UPDATE en tablas con
// soft-delete DEBEN incluir `deleted_at IS NULL`.
//
// Bug class que previene: lockear/actualizar una fila soft-deleted.
// Tres casos reales arreglados en la auditoría (DELETE /sales restore,
// POST /daily/purchases/bulk, transfers origen/destino): el lock sin
// deleted_at no devolvía filas con un ingrediente borrado pero el flujo
// seguía y el movimiento de stock se perdía EN SILENCIO.
// ============================================================
const SOFT_DELETE_TABLES = ['ingredientes', 'recetas', 'ventas', 'pedidos', 'mermas', 'proveedores'];

describe('Locks FOR UPDATE en tablas soft-delete incluyen deleted_at IS NULL', () => {
    const allFiles = [
        ...readRouteFiles(),
        ...readServiceFiles(),
        ...UTILS_SQL_FILES.filter(p => fs.existsSync(p)).map(p => ({
            file: `utils/${path.basename(p)}`,
            content: fs.readFileSync(p, 'utf8'),
        })),
    ];

    // También los archivos exentos del scan de tenant (auth/superadmin/etc.)
    // entran aquí: el soft-delete aplica igual en sus locks.
    for (const f of EXCEPTION_FILES) {
        const p = path.join(ROUTES_DIR, f);
        if (fs.existsSync(p)) {
            allFiles.push({ file: f, content: fs.readFileSync(p, 'utf8') });
        }
    }

    allFiles.forEach(({ file, content }) => {
        if (!/FOR UPDATE/i.test(content)) return;

        test(`${file}: cada FOR UPDATE sobre tabla soft-delete lleva deleted_at IS NULL`, () => {
            const violations = [];
            // Examina tanto template literals como strings normales con SQL.
            const literals = [
                ...extractSqlLiterals(content),
                ...(content.match(/'([^']*FOR UPDATE[^']*)'/gi) || []).map(s => s.slice(1, -1)),
                ...(content.match(/"([^"]*FOR UPDATE[^"]*)"/gi) || []).map(s => s.slice(1, -1)),
            ];
            for (const sql of literals) {
                if (!/FOR UPDATE/i.test(sql)) continue;
                const softTables = SOFT_DELETE_TABLES.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(sql));
                if (softTables.length === 0) continue;
                if (/deleted_at\s+IS\s+NULL/i.test(sql)) continue;
                violations.push(`  tablas=${softTables.join(',')}\n  sql=${normalizeSql(sql).slice(0, 180)}…`);
            }
            if (violations.length > 0) {
                throw new Error(
                    `FOR UPDATE sin deleted_at IS NULL en ${file}:\n\n` +
                    violations.join('\n\n') +
                    '\n\nUn lock sin deleted_at puede operar sobre una fila borrada (soft-delete) y perder el movimiento en silencio.'
                );
            }
        });
    });
});
