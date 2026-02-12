# CostOS Post-Hardening Analysis Report

**Date:** 2026-02-11
**Scope:** Backend API (`lacaleta-api`), Tests, Security, Performance
**Baseline:** 10 critical fixes applied + businessHelpers refactoring + composite indexes

> **Note:** The frontend repo (`mindloop-costos`) is not accessible in this environment. Frontend analysis is excluded from this report.

---

## Table of Contents

1. [Critical Issues (data loss, security)](#1-critical-issues)
2. [Important Issues (performance, UX, maintainability)](#2-important-issues)
3. [Nice-to-Have (refactoring, DX, consistency)](#3-nice-to-have)
4. [Quality Review of Applied Fixes (C1-C10)](#4-quality-review-of-applied-fixes)
5. [Test Coverage Gaps](#5-test-coverage-gaps)
6. [Performance Post-Indexes](#6-performance-post-indexes)
7. [Detailed Fix Proposals](#7-detailed-fix-proposals)

---

## 1. Critical Issues

### C-NEW-01: `.env` files with real secrets committed to git

**Severity:** CRITICAL
**Files:** `.env`, `.env.development`
**Evidence:** `git ls-files .env .env.development` returns both files as tracked.

The `.gitignore` only contains `node_modules/`. Both `.env` files are committed and contain:

- `JWT_SECRET=mindloop-costos-secret-2024` (weak, predictable)
- `RESEND_API_KEY=re_HxUcv1NH_7YerdAPrA9PsKF9m1VYY9Npg` (real API key)
- `TEST_USER_PASSWORD=18061979` (real credentials)
- `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` (database credentials)

**Impact:** Anyone with repo access has full API keys, JWT secret, and user credentials. The JWT_SECRET being known means anyone can forge valid tokens for any user.

**Fix:**
```bash
# 1. Add to .gitignore
echo -e ".env\n.env.*\nserver.log\n*.log" >> .gitignore

# 2. Remove from git tracking (keeps files locally)
git rm --cached .env .env.development

# 3. Rotate ALL secrets immediately:
#    - Generate new JWT_SECRET (min 64 chars random)
#    - Regenerate RESEND_API_KEY
#    - Change user passwords
#    - Use a .env.example with placeholder values
```

### C-NEW-02: Weak JWT_SECRET — trivially guessable

**Severity:** CRITICAL
**File:** `.env:1`

`JWT_SECRET=mindloop-costos-secret-2024` is a human-readable string. Combined with C-NEW-01, this means tokens can be forged. Even without the repo, this secret could be brute-forced or guessed.

**Fix:** Use `crypto.randomBytes(64).toString('hex')` to generate a proper secret. Enforce minimum length check in `src/config/index.js`.

### C-NEW-03: JWT logout does not invalidate tokens

**Severity:** CRITICAL
**File:** `server.js:838-842`

```javascript
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    res.json({ success: true });
});
```

Logout only clears the cookie. The JWT itself remains valid for 7 days. If a token is stolen, logout cannot revoke it.

**Fix:** Implement a token blacklist (Redis or DB table) checked by `authMiddleware`. On logout, add the token's `jti` (JWT ID) to the blacklist. Alternatively, implement short-lived tokens (15min) with refresh tokens.

### C-NEW-04: `DELETE /api/sales/:id` missing `requireAdmin`

**Severity:** CRITICAL
**File:** `server.js:2878`

Any authenticated user can delete sales records. Since deleting a sale also restores stock, this is both a data integrity and security issue.

```javascript
// Current:
app.delete('/api/sales/:id', authMiddleware, async (req, res) => {
// Should be:
app.delete('/api/sales/:id', authMiddleware, requireAdmin, async (req, res) => {
```

### C-NEW-05: `POST /api/sales/bulk` missing `requireAdmin`

**Severity:** CRITICAL
**File:** `server.js:3082`

Bulk sales import can insert hundreds of records, modify stock, and update daily summaries. Any authenticated user can trigger this.

```javascript
// Current:
app.post('/api/sales/bulk', authMiddleware, async (req, res) => {
// Should be:
app.post('/api/sales/bulk', authMiddleware, requireAdmin, async (req, res) => {
```

### C-NEW-06: `recetas_variantes` queries lack `restaurante_id` check — IDOR

**Severity:** CRITICAL
**File:** `server.js:2791-2794`

```javascript
const varianteResult = await client.query(
    'SELECT precio_venta, factor FROM recetas_variantes WHERE id = $1 AND receta_id = $2',
    [varianteId, recetaId]
);
```

The variant lookup in POST /api/sales does not verify `restaurante_id`. If a user knows a variant ID from another restaurant, the query will return it. The receta_id check offers some protection (since recetas are already filtered by restaurante_id), but the variant table itself should be filtered.

**Also at:** `server.js:3218` (bulk sales variant lookup)

**Fix:** Add `AND restaurante_id = $3` or join through `recetas` table with restaurante_id filter.

### C-NEW-07: Merma stock restoration conflicts with frontend

**Severity:** CRITICAL (data inconsistency)
**File:** `server.js:4820-4821` vs `server.js:5032-5047`

The `POST /api/mermas` endpoint has a comment:
```javascript
// NOTA: El frontend ya descuenta el stock antes de llamar este endpoint
// NO descontar aquí para evitar doble descuento
```

But `DELETE /api/mermas/:id` DOES restore stock:
```javascript
if (merma.ingrediente_id && merma.cantidad > 0) {
    // Restores stock_actual += merma.cantidad
}
```

If the frontend deducted stock before creating the merma, and then the user deletes the merma, stock gets restored on the backend. But the stock was never deducted on the backend, creating a stock inflation bug. The frontend deduction and backend restoration are asymmetric.

**Fix:** Either:
a) Backend handles BOTH deduction (on create) and restoration (on delete), OR
b) Backend handles NEITHER, and frontend manages both.
Option (a) is recommended — make POST /api/mermas deduct stock server-side and remove frontend deduction.

### C-NEW-08: Dockerfile copies `.env` into container image

**Severity:** CRITICAL
**File:** `Dockerfile:9`

```dockerfile
COPY . .
```

This copies `.env` with all secrets into the Docker image. Anyone with access to the image can extract secrets.

**Fix:** Add a `.dockerignore` file:
```
.env
.env.*
.git
server.log
node_modules
tests
backups
_dormant
```

---

## 2. Important Issues

### I-NEW-01: `POST /api/auth/register` missing rate limiting

**File:** `server.js:897`

Registration uses only the global limiter (1000 req/15min). It should use `authLimiter` like login, forgot-password, etc.

```javascript
// Current:
app.post('/api/auth/register', async (req, res) => {
// Should be:
app.post('/api/auth/register', authLimiter, async (req, res) => {
```

### I-NEW-02: `DELETE /api/empleados/:id` missing `requireAdmin`

**File:** `server.js:3404`

Any authenticated user can deactivate employees. HR operations should require admin role.

### I-NEW-03: `normalizar()` function duplicated

**File:** `server.js:3820` and `server.js:4199`

The exact same function for normalizing ingredient names appears in both `POST /api/purchases/pending` and `POST /api/daily/purchases/bulk`. Should be extracted to `businessHelpers.js`.

### I-NEW-04: `POST /api/horarios/copiar-semana` not wrapped in transaction

**File:** `server.js:3516-3554`

Copying a week's schedules uses individual INSERTs without a transaction. If the loop fails midway, partial data remains.

```javascript
// Current: individual pool.query() calls in a loop
// Should be: wrapped in BEGIN/COMMIT with client
```

### I-NEW-05: `PUT /api/inventory/:id/stock-real` missing `FOR UPDATE`

**File:** `server.js:2085-2112`

This endpoint updates stock without row locking, unlike the bulk variant (which was fixed with FOR UPDATE). Concurrent updates can cause lost writes.

### I-NEW-06: Unbounded array processing — no size limits

**Files:**
- `server.js:4788` — `POST /api/mermas`: no limit on `mermas.length`
- `server.js:3082` — `POST /api/sales/bulk`: no limit on `ventas.length`
- `server.js:3805` — `POST /api/purchases/pending`: no limit on `compras.length`
- `server.js:1606` — `POST /api/ingredients/bulk-adjust-stock`: no limit on items

A single request could send thousands of items, causing long-running transactions and potential memory issues.

**Fix:** Add max array length checks (e.g., 500 items per request).

### I-NEW-07: `GET /api/mermas` ignores month/year filter parameters

**File:** `server.js:4906-4971`

The endpoint accepts `mes` and `ano` query params and parses them (L4907-4908), but the actual SQL query does NOT filter by month/year:

```sql
WHERE m.restaurante_id = $1 AND m.deleted_at IS NULL
ORDER BY m.fecha DESC, m.id DESC
LIMIT $2
```

The month/year params are dead code. All mermas are returned regardless.

### I-NEW-08: Log file grows unbounded

**File:** `src/utils/logger.js:20`

```javascript
fs.appendFile(LOG_FILE, logEntry + '\n', (err) => {
```

No log rotation mechanism. The server.log file is already 499KB and will grow indefinitely. In production, this will eventually fill the disk.

**Fix:** Use a proper logging library (winston/pino) with rotation, or add a size check before writing.

### I-NEW-09: CORS origins list duplicated in 3 places

**Files:**
- `server.js:91-106` (DEFAULT_ORIGINS)
- `src/config/index.js:50-58` (config.cors.defaultOrigins)
- `src/middleware/cors.js:15-27` (DEFAULT_ORIGINS)

Three separate lists that can drift out of sync. Server.js has `localhost:5173` that the others don't.

**Fix:** Consolidate to a single source of truth (config/index.js) and import everywhere.

### I-NEW-10: Healthcheck port mismatch

**File:** `healthcheck.js:10`

```javascript
port: 3000,
```

But `.env` says `PORT=3001` and `src/config/index.js:43` defaults to 3000. The healthcheck should use the same PORT env var.

**Fix:**
```javascript
port: process.env.PORT || 3000,
```

### I-NEW-11: `menu-engineering` and `businessHelpers` use different price calculation

**Files:** `server.js:2283-2286` vs `src/utils/businessHelpers.js:16-19`

menu-engineering:
```javascript
const cantidadPorFormato = parseFloat(ing.cantidad_por_formato) || 1;  // defaults to 1
const precioUnitario = precioFormato / cantidadPorFormato;
```

businessHelpers:
```javascript
const cantidadPorFormato = parseFloat(ingrediente.cantidad_por_formato) || 0;
return cantidadPorFormato > 0 ? precio / cantidadPorFormato : precio;  // defaults to full price
```

When `cantidad_por_formato` is null/0:
- businessHelpers returns the full format price
- menu-engineering divides by 1 (same result, actually)

When `cantidad_por_formato` is explicitly 0:
- businessHelpers: `0 > 0` is false → returns full price
- menu-engineering: `parseFloat(0) || 1` = `0 || 1` = 1 → divides by 1

These behave the same for null but differ for edge cases. menu-engineering should use `buildIngredientPriceMap()` from businessHelpers.

### I-NEW-12: Multiple pool instances

**Files:**
- `server.js` creates its own Pool
- `src/config/database.js` creates another Pool
- `src/infrastructure/database/connection.js` creates yet another Pool

Three separate connection pools to the same database, wasting connections.

### I-NEW-13: `POST /api/ingredients` missing name validation

**File:** `server.js:1441-1458`

Unlike `POST /api/recipes` (which checks `!nombre || !nombre.trim()`), ingredients can be created with an empty name.

---

## 3. Nice-to-Have

### N-01: Inline price calculation in `menu-engineering`, `balance`, `daily-summary`

Multiple endpoints duplicate the pattern of loading all ingredients, building a price map, and calculating recipe costs. These could use `buildIngredientPriceMap()` from businessHelpers.

### N-02: `copiar-semana` uses `toISOString().split('T')[0]` for date formatting

**File:** `server.js:3544`

This date formatting pattern appears in many places. A shared utility function would reduce inconsistency.

### N-03: Error handler inconsistency

Some endpoints return `{ error: 'Error interno', data: [] }` while others return just `{ error: 'Error interno' }`. Should be consistent.

### N-04: Dead code — commented debug blocks in `GET /api/mermas`

**File:** `server.js:4927-4951`

Large commented-out debug block should be removed.

### N-05: `server.js` monolith at 5292 lines

The file is difficult to maintain. More endpoint groups could be extracted to controllers following the pattern of `SupplierController.js`.

### N-06: Multiple database connection configurations

`src/config/database.js` has max=20 connections with keepAlive, while `src/infrastructure/database/connection.js` has max=10 without keepAlive. Consolidate.

### N-07: `app.set('trust proxy', 1)` hardcoded

**File:** `server.js:115`

Should be configurable via environment variable for different deployment topologies.

---

## 4. Quality Review of Applied Fixes

### C1 (FOR UPDATE in inventory/consolidate): PARTIALLY CORRECT
- `bulk-update-stock` (L2132): correctly uses FOR UPDATE
- `consolidate` (L2162-2251): does NOT use FOR UPDATE for the `finalStock` loop (L2227). The fix was only applied to bulk-update-stock, not consolidate's stock update.

### C2 (Mermas in transaction): CORRECT
- `POST /api/mermas` (L4792): properly uses BEGIN/COMMIT/ROLLBACK with client.

### C3 (Math.max for porciones): CORRECT
- `POST /api/sales` (L2842): `Math.max(1, parseInt(receta.porciones) || 1)`
- `DELETE /api/sales` (L2905): Uses `parseInt(receta.porciones) || 1` but missing `Math.max`. If porciones is a negative number from DB corruption, this could cause negative stock deductions.

### C4 (Security headers): CORRECT
- All headers properly set in middleware (L161-170).

### C5 (Rate limit on parse-pdf): CORRECT
- `costlyApiLimiter` applied at L2964.

### C6 (Anthropic error sanitization): CORRECT
- Error from Claude API is not forwarded to client (L3029-3031).

### C7 (Input validation bulk-update-stock): CORRECT
- Validates array, checks each item (L2120-2130).

### C8 (requireAdmin on DELETE): CORRECT
- Applied to: ingredients (L1531), recipes (L2407), orders (L2596).

### C9 (LIKE wildcard escape): CORRECT
- Pattern properly escaped in `/api/ingredients/match`.

### C10 (businessHelpers extraction): CORRECT
- `calcularPrecioUnitario`, `upsertCompraDiaria`, `buildIngredientPriceMap` properly extracted.

**Summary:** 8/10 fixes are correct. C1 is incomplete (consolidate missing FOR UPDATE), C3 is incomplete (delete-sale missing Math.max).

---

## 5. Test Coverage Gaps

### 5.1 Setup Issues

**File:** `tests/setup.js`

- **Hardcoded fallback credentials** (L33-34): `test@test.com` / `test123` — if env vars aren't set, tests will fail silently with null token
- **Token caching across all tests** (L26): A single cached token means all test suites share the same auth state. If one test modifies the user, it affects all subsequent tests.
- **No admin user setup**: Tests use a single user for everything. There's no separate admin vs non-admin user for testing authorization boundaries.
- **No error handling if login fails** (L37-41): If login returns no token, `getAuthToken()` returns null and subsequent requests silently use `Bearer null`.

### 5.2 Missing Test Scenarios

Based on the 29 test files in `tests/critical/`:

| Missing Scenario | Priority |
|---|---|
| Multi-tenant IDOR with variant IDs (C-NEW-06) | Critical |
| Token validity after logout (C-NEW-03) | Critical |
| DELETE /api/sales without admin role | Critical |
| Merma delete restoring stock asymmetry (C-NEW-07) | Critical |
| Unbounded array inputs (DoS via large payloads) | Important |
| Concurrent stock updates (race condition proof) | Important |
| Registration without authLimiter abuse | Important |
| Password reset token reuse after use | Important |
| API token revocation | Important |
| `copiar-semana` partial failure rollback | Important |
| `GET /api/mermas` month/year filtering | Moderate |

### 5.3 Fragile Tests

- Integration tests that hit a live API are inherently order-dependent if they share state
- `sale-stock-deduction.test.js` creates sales that modify global stock — can affect `inventory-*.test.js` tests
- `--runInBand` mitigates but doesn't eliminate data coupling

---

## 6. Performance Post-Indexes

### 6.1 Index Coverage Assessment

The existing indexes (migrations 001-004) cover the main query patterns well:

| Query Pattern | Index | Status |
|---|---|---|
| `ventas WHERE restaurante_id AND fecha` | `idx_ventas_restaurante_fecha` | Covered |
| `ingredientes WHERE restaurante_id AND activo` | `idx_ingredientes_restaurante` | Covered |
| `recetas WHERE restaurante_id AND deleted_at IS NULL` | `idx_recetas_restaurante` | Covered |
| `mermas WHERE restaurante_id AND fecha` | `idx_mermas_fecha` | Covered |
| `compras_pendientes WHERE restaurante_id AND estado` | `idx_compras_pendientes_estado` | Covered |
| `precios_compra_diarios WHERE restaurante_id AND fecha` | `idx_precios_rest_fecha` | Covered |

### 6.2 Missing Indexes

| Query Pattern | Location | Suggested Index |
|---|---|---|
| `usuarios WHERE email` | `server.js:763` (login) | `CREATE UNIQUE INDEX idx_usuarios_email ON usuarios(email)` |
| `usuarios WHERE verification_token` | `server.js:1017` | `CREATE INDEX idx_usuarios_verification_token ON usuarios(verification_token) WHERE verification_token IS NOT NULL` |
| `inventory_snapshots_v2 (ingrediente_id, restaurante_id)` | `server.js:2187` | May need index if table grows |
| `recetas_variantes (receta_id)` | `server.js:2792` | `CREATE INDEX idx_recetas_variantes_receta_id ON recetas_variantes(receta_id)` |
| `ingredientes_alias (restaurante_id, alias)` | `server.js:3841` | `CREATE INDEX idx_ingredientes_alias_restaurante ON ingredientes_alias(restaurante_id)` |

### 6.3 N+1 Queries

| Endpoint | Issue | Fix |
|---|---|---|
| `POST /api/sales` (L2843-2864) | Loop: FOR UPDATE + UPDATE per ingredient | Batch with CTE or single UPDATE with CASE |
| `DELETE /api/sales/:id` (L2910-2930) | Loop: FOR UPDATE + UPDATE per ingredient | Same as above |
| `POST /api/orders` (L2504-2518) | Loop: upsertCompraDiaria per ingredient | Batch INSERT |
| `POST /api/mermas` (L4795-4824) | Loop: INSERT per merma | Batch INSERT with unnest |
| `approve-batch` (L4048-4086) | Loop: upsert + SELECT + UPDATE per item | Could batch |

### 6.4 Slow Queries

- `GET /api/balance/mes` (L3640): Uses `EXTRACT(MONTH/YEAR FROM fecha)` which can't use the `(restaurante_id, fecha)` index. Should use `fecha >= date_trunc('month', ...) AND fecha < date_trunc('month', ...) + interval '1 month'`.
- `GET /api/mermas` (L4953): No month filter at all despite having parameters for it.

---

## 7. Detailed Fix Proposals

### Priority Matrix

| ID | Severity | Description | File:Line |
|---|---|---|---|
| C-NEW-01 | CRITICAL | .env committed to git with secrets | `.env`, `.gitignore` |
| C-NEW-02 | CRITICAL | Weak JWT_SECRET | `.env:1` |
| C-NEW-03 | CRITICAL | Logout doesn't invalidate JWT | `server.js:838` |
| C-NEW-04 | CRITICAL | DELETE sales missing requireAdmin | `server.js:2878` |
| C-NEW-05 | CRITICAL | Bulk sales missing requireAdmin | `server.js:3082` |
| C-NEW-06 | CRITICAL | recetas_variantes IDOR (no restaurante_id) | `server.js:2791` |
| C-NEW-07 | CRITICAL | Merma stock asymmetry (create vs delete) | `server.js:4820,5032` |
| C-NEW-08 | CRITICAL | Dockerfile copies .env into image | `Dockerfile:9` |
| I-NEW-01 | IMPORTANT | Registration missing authLimiter | `server.js:897` |
| I-NEW-02 | IMPORTANT | DELETE empleados missing requireAdmin | `server.js:3404` |
| I-NEW-03 | IMPORTANT | normalizar() duplicated | `server.js:3820,4199` |
| I-NEW-04 | IMPORTANT | copiar-semana not in transaction | `server.js:3516` |
| I-NEW-05 | IMPORTANT | stock-real PUT missing FOR UPDATE | `server.js:2085` |
| I-NEW-06 | IMPORTANT | Unbounded array processing | Multiple |
| I-NEW-07 | IMPORTANT | GET /api/mermas ignores month filter | `server.js:4953` |
| I-NEW-08 | IMPORTANT | Log file grows unbounded | `src/utils/logger.js:20` |
| I-NEW-09 | IMPORTANT | CORS origins duplicated 3 places | Multiple |
| I-NEW-10 | IMPORTANT | Healthcheck port mismatch | `healthcheck.js:10` |
| I-NEW-11 | IMPORTANT | Price calculation inconsistency | Multiple |
| I-NEW-12 | IMPORTANT | Multiple pool instances | Multiple |
| I-NEW-13 | IMPORTANT | POST /api/ingredients missing name validation | `server.js:1441` |
| C1-FIX | IMPORTANT | consolidate missing FOR UPDATE | `server.js:2227` |
| C3-FIX | IMPORTANT | DELETE sales missing Math.max on porciones | `server.js:2905` |

### Quick Wins (can be fixed in < 5 lines each)

1. **C-NEW-04/05**: Add `requireAdmin` to 2 endpoints
2. **I-NEW-01**: Add `authLimiter` to register
3. **I-NEW-02**: Add `requireAdmin` to DELETE empleados
4. **I-NEW-10**: Change healthcheck port to use env var
5. **I-NEW-13**: Add nombre validation to POST ingredients
6. **C1-FIX**: Add FOR UPDATE to consolidate's stock loop
7. **C3-FIX**: Add Math.max to DELETE sales porciones

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL (new) | 8 |
| IMPORTANT (new) | 13 (+2 fix quality issues) |
| Nice-to-Have | 7 |
| **Total** | **30** |

The most urgent items are C-NEW-01 (secrets in git) and C-NEW-02 (weak JWT secret), as they enable complete authentication bypass. These should be addressed before any other changes.
