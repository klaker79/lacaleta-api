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
