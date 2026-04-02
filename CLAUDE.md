# CLAUDE.md — Agent Rules for lacaleta-api

La Caleta 102 API is a Node.js/Express monolith backend for restaurant cost management (MindLoop CostOS). PostgreSQL via `pg` pool, JWT auth, bcryptjs, Helmet for security headers, Resend for email. Pure CommonJS (require/module.exports). Tests with Jest + Supertest against a live server.

## Architecture rules

- Use `pool.query()` for simple queries — it auto-acquires and auto-releases the connection.
- Use `pool.connect()` + `try { ... } finally { client.release(); }` ONLY for transactions (BEGIN/COMMIT/ROLLBACK).
- All route handlers must have `try/catch` with error logging via `log('error', ...)` from `src/utils/logger.js`.
- All route params (`:id`) must be validated with `validateId()` from `src/utils/validators.js` before use.
- All SELECT queries on soft-deletable tables must include `AND deleted_at IS NULL`. Tables: ingredientes, recetas, ventas, pedidos, mermas, recetas_variantes.
- `JSON.parse()` on data from the database must be wrapped in `try/catch` with a safe fallback.

## What NOT to touch

- `GREATEST(0, stock_actual - $1)` in stock deduction — business decision to prevent negative stock. Not a bug.
- `token` field in login JSON response — frontend stores it in sessionStorage and depends on it.
- Bcrypt 5 rounds for API tokens (auth.routes.js) — tokens are `crypto.randomBytes(32)`, not passwords. 5 rounds is fine.
- Token blacklist `Set` in `src/middleware/auth.js` — already has automatic cleanup every 15 minutes (lines 23-37).
- `DEFAULT_ORIGINS` in server.js — only 5 production/dev origins. Do NOT add localhost:3001 here.

## Testing

- All test requests must include header `Origin: http://localhost:3001`.
- CI sets `ALLOWED_ORIGINS=http://localhost:3001` as env var. That's how tests pass CORS.
- Tests run against a live server (not mocked). `tests/setup.js` has shared auth helpers.
- Auth tests and rate-limiting tests run in isolation AFTER all other tests (see ci.yml).
- Run `npm test` before any PR.

## Security

- Never hardcode secrets. All secrets via environment variables.
- CORS: 5 DEFAULT_ORIGINS hardcoded + ALLOWED_ORIGINS env var merged at runtime.
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
| Frontend pedido reception (bulkAdjustStock) | `cantidadRecibida × cantidad_por_formato` | User says "2 cajas" |

**Subtracting stock:**
| Route | Formula |
|-------|---------|
| `POST /sales` | `(ing.cantidad / porciones) × vendidas × factor_variante` |
| `DELETE /orders/:id` | `cantidadRecibida × cantidad_por_formato` (reverses frontend) |
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

**WARNING:** `precio_medio_compra` may contain FORMAT prices (per caja/garrafa), not unit prices. Only use in backend calculations where the data is known to be normalized. The frontend memoized function intentionally uses `precio_medio` only.

### Food Cost Thresholds
- **Food (comida):** ≤28% excellent, 29-33% target, 34-38% watch, >38% alert
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

### OCR/Purchase Flow
- n8n + Gemini → POST /purchases/pending → user reviews → approve
- App scanner endpoint exists but is disabled
- Dedup: fuzzy matching (7 days for n8n, 60 days for scanner)
- Guardrail: stock additions > 10,000 units are auto-rejected
- Guardrail: precio < 0.05 + cantidad > 100 flagged as suspicious
