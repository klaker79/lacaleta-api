# Personal extra por horas → PyG · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Registrar pagos a extras por horas y que cuenten como coste en el PyG (bajan el beneficio del periodo).

**Architecture:** Tabla nueva `personal_extra` (backend Postgres) con CRUD calcado de `gastos_fijos`; el PyG suma `personal_extra_periodo` por rango de fechas (sin prorratear) y lo resta del beneficio en TODOS los puntos donde se calcula. Frontend: sección bajo gastos fijos en el módulo `balance`.

**Tech Stack:** Backend `lacaleta-api` (Node CommonJS, Express, Postgres `pg`, Jest+Supertest). Frontend `MindLoop-CostOS` (vanilla JS + Vite, Jest+jsdom).

## Global Constraints
- **Dos repos.** Rutas relativas a la raíz de cada uno: `[API]` = `lacaleta-api/`, `[FE]` = `MindLoop-CostOS/`. Ramas desde `develop` en ambos. App en PRODUCCIÓN — probar en staging, NO PR a main sin pedirlo.
- **Backend:** `restaurante_id` en CADA query. `pool.query()` (no transacción aquí). `try/catch` + `log('error',…)`. `validateId()` en `:id`. `validatePrecio()`/`sanitizeString()` para entradas. `logChange()` en mutaciones. Tests con header `Origin: http://localhost:3001`. `npm test` y `npm run lint` antes de cerrar.
- **Frontend:** `escapeHTML()` en datos de usuario al render. Null-guard en accesos al DOM. Tras cambiar JS cacheado: cache-bust en `index.html` + bump `CACHE_NAME` en `public/sw.js`. `npm run lint` (0 errores) + `npm test`.
- **No prorratear** el personal extra: es coste real con fecha (sumar por rango).

## Estructura de ficheros
| Repo | Fichero | Responsabilidad | Acción |
|---|---|---|---|
| API | `src/db/init.js` | Migración tabla `personal_extra` | Modificar |
| API | `src/routes/personal-extra.routes.js` | CRUD | Crear |
| API | `src/application/bootstrap.js` (o donde se montan routers) | Montar router | Modificar |
| API | `src/services/chatService.js` | `resumen_pyg`: línea personal_extra | Modificar |
| API | `src/services/informeMensualService.js` (+ `informeMensualHtml.js`) | Línea en informe mensual | Modificar |
| API | `tests/personal-extra.test.js` | Tests CRUD + aislamiento | Crear |
| API | `tests/pyg-personal-extra.test.js` | Test PyG resta el extra | Crear |
| FE | `src/api/client.js` | 4 métodos API | Modificar |
| FE | `src/modules/balance/personal-extra.js` | UI sección | Crear |
| FE | `src/modules/balance/index.js` | Montar la sección | Modificar |

---

## Task 1: Migración tabla `personal_extra` (backend)

**Files:** Modify: `[API] src/db/init.js`

**Interfaces — Produces:** tabla `personal_extra (id, restaurante_id, fecha DATE, nombre, horas, precio_hora, total, observaciones, created_at, updated_at)` + índice `(restaurante_id, fecha)`.

- [ ] **Step 1: Localiza el patrón de migración "tabla verificada"** en `src/db/init.js` (cómo se crea `gastos_fijos` con `CREATE TABLE IF NOT EXISTS` dentro de un `try/catch` con `log('info'/'warn', …)`, ~líneas 525-539). Añade un bloque nuevo SIGUIENDO ese patrón:

```js
  // Tabla personal_extra (pagos a extras por horas → cuenta en PyG)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS personal_extra (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        fecha DATE NOT NULL,
        nombre VARCHAR(255),
        horas NUMERIC(6,2) NOT NULL DEFAULT 0,
        precio_hora NUMERIC(8,2) NOT NULL DEFAULT 0,
        total NUMERIC(10,2) NOT NULL DEFAULT 0,
        observaciones TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_personal_extra_rest_fecha
        ON personal_extra (restaurante_id, fecha);
    `);
    log('info', 'Tabla personal_extra verificada');
  } catch (e) { log('warn', 'Migración personal_extra', { error: e.message }); }
