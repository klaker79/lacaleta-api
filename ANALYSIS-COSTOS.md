# MindLoop CostOS API - Analisis Completo y Plan de Mejoras

**Fecha:** 2026-02-11
**Version analizada:** Stabilization v1 (server.js ~5170 lineas)
**Tests:** 29 suites, 119 tests (todos verdes)
**Arquitectura:** Monolito Express + PostgreSQL, con modulos Clean Architecture parciales en `src/`

---

## 1. ANALISIS DEL BACKEND (server.js)

### 1.1 Codigo Duplicado

| Patron duplicado | Ocurrencias | Lineas afectadas |
|---|---|---|
| Calculo `precioUnitario = precio / cantidad_por_formato` | 6 veces | L2141-2146, L3028-3033, L3529-3532, L4271-4275, L4611-4614, L1939-1942 |
| Insercion en `precios_compra_diarios` con ON CONFLICT | 5 veces | L2370-2378, L2432-2440, L3846-3854, L3921-3930, L4155-4163 |
| Busqueda de ingredientes por nombre normalizado + alias | 3 veces | L3682-3747, L4065-4124, L1329-1413 |
| Actualizacion de stock con `FOR UPDATE` lock | 6 veces | L2542, L2716-2724, L3119-3127, L4170, L4912, L4964 |
| Logica de `cantidadADescontar = (ing.cantidad / porciones) * cantidad * factor` | 2 veces | L2720-2721, L3115-3116 |

**Impacto:** Cada cambio en la logica de precios o stock debe replicarse en 5-6 sitios. Alto riesgo de divergencia.

### 1.2 Funciones >100 lineas que deberian refactorizarse

| Endpoint | Lineas | Complejidad |
|---|---|---|
| `POST /api/sales/bulk` | L2944-3198 (254 lineas) | Mapeo recetas + variantes + stock + resumen diario |
| `DELETE /api/orders/:id` | L2458-2575 (117 lineas) | Rollback stock + compras diarias (legacy + nuevo) |
| `POST /api/orders` | L2328-2393 (65 lineas) | Crear pedido + registrar diario |
| `PUT /api/orders/:id` | L2396-2455 (60 lineas) | Actualizar pedido + registrar diario |
| `POST /api/sales` | L2624-2737 (113 lineas) | Venta individual + stock deduction |
| `GET /api/monthly/summary` | L4222-4382 (160 lineas) | Calculo completo de P&L mensual |
| `POST /api/purchases/pending` | L3667-3788 (121 lineas) | Cola de revision con matching |
| `POST /api/daily/purchases/bulk` | L4048-4188 (140 lineas) | Import compras legacy |
| Schema/migraciones en IIFE | L212-691 (479 lineas) | CREATE TABLE + ALTER TABLE inline |

### 1.3 Queries SQL sin sanitizar o peligrosas

**Estado: BUENO.** Todas las queries usan parametros `$1, $2...` con `pool.query(sql, [params])`. No se encontro concatenacion directa de strings en SQL.

Unico riesgo menor:
- `server.js:1396` - LIKE con `%${nombreLimpio}%`: el valor se pasa como parametro (`$2`), pero caracteres `%` y `_` dentro del input del usuario no se escapan. Un usuario podria inyectar wildcards para ampliar la busqueda (no es SQL injection, pero es data leakage potencial).

### 1.4 Endpoints sin validacion adecuada de inputs

| Endpoint | Problema | Linea |
|---|---|---|
| `PUT /api/recipes/:id` | No valida `nombre` (puede ser vacio/null), no valida `precio_venta` negativo | L2252-2264 |
| `POST /api/orders` | No valida que `ingredientes` tenga `cantidad > 0` para cada item | L2328-2350 |
| `PUT /api/orders/:id` | No valida estructura de `ingredientes` (acepta cualquier JSON) | L2396-2455 |
| `POST /api/sales` | No valida que `recetaId` sea un entero valido | L2624-2637 |
| `PUT /api/inventory/bulk-update-stock` | No valida que `stocks` sea un array ni que cada item tenga `id` y `stock_real` | L1989-2018 |
| `POST /api/inventory/consolidate` | No valida tipos de `adjustments`, `snapshots`, `finalStock` | L2022-2111 |
| `POST /api/horarios` | No valida formato de `hora_inicio`/`hora_fin` (acepta cualquier string) | L3307-3330 |
| `PUT /api/empleados/:id` | No valida `coste_hora` ni `horas_contrato` (puede ser negativo via COALESCE) | L3241-3262 |
| `PATCH /api/ingredients/:id/toggle-active` | No valida que `activo` sea boolean | L1539-1558 |

