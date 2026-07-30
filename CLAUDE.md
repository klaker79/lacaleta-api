# CLAUDE.md — Agent Rules for lacaleta-api

La Caleta 102 API is a Node.js/Express monolith backend for restaurant cost management (MindLoop CostOS). PostgreSQL via `pg` pool, JWT auth, bcryptjs, Helmet for security headers, Resend for email. Pure CommonJS (require/module.exports). Tests with Jest + Supertest against a live server.

## Architecture rules

- Use `pool.query()` for simple queries — it auto-acquires and auto-releases the connection.
- Use `pool.connect()` + `try { ... } finally { client.release(); }` ONLY for transactions (BEGIN/COMMIT/ROLLBACK).
- All route handlers must have `try/catch` with error logging via `log('error', ...)` from `src/utils/logger.js`.
- All route params (`:id`) must be validated with `validateId()` from `src/utils/validators.js` before use.
- All SELECT queries on soft-deletable tables must include `AND deleted_at IS NULL`. Tables: ingredientes, recetas, ventas, pedidos, mermas. (NOTA: `recetas_variantes` NO tiene `deleted_at` — usa `activo` + `ON DELETE CASCADE`, ver init.js; corregido en auditoría 2026-07-02.)
- `JSON.parse()` on data from the database must be wrapped in `try/catch` with a safe fallback.

## What NOT to touch

- `GREATEST(0, stock_actual - $1)` in stock deduction — business decision to prevent negative stock. Not a bug.
- `token` field in login JSON response — frontend stores it in sessionStorage and depends on it.
- Bcrypt 5 rounds for API tokens (auth.routes.js) — tokens are `crypto.randomBytes(32)`, not passwords. 5 rounds is fine.
- Token blacklist `Set` in `src/middleware/auth.js` — already has automatic cleanup every 15 minutes (lines 23-37).
- CORS: la lista de orígenes vive SOLO en `src/config/index.js` y `server.js` la LEE de ahí (`corsConfig.allowedOrigins`). NO recrear una lista propia en server.js — ya pasó (`DEFAULT_ORIGINS`) y costó un incidente: se arregló la copia equivocada con el test en verde. Guardián: `tests/unit/cors-aislamiento-casas.test.js` (valida server.js, el archivo que manda).

## Testing

- All test requests must include header `Origin: http://localhost:3001`.
- CI sets `ALLOWED_ORIGINS=http://localhost:3001` as env var. That's how tests pass CORS.
- Tests run against a live server (not mocked). `tests/setup.js` has shared auth helpers.
- Auth tests and rate-limiting tests run in isolation AFTER all other tests (see ci.yml).
- Run `npm test` before any PR.

## Entornos — las tres casas (2026-07-31)

Tres despliegues COMPLETAMENTE separados. Cada casa tiene su web, su API, su
servicio Postgres, su base y su usuario. Nada se comparte.

| Casa | Rama | Web | API | Postgres (servicio / base / user) |
|---|---|---|---|---|
| **Producción** (La Nave 5 — INTOCABLE) | `main` | app.mindloop.cloud | lacaleta-api.mindloop.cloud | `anais-postgres-2s8h7q` / `db` / `admin` — PG 17.10 |
| **Staging** (ensayo, OCR en prueba) | `develop` (= main + OCR) | staging.mindloop.cloud | staging-api.mindloop.cloud | `mindloopstaging-...db-3jgixw` / `mindloop_staging` / `mindloop_staging_admin` — PG 17.10 |
| **Lite** (producto escalable, clientes nuevos) | `lite` (nace de develop) | lite.mindloop.cloud | lite-api.mindloop.cloud | `mindloop-lite-...litedb-osgout` / `mindloop_lite` / `lite_admin` — PG 17.10 |

Reglas que salen de esta separación:

- **CORS por casa**: en producción los orígenes salen SOLO de `ALLOWED_ORIGINS`
  (env en Dokploy). Cada API acepta únicamente su(s) frontend(s). Producción
  lleva además `admin.mindloop.cloud` (el panel admin habla con lacaleta-api).
  Si la lista queda vacía en producción, el servidor NO ARRANCA (a propósito).
- **OCR**: gating GLOBAL por `OCR_ENABLED` (env). Prod = apagado (410).
  Staging y Lite = encendido (401 sin token). Vender OCR por cliente = proyecto
  de gating por tenant, aún no hecho.
- **`plan` ≠ `plan_tier`** (restaurantes): `plan`/`plan_status`/`trial_ends_at`
  = FACTURACIÓN (trial, active…). `plan_tier` = PAQUETE de pestañas ('lite' →
  8 pestañas). Un cliente puede estar en trial Y ver el paquete Lite a la vez.
  Poner `plan='lite'` BLOQUEA la cuenta (no pasa el gate) — ya pasó.
  Guardián: `tests/unit/plan-tier-separado.test.js`.