```

- [ ] **Step 2: Verificar arranque** — `cd lacaleta-api && node -e "require('./src/db/init.js')"` no es trivial (necesita pool); en su lugar comprueba sintaxis: `node --check src/db/init.js && echo OK`. (La tabla se creará al arrancar el server contra la BD.)

- [ ] **Step 3: Commit** — `git add src/db/init.js && git commit -m "feat(db): tabla personal_extra (extras por horas)"`

---

## Task 2: CRUD `personal-extra.routes.js` + montaje (backend)

**Files:** Create: `[API] src/routes/personal-extra.routes.js` · Modify: bootstrap de routers · Test: `[API] tests/personal-extra.test.js`

**Interfaces — Produces:** `GET/POST/PUT/DELETE /api/personal-extra`. POST/PUT calculan `total = round(horas*precio_hora, 2)`. GET acepta `?desde&hasta` (default: mes en curso) y filtra por `restaurante_id`.

- [ ] **Step 1: Test que falla** (`tests/personal-extra.test.js`). Usa los helpers de auth de `tests/setup.js` (mira otro test, p.ej. el de gastos si existe, para el patrón exacto de login/headers). Header obligatorio `Origin: http://localhost:3001`.

```js
const request = require('supertest');
const { baseURL, authHeaders } = require('./setup'); // ajustar a los helpers reales del repo

describe('personal-extra CRUD', () => {
  let headers; let createdId;
  beforeAll(async () => { headers = await authHeaders(); });

  it('POST calcula total = horas*precio_hora', async () => {
    const r = await request(baseURL).post('/api/personal-extra')
      .set(headers).set('Origin', 'http://localhost:3001')
      .send({ fecha: '2026-06-10', nombre: 'Extra Test', horas: 4.5, precio_hora: 12.5 });
    expect(r.status).toBe(201);
    expect(Number(r.body.total)).toBeCloseTo(56.25, 2);
    createdId = r.body.id;
  });

  it('GET filtra por rango de fechas', async () => {
    const r = await request(baseURL).get('/api/personal-extra?desde=2026-06-01&hasta=2026-06-30')
      .set(headers).set('Origin', 'http://localhost:3001');
    expect(r.status).toBe(200);
    expect(r.body.some(x => x.id === createdId)).toBe(true);
    const fuera = await request(baseURL).get('/api/personal-extra?desde=2026-01-01&hasta=2026-01-31')
      .set(headers).set('Origin', 'http://localhost:3001');
    expect(fuera.body.some(x => x.id === createdId)).toBe(false);
  });

  it('DELETE elimina', async () => {
    const r = await request(baseURL).delete('/api/personal-extra/' + createdId)
      .set(headers).set('Origin', 'http://localhost:3001');
    expect(r.status).toBe(200);
  });
});
```
(Ajusta `baseURL`/`authHeaders` a los nombres reales que exporte `tests/setup.js`.)

- [ ] **Step 2: Ejecutar y ver que falla** — `npm test -- personal-extra` → FALLA (ruta no existe).

- [ ] **Step 3: Crear `src/routes/personal-extra.routes.js`** (calcado de `gastos.routes.js`):