### 1.5 Race Conditions en operaciones de stock

**Mitigacion existente:** Se usa `SELECT ... FOR UPDATE` en las operaciones criticas (ventas, compras, mermas). Esto es correcto para prevenir lost updates dentro de una transaccion.

**Problemas remanentes:**

1. **`POST /api/inventory/consolidate` (L2022-2111):** Actualiza stock de multiples ingredientes en un loop SIN `FOR UPDATE`. Si otra transaccion concurrente modifica el mismo ingrediente, se pierde la actualizacion.

2. **`PUT /api/inventory/bulk-update-stock` (L1989-2018):** Mismo problema - loop de updates sin row-level locking.

3. **`PUT /api/inventory/:id/stock-real` (L1960-1986):** Actualiza `stock_real` sin transaccion explicita ni lock. Si dos usuarios actualizan simultaneamente, last-write-wins.

4. **`POST /api/mermas` (L4653-4716):** Inserta mermas en un loop con `pool.query()` (sin transaccion). Si falla a mitad, quedan mermas parciales sin rollback.

5. **Ventas individuales vs bulk:** `POST /api/sales` usa `FOR UPDATE` correctamente, pero `POST /api/sales/bulk` (L2944-3198) tambien lo hace dentro de la transaccion. El riesgo es deadlock si dos bulk imports concurrentes bloquean ingredientes en distinto orden.

### 1.6 Error handling - catch blocks silenciosos

**Estado: ACEPTABLE.** La mayoria de catch blocks loguean el error con `log('error', ...)` y devuelven 500. No hay catch blocks completamente silenciosos.

**Excepciones problematicas:**

1. **Migraciones (L251-686):** Cada migracion tiene `catch (e) { log('warn', ...); }` - esto es correcto para migraciones idempotentes (no deben fallar el startup).

2. **`POST /api/mermas` (L4668-4704):** Catch dentro del loop continua con las demas mermas. El error se loguea pero el caller no sabe que items fallaron.

3. **`process.on('SIGTERM')` (L184-188):** `try { await pool.end(); } catch (e) { /* ignore */ }` - aceptable para shutdown graceful.

### 1.7 Endpoints que deberian tener requireAdmin

| Endpoint | Actual | Deberia | Razon |
|---|---|---|---|
| `DELETE /api/ingredients/:id` | `authMiddleware` | `+ requireAdmin` | Eliminar ingredientes afecta recetas y stock |
| `POST /api/inventory/consolidate` | `authMiddleware` | `+ requireAdmin` | Reset de stock maestro es operacion critica |
| `POST /api/sales/bulk` | `authMiddleware` | `+ requireAdmin` | Import masivo puede crear cientos de ventas |
| `POST /api/daily/purchases/bulk` | `authMiddleware` | `+ requireAdmin` | Import masivo de compras modifica stock |
| `DELETE /api/sales/:id` | `authMiddleware` | `+ requireAdmin` | Borrar ventas restaura stock y afecta P&L |
| `DELETE /api/orders/:id` | `authMiddleware` | `+ requireAdmin` | Borrar pedidos revierte stock y compras diarias |
| `POST /api/parse-pdf` | `authMiddleware` | `+ requireAdmin` | Usa API key de Anthropic (coste por uso) |

---

## 2. ANALISIS DEL FRONTEND

**No aplica** - Este repositorio es backend-only. El frontend (`app-core.js`) esta en un repo separado (`mindloop-costos`).

---

## 3. REVISION DE TESTS

### 3.1 Gaps de cobertura