- **`init.js` es la única verdad del esquema**: debe crear TODO lo que el
  código escribe — es lo único que corre en una BD nueva (= cliente nuevo).
  Columnas nuevas van al `CREATE TABLE` además del `ALTER` (un índice sobre
  una columna que aún no existe tumbó el bloque entero de índices).
  Guardián: `tests/unit/schema-init-cubre-codigo.test.js`.
- **El CI es quien prueba al cliente nuevo**: levanta Postgres desde cero con
  init.js. Las BD vivas tienen deriva de esquema que TAPA fallos (ej.: un
  parámetro SQL reutilizado en columnas DATE y TIMESTAMP revienta solo en BD
  nueva → cast `::date` explícito). CI verde > prueba manual en staging/Lite.
- **Modelo de IA**: el id de Anthropic vive SOLO en `src/config/aiModels.js`.
  Guardián: `tests/unit/ai-model-single-source.test.js`.
- **Deploy**: mergear ≠ desplegado. Tras merge: Redeploy (+ Clean Cache) en
  Dokploy y verificación EN VIVO (health + un endpoint con Origin correcto).
- La config persistente de Dokploy vive en su Postgres (`dokploy-postgres`,
  tabla `postgres`, columna `dockerImage`): si cambias la imagen de una BD por
  fuera de la UI, actualízala TAMBIÉN ahí o el próximo Redeploy la revierte.

## Security

- Never hardcode secrets. All secrets via environment variables.
- CORS: lista única en `src/config/index.js`; en producción SOLO `ALLOWED_ORIGINS` (ver Entornos).
- Helmet handles all security headers. Do not add manual ones.
- Rate limiting via `src/middleware/rateLimit.js` (globalLimiter, authLimiter, costlyApiLimiter).

## Linting

- ESLint configured in `eslint.config.js` (flat config). Run `npm run lint`.
- Bug-focused rules only. No style rules, no Prettier, no formatting enforcement.
- `no-unused-vars` is warn (not error) — warnings do not fail CI.
- Do not add style rules (semicolons, quotes, indentation).

## Critical Business Rules

### Stock Operations
Every route that modifies `stock_actual` must follow these exact formulas:

**Adding stock:**
| Route | Formula | Why |
|-------|---------|-----|
| `PUT /purchases/pending/:id` (approve) | `cantidad × (formato_override \|\| 1)` | User sets format via selector; NULL = ×1 |
| `POST /purchases/pending/approve-batch` | `cantidad × (formato_override \|\| 1)` | Same as single approve |
| `POST /daily/purchases/bulk` (n8n/OCR) | `cantidad` (raw, NO multiplication) | OCR parses in albaran units |
| Frontend pedido reception (bulkAdjustStock) | `cantidadRecibida` **(raw, unidades base)** | `cantidadReal = cantidadValue × formatoMult` ya se multiplicó al crear el pedido (pedidos-crud.js:75). Multiplicar otra vez causa duplicación (bug 2026-04-15 fixed) |

**Subtracting stock:**
| Route | Formula |
|-------|---------|
| `POST /sales` | `(ing.cantidad / porciones) × vendidas × factor_variante` (con expansión recursiva de subrecetas) |
| `DELETE /orders/:id` | `cantidadRecibida` **(raw, unidades base)** (revierte recepción) |
| `POST /mermas` | `cantidad` (direct, base units) |
| Transfers | `cantidad` (direct). REJECTS if origin has insufficient stock |

**Safety rules:**
- `GREATEST(0, ...)` on ALL subtractions (prevent negative stock)
- `FOR UPDATE` lock on ALL stock operations (prevent race conditions)
- `restaurante_id` in EVERY query (multi-tenant)
- `deleted_at IS NULL` on soft-deletable tables: ingredientes, recetas, ventas, pedidos, mermas, proveedores

### Price Priority (MUST be consistent everywhere)
1. `precio_medio_compra` — average from `precios_compra_diarios` (real purchase prices)
2. `precio_medio` — `precio / cantidad_por_formato` (configured price per unit)
3. `precio / cantidad_por_formato` — fallback

**NOTE:** As of 2026-04-09, both approve endpoints (single + batch) normalize `precio_unitario` to unit price before storing in `precios_compra_diarios`. Formula: `total_albaran / (cantidad × formato_override)`. This ensures `precio_medio_compra` is always a true unit price. Frontend uses `getIngredientUnitPrice()` from `cost-calculator.js` with priority: `precio_medio_compra > precio_medio > precio/cpf`.