```js
/**
 * personal-extra Routes — pagos a extras por horas (cuentan en el PyG).
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { validatePrecio, sanitizeString, validateId } = require('../utils/validators');
const { logChange } = require('../utils/auditLog');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// fecha YYYY-MM-DD válida; si no, null
const fechaOk = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;

module.exports = function (pool) {
    const router = Router();

    // GET lista por rango (default: mes en curso)
    router.get('/personal-extra', authMiddleware, async (req, res) => {
        try {
            const hoy = new Date();
            const ym = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}`;
            const desde = fechaOk(req.query.desde) || `${ym}-01`;
            const hasta = fechaOk(req.query.hasta) || `${ym}-31`;
            const result = await pool.query(
                'SELECT * FROM personal_extra WHERE restaurante_id = $1 AND fecha >= $2 AND fecha <= $3 ORDER BY fecha DESC, id DESC',
                [req.restauranteId, desde, hasta]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST crear
    router.post('/personal-extra', authMiddleware, async (req, res) => {
        try {
            const fecha = fechaOk(req.body.fecha);
            if (!fecha) return res.status(400).json({ error: 'Fecha inválida (YYYY-MM-DD)' });
            const nombre = req.body.nombre !== undefined ? sanitizeString(req.body.nombre, 255) : null;
            const horas = validatePrecio(req.body.horas);
            const precio_hora = validatePrecio(req.body.precio_hora);
            const observaciones = req.body.observaciones !== undefined ? sanitizeString(req.body.observaciones, 1000) : null;
            const total = round2(horas * precio_hora);
            const result = await pool.query(
                `INSERT INTO personal_extra (restaurante_id, fecha, nombre, horas, precio_hora, total, observaciones)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [req.restauranteId, fecha, nombre, horas, precio_hora, total, observaciones]
            );
            log('info', 'Personal extra creado', { id: result.rows[0].id });
            logChange(pool, { req, tabla: 'personal_extra', operacion: 'INSERT', registroId: result.rows[0].id, datosAntes: null, datosDespues: result.rows[0] });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // PUT actualizar (recalcula total)
    router.put('/personal-extra/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
            const prev = (await pool.query('SELECT * FROM personal_extra WHERE id = $1 AND restaurante_id = $2', [id, req.restauranteId])).rows[0];
            if (!prev) return res.status(404).json({ error: 'No encontrado' });
            const fecha = req.body.fecha !== undefined ? (fechaOk(req.body.fecha) || prev.fecha) : prev.fecha;
            const nombre = req.body.nombre !== undefined ? sanitizeString(req.body.nombre, 255) : prev.nombre;
            const horas = req.body.horas !== undefined ? validatePrecio(req.body.horas) : Number(prev.horas);
            const precio_hora = req.body.precio_hora !== undefined ? validatePrecio(req.body.precio_hora) : Number(prev.precio_hora);
            const observaciones = req.body.observaciones !== undefined ? sanitizeString(req.body.observaciones, 1000) : prev.observaciones;
            const total = round2(horas * precio_hora);
            const result = await pool.query(
                `UPDATE personal_extra SET fecha=$1, nombre=$2, horas=$3, precio_hora=$4, total=$5, observaciones=$6, updated_at=CURRENT_TIMESTAMP
                 WHERE id=$7 AND restaurante_id=$8 RETURNING *`,
                [fecha, nombre, horas, precio_hora, total, observaciones, id, req.restauranteId]
            );
            logChange(pool, { req, tabla: 'personal_extra', operacion: 'UPDATE', registroId: id, datosAntes: prev, datosDespues: result.rows[0] });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE (borrado real — es una libreta)
    router.delete('/personal-extra/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
            const result = await pool.query('DELETE FROM personal_extra WHERE id = $1 AND restaurante_id = $2 RETURNING id', [id, req.restauranteId]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
            logChange(pool, { req, tabla: 'personal_extra', operacion: 'DELETE', registroId: id, datosAntes: { id }, datosDespues: null });
            res.json({ message: 'Personal extra eliminado' });
        } catch (err) {
            log('error', 'Error eliminando personal_extra', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
```

- [ ] **Step 4: Montar el router.** Busca cómo se monta `gastos.routes.js`: `grep -rn "gastos.routes\|gastos-fijos" src/` y replica EXACTAMENTE el mismo patrón (require + `app.use('/api', require('./routes/personal-extra.routes')(pool))` o como esté hecho) para `personal-extra.routes`. NO cambies el de gastos.

- [ ] **Step 5: Arranca el server de test y pasa los tests** — `npm test -- personal-extra` → VERDE (3 tests).

- [ ] **Step 6: Aislamiento multi-tenant.** Añade al test un caso: crea un extra como restaurante A y verifica que un GET autenticado como restaurante B NO lo devuelve. (Usa el segundo set de credenciales de `tests/setup.js` si existe; si no, documsenta el caso y omítelo con `it.skip` indicando por qué.) Reejecuta.

- [ ] **Step 7: Commit** — `git add src/routes/personal-extra.routes.js tests/personal-extra.test.js <bootstrap> && git commit -m "feat(api): CRUD /personal-extra (extras por horas) con aislamiento por restaurante"`

---

## Task 3: Integrar en el PyG — `resumen_pyg` (backend)

**Files:** Modify: `[API] src/services/chatService.js` (case `resumen_pyg`, ~líneas 1118-1221) · Test: `[API] tests/pyg-personal-extra.test.js`

**Interfaces — Consumes:** tabla `personal_extra`. **Produces:** campo `personal_extra_periodo` en la respuesta de `resumen_pyg`; `margen_neto_aprox` lo resta.

- [ ] **Step 1: Test que falla** (`tests/pyg-personal-extra.test.js`): por API, (1) pide `resumen_pyg`/endpoint del PyG para un rango y guarda `margen_neto_aprox`; (2) crea un `personal_extra` de 50 € dentro del rango; (3) vuelve a pedir el PyG; (4) espera que `personal_extra_periodo === 50` y que el nuevo `margen_neto_aprox` sea exactamente `anterior − 50`. (Si el PyG solo se invoca vía la tool del chat, llama al endpoint que ejecuta `resumen_pyg`; busca con `grep -rn "resumen_pyg" src/` cómo se expone.) Ejecuta → FALLA.

- [ ] **Step 2: Implementar.** En el `case 'resumen_pyg'`, tras el bloque de `gastos` (donde se calcula `gastos_fijos_mes`), añade:

```js
            const peRow = (await pool.query(`
                SELECT COALESCE(SUM(total), 0)::numeric(12,2) AS personal_extra_periodo
                FROM personal_extra
                WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3
            `, [restauranteId, desde, hasta])).rows[0];
            const personal_extra_periodo = parseFloat(peRow.personal_extra_periodo) || 0;
```

Cambia la línea de `margen_neto` para restarlo:
```js
            const margen_neto = Math.round((ingresos - cogs_periodo - pr.gastos_fijos_periodo - comida_personal - personal_extra_periodo) * 100) / 100;
```

Añade el campo al objeto devuelto (junto a `comida_personal`):
```js
                comida_personal,
                personal_extra_periodo,
```

Y en la `nota`, añade una frase: ` personal_extra_periodo es el pago a extras por horas del periodo (coste real con fecha, NO se prorratea); ya está restado en margen_neto_aprox.`

- [ ] **Step 3: Actualiza la descripción de la tool** `resumen_pyg` (donde dice "...gastos fijos, comida de personal y beneficio neto...") para mencionar también "personal extra". Busca el `description:` del tool (~línea 861) y añade el concepto.

- [ ] **Step 4: Ejecutar y ver verde** — `npm test -- pyg-personal-extra`.

- [ ] **Step 5: Regresión PyG** — `npm test -- pyg` (o el fichero de tests del PyG existente) sigue verde.

- [ ] **Step 6: Commit** — `git add src/services/chatService.js tests/pyg-personal-extra.test.js && git commit -m "feat(pyg): restar personal_extra del beneficio en resumen_pyg"`

---

## Task 4: Informe mensual incluye Personal extra (backend)

**Files:** Modify: `[API] src/services/informeMensualService.js` (+ `src/services/informeMensualHtml.js` si la línea se pinta ahí)

**Interfaces — Consumes:** tabla `personal_extra`.

- [ ] **Step 1: Leer** `informeMensualService.js` y localizar dónde se suman `gastos_fijos`/`comida_personal` y se calcula el beneficio del informe. Replica el patrón para `personal_extra`:

```js
const personalExtra = (await pool.query(`
    SELECT COALESCE(SUM(total), 0)::numeric(12,2) AS total
    FROM personal_extra
    WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3
`, [restauranteId, desde, hasta])).rows[0];
const personal_extra = parseFloat(personalExtra.total) || 0;
```
Réstalo en el beneficio del informe y pásalo a la plantilla. En `informeMensualHtml.js` añade una fila "Personal extra" junto a "Comida de personal".

- [ ] **Step 2: Verificación** — `node --check src/services/informeMensualService.js src/services/informeMensualHtml.js`. Si hay test del informe mensual, ejecútalo; si no, genera el informe en local para un mes con un apunte y confirma que la línea aparece y el beneficio baja.

- [ ] **Step 3: Commit** — `git add src/services/informeMensual*.js && git commit -m "feat(informe): línea Personal extra en el informe mensual"`

---

## Task 5: Frontend — sección "Personal extra" en balance (FE)

**Files:** Modify: `[FE] src/api/client.js`, `[FE] src/modules/balance/index.js` · Create: `[FE] src/modules/balance/personal-extra.js` · (cache-bust `index.html` + `public/sw.js`)

**Interfaces — Consumes:** `GET/POST/PUT/DELETE /api/personal-extra`.

- [ ] **Step 1: Cliente API.** En `src/api/client.js`, localiza cómo están los métodos de `gastos-fijos` (`grep -n "gastos-fijos" src/api/client.js`) y añade los equivalentes:
```js
getPersonalExtra: (desde, hasta) => apiGet(`/personal-extra?desde=${desde}&hasta=${hasta}`),
crearPersonalExtra: (data) => apiPost('/personal-extra', data),
actualizarPersonalExtra: (id, data) => apiPut(`/personal-extra/${id}`, data),
borrarPersonalExtra: (id) => apiDelete(`/personal-extra/${id}`),
```
(Ajusta a los helpers reales `apiGet/apiPost/...` que use el fichero.)

- [ ] **Step 2: Crear `src/modules/balance/personal-extra.js`** — render de la sección: formulario (fecha=hoy por defecto, nombre opcional, horas, €/hora, total en vivo = horas×€/h) + tabla del periodo (fecha, nombre, horas, €/h, total, botón borrar) + subtotal. Usa `escapeHTML()` en `nombre` al pintar. Null-guards en `getElementById`. Exporta `renderPersonalExtra(contenedor, { desde, hasta })`.

- [ ] **Step 3: Montar** en `src/modules/balance/index.js`: tras renderizar los gastos fijos, crea un contenedor y llama `renderPersonalExtra(...)` con el rango del periodo activo del balance. Sigue el estilo visual de la sección de gastos fijos.

- [ ] **Step 4: Test (jsdom)** `[FE] src/modules/balance/personal-extra.test.js`: el subtotal mostrado = suma de los `total` de las filas; el render de un nombre con `<img>`/comillas queda escapado (no inyecta HTML).

- [ ] **Step 5: Cache-bust + SW.** Si la sección carga JS nuevo vía `index.html`, añade/bumpea su `?v=`; bumpea `CACHE_NAME` en `public/sw.js` (v182→v183).

- [ ] **Step 6: Verificar** — `npm run lint` (0 errores) + `npm test` (suite verde) + `npm run build`.

- [ ] **Step 7: Commit** — `git add src/api/client.js src/modules/balance/ index.html public/sw.js && git commit -m "feat(balance): sección Personal extra por horas (apunte + subtotal)"`

---

## Task 6: Despliegue a staging y prueba

- [ ] **Step 1: Push ramas a develop.** Backend: PR `feat/personal-extra-pyg → develop` (o merge). Frontend: rama análoga `feat/personal-extra-balance → develop`. Esto despliega a staging.
- [ ] **Step 2: Migración en staging.** Al arrancar el backend de staging, `init.js` crea la tabla. Verifícalo (SSH + docker exec a `mindloopstagingdb`): `SELECT to_regclass('public.personal_extra');` debe devolver la tabla.
- [ ] **Step 3: Smoke en `staging.mindloop.cloud`** (tenant Demo Trattoria): apunta un extra (p.ej. 3 h × 10 €) → aparece en la lista con total 30 € → comprueba que el beneficio del periodo baja 30 € (vía chat "dame el PyG de este mes" o la pantalla de balance). Consola sin errores.
- [ ] **Step 4:** Solo tras OK en staging y visto bueno del usuario → PR a `main` en ambos repos (NO sin pedirlo).

---

## Checklist de cobertura del spec
- [x] Tabla `personal_extra` (fecha, nombre opc., horas, €/h, total) → Task 1
- [x] CRUD backend multi-tenant, total calculado en servidor → Task 2
- [x] PyG resta personal_extra sin prorratear (resumen_pyg) → Task 3
- [x] Informe mensual incluye la línea → Task 4
- [x] UI junto a gastos fijos (balance) con subtotal → Task 5
- [x] Tests: CRUD + aislamiento + PyG + regresión + front → Tasks 2,3,5
- [x] Staging primero, main solo con permiso → Task 6