| Area | Tests existentes | Gaps criticos |
|---|---|---|
| **Auth** | Login, logout, admin-only, rate limiting | No hay tests de JWT manipulation, token expirado, refresh |
| **Multi-tenant** | Ingredientes y recetas filtran por restaurante | No testea ventas, pedidos, mermas, horarios, gastos fijos |
| **Stock** | Venta descuenta, borrado restaura | No testea concurrencia (2 ventas simultaneas), stock negativo, precision decimal |
| **Pedidos** | CRUD, delete preserva compras de otro pedido | No testea recepcion parcial, multiples ingredientes, cambio de estado |
| **Ventas bulk** | Import con mapping por codigo TPV | No testea variantes en bulk, duplicados, fecha invalida |
| **Mermas** | CRUD + stock restoration | No testea mermas concurrentes, ingredientes eliminados |
| **Consolidacion inventario** | Flujo basico | No testea datos invalidos, NaN, concurrencia |
| **Parse PDF** | Ninguno | Sin cobertura (requiere mock de Anthropic API) |
| **Compras pendientes** | Aprobacion basica | No testea matching de alias, edicion, rechazo |
| **Balance/P&L** | Resumen basico | No testea meses sin datos, calculos de food cost |
| **Intelligence** | Freshness, overstock, purchase-plan | No testea sin datos historicos, edge cases |

### 3.2 Tests fragiles

1. **Token caching global (`setup.js:23-41`):** Un solo token para toda la suite. Si expira mid-run, todos los tests fallan silenciosamente (retornan `null` sin throw).

2. **Dependencia de datos existentes:** Tests como `sale-stock-deduction` buscan `ingredientes[0]` - si la BD de test esta vacia, el test pasa sin ejecutar assertions.

3. **Orden de ejecucion:** `recipe-crud-food-cost.test.js` usa `createdRecipeId` del test 1 en tests 2-5. Si el test 1 falla, los demas pasan silenciosamente.

4. **Fechas hardcoded:** `delete-order-preserves-purchases.test.js` usa `new Date().toISOString().split('T')[0]`. Si se ejecuta a medianoche UTC, la fecha cambia entre tests.

5. **IDs inexistentes:** `multi-tenant-isolation.test.js` usa ID `999999` asumiendo que no existe. En produccion esto podria colisionar.

### 3.3 Edge cases criticos no testeados

1. **Precision decimal en stock:** Vender 0.333 kg * 3 = 0.999 vs 1.0 (floating point)
2. **Receta con 0 porciones:** Division por cero en `cantidadADescontar = ing.cantidad / porciones`
3. **Ingrediente en receta que ya no existe:** `ingredienteId` apunta a ingrediente soft-deleted
4. **Pedido con fecha futura:** No se valida que `fecha` sea pasada o presente
5. **SQL injection via LIKE wildcards:** `%` y `_` en nombres de ingredientes
6. **Concurrent inventory consolidation:** Dos consolidaciones simultaneas

### 3.4 setup.js - Robustez

**Problemas:**
- Credenciales hardcoded como fallback (`test@test.com` / `test123`)
- Sin retry en login (si el server no esta listo, falla silenciosamente)
- Sin cleanup de datos de test (acumulacion entre runs)
- Sin soporte para multiples usuarios/roles de test
- Sin health check previo al test run

---

## 4. SEGURIDAD

### 4.1 CORS

**Estado: BUENO** con observaciones.

- Origins hardcoded incluyen 10 puertos localhost (L90-104). No es un riesgo de seguridad pero es innecesariamente amplio.
- Duplicacion: CORS esta implementado inline en `server.js:117-151` Y en `src/middleware/cors.js`. Solo el de server.js se usa. El de `src/middleware/cors.js` esta sin usar.
- `Access-Control-Allow-Origin: *` se emite para health checks sin origin header. Correcto.

### 4.2 Headers de seguridad