**⛔ STABILITY WARNING (baseline 2026-04-09):**
Full audit verified frontend (10 tabs), backend (all routes), and chat (n8n) are consistent.
DO NOT change price normalization in approve endpoints without verifying:
- Frontend getIngredientUnitPrice() still works with the data
- P&L monthly/summary factor_variante via cantidad_ponderada still correct
- Chat n8n query for precio_unitario_real still returns correct values
- All cost calculations across balance, sales, analysis, intelligence routes match

### Food Cost Thresholds
- **Food (comida):** ≤30% excellent, 31-35% target, 36-40% watch, >40% alert
- **Wine (vinos):** target 45% — DO NOT apply food thresholds to wine
- **Margin equivalents:** ≥67% OK, 62-66% warn, <62% alert

### Formulas (Jack Miller method)
- Food Cost % = (coste_porcion / precio_venta) × 100
- Margen % = ((precio_venta - coste) / precio_venta) × 100
- Coste por porción = suma_ingredientes / porciones
- Rendimiento: costeReal = precio / (rendimiento / 100)

### Multi-tenant
- `restaurante_id` in EVERY query. No exceptions.
- Frontend owns stock adjustments. Backend orders POST/PUT NEVER touch stock_actual.

### OCR/Purchase Flow (actualizado 2026-07-31)
- Flujo principal (móvil): foto albarán → `POST /parse-albaran` (Claude Vision)
  → líneas en `compras_pendientes` (matcheo por `ingredientMatcher`) → revisión
  → `POST /purchases/pending/approve-batch`.
- **Aprobar CREA UN PEDIDO en estado `'recibido'`** (fecha = la del ALBARÁN, no
  la de hoy) y enlaza el Diario por `pedido_id` — así la compra sale en la
  pestaña Pedidos y se puede revertir con `DELETE /orders/:id`. Aplica a las
  DOS puertas (batch y línea suelta). Guardián:
  `tests/unit/aprobar-compra-crea-pedido.test.js`.
- Los TRES flujos OCR (parse, alta pendientes, bulk legacy n8n) matchean con
  `src/utils/ingredientMatcher.js` (por palabras). NUNCA matchear por inclusión
  de cadena: "sal" está dentro de "salmón". Guardián:
  `tests/unit/ocr-matcheo-unico.test.js`.
- Dedup: fuzzy matching contra `estado IN ('pendiente','aprobado','recibido_en_pedido')`.
- Guardrail: stock additions > 10,000 units are auto-rejected.
- Guardrail: precio < 0.05 + cantidad > 100 flagged as suspicious.

### Trial / Billing (Polar) — ⛔ NO romper (es dinero)
- Alta nueva (`/auth/register`): `plan='trial'`, `plan_status='trialing'`, `trial_ends_at = alta + TRIAL_DAYS` (**TRIAL_DAYS=10**), `max_users=5`.
- Gating (`middleware/planGate.js`, `middleware/requireActiveSubscription.js`): acceso OK si `plan_status='active'` (pago vigente) **o** `plan='trial' && trial_ends_at > now()` (trial vigente). La **caducidad del trial SOLO se comprueba cuando `plan='trial'`**.
- ⛔ La migración de grandfathering en `init.js` (`UPDATE restaurantes SET plan='premium', plan_status='active'... WHERE plan='trial'`) **DEBE** llevar `AND created_at < '2026-05-20'`. Sin cutoff corre en CADA arranque y re-promociona a premium a TODO trial nuevo → el trial nunca caduca. Protegido por `tests/guards/trial-grandfather-guard.test.js` (incidente 2026-06-29).

### IVA (Migr. 015 iva_pct, Migr. 016 bonificacion)
- `pedidos.iva_pct` y `pedidos.bonificacion` se persisten por pedido. **`pedido.total` = BASE sin IVA** (lo que va a gasto/P&L). `iva_pct` NUNCA entra en `total` ni en food cost. `bonificacion` se prorratea en `precioReal` al recibir (baja el coste real). ⚠️ `calcularTotalPedido()` (frontend) lleva IVA → NUNCA usar para el total persistido.
- Items `tipo:'ajuste'` (envases/bonificaciones) NO llevan `ingredienteId`: excluirlos en validaciones y agregados (POST /orders recibido líneas 100-106, y resto del flujo).
- **Informe "IVA soportado del periodo"**: `GET /balance/iva-soportado` (read-only; `costlyApiLimiter` ANTES de `authMiddleware`). Base imponible = `pedido.total − personalCostExpr('p') − Σ(items 'ajuste'.importe)`, ×`iva_pct/100`, solo pedidos `recibido` del mes. Devuelve `iva_soportado`, `base_imponible`, `num_pedidos_con_iva`. **Informativo, FUERA de la P&L** (el IVA soportado se recupera). Verificado vs albarán EG (base 67,78 → IVA 14,23). Cubierto por `personal-cost-guard` (todo `SUM(pedidos.total)` resta lo personal vía `personalCostExpr`).