**FALTANTES:**

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-XSS-Protection: 0
Content-Security-Policy: default-src 'none'
Referrer-Policy: strict-origin-when-cross-origin
```

El unico header de seguridad aplicado es CORS. No se usa `helmet` ni headers manuales de seguridad.

### 4.3 Rate Limiting

- **Global:** 1000 req/15min (L8-13 de `rateLimit.js`) - aplicado a todas las rutas
- **Auth:** 50 req/15min (L16-22) - aplicado a login, forgot-password, reset-password, resend-verification
- **Missing:** No hay rate limiting especifico para:
  - `POST /api/parse-pdf` (consume API de Anthropic = coste)
  - `POST /api/sales/bulk` (puede crear cientos de registros)
  - `POST /api/daily/purchases/bulk` (import masivo)

### 4.4 Datos sensibles en respuestas de error

**Estado: BUENO.** Las respuestas de error usan mensajes genericos (`"Error interno"`). Solo en development se expone `err.message` (L5117).

**Excepcion:** `POST /api/parse-pdf` (L2893) devuelve `details: errorData` de la API de Anthropic, que podria contener informacion interna.

### 4.5 Multi-tenant isolation

**Estado: BUENO con gaps.**

Todas las queries principales filtran por `restaurante_id = $1` donde `$1` viene de `req.restauranteId` (del JWT). No se encontro ningun endpoint que acepte `restaurante_id` del body/params del request (lo cual seria un bypass).

**Gaps:**
1. **`ingredientes_proveedores` (L1605):** El JOIN verifica ingrediente pero no verifica explicitamente que el proveedor pertenezca al restaurante en la query de listado. Sin embargo, la creacion si valida ambos (L1632-1647).
2. **`horarios` (L3336-3339):** `DELETE /api/horarios/:id` solo filtra por `id` y `restaurante_id`. Si el `id` del horario pertenece a otro restaurante, la query simplemente no borra nada (seguro por omision).

### 4.6 JWT

- **Expiracion:** 7 dias para tokens de sesion (L774). Aceptable pero largo.
- **API tokens:** Hasta 365 dias (L835-846). Riesgo alto si se compromete.
- **Refresh:** No hay mecanismo de refresh token. Si el token expira, el usuario debe re-login.
- **Revocacion:** No hay lista negra de tokens. Si un token se compromete, no se puede invalidar hasta que expire.
- **Secret:** `JWT_SECRET` desde env var, sin fallback hardcoded. Correcto.
- **Cookie:** httpOnly + secure (solo en prod) + sameSite lax. Correcto.

---

## 5. PERFORMANCE

### 5.1 Queries N+1

| Endpoint | Problema | Lineas |
|---|---|---|
| `POST /api/inventory/consolidate` | Loop de INSERTs para snapshots + ajustes + updates (3 queries por item) | L2034-2100 |
| `PUT /api/inventory/bulk-update-stock` | Loop de UPDATEs individuales (1 query por item) | L1996-2007 |
| `POST /api/mermas` | Loop de INSERTs individuales (1 query por merma) | L4667-4704 |
| `POST /api/sales/bulk` | Loop de INSERTs + UPDATEs por venta (3-5 queries por item) | L3039-3157 |
| `POST /api/purchases/pending/approve-batch` | Loop de INSERT + SELECT + UPDATE por item (4 queries por item) | L3912-3951 |
| `POST /api/daily/purchases/bulk` | Loop de SELECT dedup + INSERT + SELECT lock + UPDATE (4 queries por item) | L4097-4176 |
| `POST /api/horarios/copiar-semana` | Loop de INSERTs individuales | L3397-3408 |

**Solucion para los mas criticos:** Usar `unnest()` o `VALUES` para batch inserts, y CTEs para batch updates.

### 5.2 Endpoints que hacen demasiadas queries

| Endpoint | Queries | Lineas |
|---|---|---|
| `GET /api/balance/mes` | 5 queries secuenciales | L3502-3589 |
| `GET /api/monthly/summary` | 3 queries principales + procesamiento | L4222-4382 |
| `GET /api/system/health-check` | 6 queries secuenciales | L5003-5092 |
| `GET /api/analysis/menu-engineering` | 2 queries + procesamiento en memoria | L2115-2218 |

Para `balance/mes`, las 5 queries podrian reducirse a 1-2 con CTEs.

### 5.3 Indices faltantes

Los indices creados en `server.js` y en `migrations/001_add_performance_indexes.sql` son razonablemente completos. Indices faltantes:

| Tabla | Indice sugerido | Motivo |
|---|---|---|
| `ventas` | `(restaurante_id, receta_id, fecha) WHERE deleted_at IS NULL` | JOIN frecuente en menu-engineering y balance |
| `ingredientes_proveedores` | `(proveedor_id)` | Consultas de proveedores con sus ingredientes |
| `compras_pendientes` | `(restaurante_id, created_at) WHERE estado = 'pendiente'` | Listado de cola de revision |
| `ventas_diarias_resumen` | `(restaurante_id, fecha)` compuesto | Resumen mensual y P&L |
| `gastos_fijos` | `(restaurante_id) WHERE activo = true` | Listado filtrado |
| `api_tokens` | `(restaurante_id)` | Listado de tokens |

### 5.4 Operaciones sincronas que deberian ser async

1. **Logger `fs.appendFile` (logger.js:20):** Ya es async (callback). Correcto.
2. **Schema/migraciones en IIFE (L212-691):** Son `await` secuenciales al startup. Podrian paralelizarse agrupando ALTER TABLEs independientes, pero el impacto es solo en cold start (una vez).
3. **Heartbeat `https.get` (L5148-5155):** Correcto, no bloquea.

**No se encontraron operaciones sincronas bloqueantes** en los handlers de requests.

---

## 6. PLAN DE MEJORAS PRIORIZADO

### CRITICO - Bugs, seguridad, perdida de datos

| # | Mejora | Archivo:Linea | Impacto |
|---|---|---|---|
| C1 | **Anadir `FOR UPDATE` en inventory consolidate** | `server.js:2087` | Race condition puede causar perdida de stock |
| C2 | **Anadir `FOR UPDATE` en bulk-update-stock** | `server.js:1997` | Race condition en actualizacion masiva |
| C3 | **Envolver POST /api/mermas en transaccion** | `server.js:4653-4716` | Mermas parciales sin rollback |
| C4 | **Validar `porciones > 0` antes de dividir** | `server.js:2704,3112` | Division por cero si receta tiene 0 porciones |
| C5 | **Anadir headers de seguridad** (helmet o manual) | `server.js:~158` | Falta X-Content-Type-Options, HSTS, X-Frame-Options |
| C6 | **Rate limit en /api/parse-pdf** | `server.js:2826` | Endpoint consume API de pago sin limite |
| C7 | **No exponer detalles de error de Anthropic** | `server.js:2893` | Fuga de info interna en response |
| C8 | **Validar input en bulk-update-stock** | `server.js:1989-1992` | Acepta cualquier payload sin validar estructura |
| C9 | **Anadir requireAdmin a endpoints destructivos** | Varios (ver 1.7) | Cualquier usuario puede borrar pedidos/ventas/ingredientes |
| C10 | **Escapar wildcards LIKE en /api/ingredients/match** | `server.js:1396` | Wildcard injection en busqueda parcial |

### IMPORTANTE - Performance, UX, mantenibilidad

| # | Mejora | Archivo:Linea | Impacto |
|---|---|---|---|
| I1 | **Extraer `calcularPrecioUnitario(ingrediente)` a funcion compartida** | 6 ocurrencias | Elimina 6 duplicaciones de logica de precio |
| I2 | **Extraer `insertarCompraDiaria(client, params)` a funcion** | 5 ocurrencias | Elimina 5 duplicaciones de INSERT ON CONFLICT |
| I3 | **Extraer `buscarIngredientePorNombre(restauranteId, nombre)` a funcion** | 3 ocurrencias | Elimina 3 duplicaciones de matching con alias |
| I4 | **Usar batch INSERT para mermas** | `server.js:4667-4704` | N queries -> 1 query |
| I5 | **Usar batch INSERT para copiar-semana** | `server.js:3397-3408` | N queries -> 1 query |
| I6 | **Combinar queries de balance/mes con CTEs** | `server.js:3502-3589` | 5 queries -> 1-2 queries |
| I7 | **Mover schema/migraciones a archivo SQL separado** | `server.js:212-691` | 479 lineas menos en server.js |
| I8 | **Anadir indices compuestos faltantes** | `migrations/` | Mejorar queries de reporting |
| I9 | **Fix tests: throw en vez de return null en setup.js** | `tests/setup.js:41` | Tests silenciosos pasan sin ejecutar |
| I10 | **Anadir token refresh o reducir expiracion JWT** | `server.js:774` | 7 dias es largo; API tokens de 365 dias sin revocacion |
| I11 | **Validar PUT /api/recipes/:id** | `server.js:2252` | Nombre vacio, precio negativo, porciones=0 |
| I12 | **Anadir tests de multi-tenant para ventas, pedidos, mermas** | `tests/critical/` | Solo ingredientes y recetas testeados |
| I13 | **Eliminar CORS duplicado en src/middleware/cors.js** | `src/middleware/cors.js` | Codigo muerto, confunde |

### NICE-TO-HAVE - Refactoring, DX, consistencia

| # | Mejora | Archivo:Linea | Impacto |
|---|---|---|---|
| N1 | **Extraer endpoints a controllers** (como ya se hizo con SupplierController) | `server.js` completo | Reducir monolito de 5170 lineas |
| N2 | **Estandarizar nombres de campos** (camelCase vs snake_case) | Varios endpoints | `recetaId` vs `receta_id`, `stockActual` vs `stock_actual` |
| N3 | **Eliminar logs de debug en produccion** | `server.js:4788-4828` | Mermas tiene bloques DEBUG comentados |
| N4 | **Anadir test de parse-pdf con mock** | `tests/` | 0% cobertura actual |
| N5 | **Unificar soft delete** | Varios | Empleados usa `activo=false`, ingredientes usa `deleted_at`, gastos usa `activo=false` |
| N6 | **Eliminar `_dormant/` directory** | `_dormant/routes/` | 134K de codigo muerto |
| N7 | **Anadir Joi/Zod schema validation a endpoints** | Varios | Solo recetas v2 tiene validacion via `recipeSchema.js` |
| N8 | **Consolidar calculo de food cost** en un servicio | `CostCalculationService.js` ya existe | No se usa desde server.js |
| N9 | **Test fixtures con datos predefinidos** | `tests/` | Eliminar dependencia de datos de produccion |
| N10 | **Anadir JWT blacklist** (Redis o tabla) | `src/middleware/auth.js` | Permitir revocacion de tokens comprometidos |

---

## 7. RESUMEN EJECUTIVO

### Fortalezas
- SQL parametrizado en todas las queries (sin SQL injection)
- `SELECT FOR UPDATE` en operaciones criticas de stock (ventas, borrado pedidos)
- CORS correctamente configurado con whitelist
- Soft delete implementado consistentemente
- Error logging con Sentry integration
- Rate limiting global y en auth
- JWT en httpOnly cookies con sameSite
- Tests de multi-tenant isolation (parciales)
- Transaction rollback en operaciones complejas

### Debilidades principales
1. **Monolito de 5170 lineas** con alta duplicacion de logica (precio unitario, insert compras, matching ingredientes)
2. **Race conditions** en inventory consolidate, bulk stock update, y POST mermas (sin FOR UPDATE ni transaccion)
3. **Falta de headers de seguridad** (no helmet, no HSTS, no X-Frame-Options)
4. **Validacion de inputs incompleta** en ~9 endpoints (PUT recipes, bulk updates, horarios)
5. **Tests fragiles** con token caching global, silent failures, y sin tests de concurrencia
6. **Sin mecanismo de JWT revocacion** ni refresh tokens
7. **N+1 queries** en 7 endpoints de operaciones masivas

### Metricas
- **10 mejoras criticas** (seguridad y integridad de datos)
- **13 mejoras importantes** (performance y mantenibilidad)
- **10 mejoras nice-to-have** (refactoring y DX)
