# Re-Análisis MindLoop CostOS — Post-Fix Verification
**Fecha:** 2026-02-11
**Commit base:** `3733b3c fix: add mermas deleted_at migration, XSS protection...`
**Scope:** Backend (`lacaleta-api/server.js` ~5100 líneas), tests, integración n8n
**Frontend:** Repo `mindloop-costos` no disponible en este entorno (no clonado)

---

## PARTE 1: VERIFICACIÓN DE FIXES APLICADOS

**Resultado: 11 de 11 fixes verificados correctamente.**

| Fix | Estado | Evidencia |
|-----|--------|-----------|
| **SEC-01** JWT sin fallback | ✅ VERIFICADO | `auth.js:9-12` — `const JWT_SECRET = process.env.JWT_SECRET;` + `if (!JWT_SECRET) throw` |
| **SEC-02** /debug-sentry eliminado | ✅ VERIFICADO | `server.js:722` — Comentario `[SEC-02]`, endpoint eliminado |
| **SEC-03** sendDefaultPii: false | ✅ VERIFICADO | `instrument.js:8` — `sendDefaultPii: false` |
| **SEC-04** mermas tenant filter | ✅ VERIFICADO | `server.js:4791` — `WHERE m.restaurante_id = $1 AND m.deleted_at IS NULL` |
| **SEC-05** XSS escapeHtml | ✅ VERIFICADO | `server.js:1025-1030` — `escapeHtml()` función + `safeTitle`/`safeMessage` en líneas 1036-1037 |
| **BUG-05** mermas reset soft delete | ✅ VERIFICADO | `server.js:4891-4937` — `BEGIN/COMMIT`, stock restore loop, `UPDATE SET deleted_at`, usa `client` |
| **PERF** 7 índices compuestos | ✅ VERIFICADO | `server.js:506-511` — mermas(2), ingredientes(1), ventas(1), pedidos(1), recetas(1) |
| **Migración** deleted_at en mermas | ✅ VERIFICADO | `server.js:534` — `ALTER TABLE mermas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP` |
| **Rate limiter** cleanup | ✅ VERIFICADO | `server.js:695` — Comentario `[CLEANUP]`, 46 líneas eliminadas |
| **Uptime Kuma** env var | ✅ VERIFICADO | `server.js:5083` — `process.env.UPTIME_KUMA_PUSH_URL` |
| **bcrypt** eliminado | ✅ VERIFICADO | `package.json:19` — Solo `bcryptjs`, sin `bcrypt` nativo |

### Bug encontrado en fix parcial

| Severidad | ID | Archivo:línea | Descripción |
|---|---|---|---|
| 🟡 Medio | FIX-GAP-01 | `server.js:4815-4816` | **GET /api/mermas/resumen NO filtra por `deleted_at IS NULL`**. El GET principal de mermas (línea 4791) SÍ filtra, y el DELETE/reset (línea 4903) SÍ filtra, pero el resumen mensual incluye mermas soft-deleted en los totales. |
| 🟡 Medio | FIX-GAP-02 | `server.js:4676,4688,4699` | **GET /api/intelligence/waste-stats NO filtra por `deleted_at IS NULL`** en 3 queries (mes actual, top productos, mes anterior). Analytics de mermas incluyen datos borrados. |

---

## PARTE 2: ISSUES PENDIENTES — Siguen presentes

| Severidad | ID | Categoría | Archivo:línea | Descripción |
|---|---|---|---|---|
| 🔴 Crítico | NEW-02 | Race condition | `server.js:3779` | **SELECT sin FOR UPDATE en approve**: `SELECT * FROM compras_pendientes WHERE id=$1 AND estado='pendiente'` — dos requests simultáneos leen 'pendiente', ambos aprueban, stock se duplica. Mismo en batch approve (línea 3853). |
| 🔴 Crítico | NEW-04 | Tenant isolation | `server.js:3824,3899` | **UPDATE compras_pendientes sin restaurante_id**: `SET estado='aprobado' WHERE id=$1` — no filtra por tenant. El SELECT previo sí verifica, pero un race condition o manipulación podría aprobar compra de otro restaurante. |
| 🟠 Alto | NEW-03 | Validación | `server.js:3701-3702` | **Negativos aceptados en POST compras pendientes**: `parseFloat(compra.precio) \|\| 0` acepta valores negativos del OCR/n8n. Mismo en PUT (línea 3952). No usa `validatePrecio()`/`validateCantidad()` que existen en el codebase. |
| 🟠 Alto | NEW-05 | Authz | `server.js:3841` | **approve-batch sin requireAdmin**: Solo usa `authMiddleware`. Cualquier usuario con token (incluido rol 'api') puede aprobar batch completo. |
| 🟠 Alto | BUG-03 | Datos | `server.js:3061` | **Bulk sales INSERT sin variante_id**: `INSERT INTO ventas (...factor_variante) VALUES (...)` — no incluye `variante_id`. El INSERT individual (línea 2665) SÍ lo tiene. Ventas importadas pierden trazabilidad de variante. |
| 🟠 Alto | BUG-04 | Datos | `server.js:2740` | **DELETE sale: ingredienteId no normalizado**: `if (ing.ingredienteId && ing.cantidad)` — solo busca camelCase. El POST (línea 2673) usa fallback `ing.ingredienteId \|\| ing.ingrediente_id \|\| ing.ingredientId \|\| ing.id`. Stock no se restaura si receta usa snake_case. |
| 🟠 Alto | BUG-06 | Analytics | `server.js:3479,3484` | **balance/mes sin cantidad_por_formato**: `preciosMap.set(i.id, parseFloat(i.precio))` no divide por `cantidad_por_formato`. Menu engineering (línea 2121) y monthly/summary SÍ dividen. Costos de balance inflados. |
| 🟡 Medio | DATA-03 | Datos | `server.js:2758-2766` | **DELETE sale no actualiza ventas_diarias_resumen**: Soft delete de venta sin restar del resumen diario. Dashboard diverge de realidad con cada borrado. |

---

## PARTE 3: ISSUES NUEVOS DETECTADOS (no reportados previamente)

| Severidad | ID | Categoría | Archivo:línea | Descripción |
|---|---|---|---|---|
| 🟠 Alto | NEW-06 | Datos | `server.js:3814` | **Approve no verifica existencia de ingrediente**: Si ingrediente fue eliminado, `ingResult.rows[0]` es undefined → `cantidad_por_formato` cae a `NaN \|\| 0` → stock se actualiza con 0. Compra marcada aprobada sin efecto real. |
| 🟠 Alto | NEW-07 | Integridad | `server.js:3870` | **Cálculo financiero con floats en approve**: `const total = item.precio * item.cantidad` — JS float arithmetic causa errores acumulativos en reportes. También en líneas 2635, 4089. |
| 🟡 Medio | NEW-08 | Consistencia | `server.js:706,731,5075` | **Versión hardcodeada como '2.3.0' en 3 sitios**: `package.json` dice '2.3.1', `instrument.js` dice '2.3.1'. Endpoints health y root reportan versión incorrecta. |
| 🟡 Medio | NEW-09 | Paginación | `server.js:1300,2207,3158,3237,3374` | **Endpoints LIST sin LIMIT**: GET /api/ingredients, /api/recipes, /api/empleados, /api/horarios, /api/gastos-fijos devuelven TODOS los registros. Posible OOM con miles de registros. |
| 🟡 Medio | NEW-10 | Info leak | `server.js:4664` | **Error message expone detalles**: `res.status(500).json({ error: 'Error interno: ' + err.message })` en POST /api/mermas. Otros endpoints devuelven genérico (correcto). |
| ⚪ Bajo | NEW-11 | Auth | `server.js:1128,2902` | **Password mínimo 6 caracteres**: NIST recomienda 8+. Sin requisitos de complejidad. |
| ⚪ Bajo | NEW-12 | Migración | `server.js:520 vs 594` | **Columna `rendimiento` definida con tipos distintos**: Línea 520: `NUMERIC(5,2)`, línea 594: `INTEGER`. Primera migración gana por `IF NOT EXISTS`. Si fue INTEGER, rendimientos decimales se truncan. |

---

## PARTE 4: ANÁLISIS FRONTEND

**⚠️ No disponible**: El repositorio `mindloop-costos` no está clonado en `/home/user/`. Solo existe `lacaleta-api`. El análisis de frontend requiere acceso al código fuente.

---

## PARTE 5: EVALUACIÓN DE TESTS

### Cobertura actual: 12 archivos, ~70 test cases

| Categoría | Tests | Cobertura |
|-----------|-------|-----------|
| Stock: venta crea/borra → stock sube/baja | 3 cases | ✅ Básica |
| Pedido recibido → precios_compra_diarios | 3 cases | ✅ Buena |
| Delete pedido A no borra compras de B | 4 cases | ✅ Excelente regresión |
| Cost calculations (domain) | 7 cases | ✅ Buena |
| EventBus pub/sub | 12 cases | ✅ Completa |
| Services (mocked) | 10 cases | ⚠️ Solo unitario, no live |
| Integration (endpoints) | 12 cases | ⚠️ Básica, read-only |
| E2E costs | 4 cases | ⚠️ Limitada |

### Tests críticos que FALTAN

| Prioridad | Test faltante | Por qué importa |
|-----------|--------------|-----------------|
| 🔴 P0 | **Multi-tenant isolation** | 0 tests verifican que restaurant A no ve datos de B. GET /api/mermas antes del fix devolvía TODO. |
| 🔴 P0 | **Auth bypass completo** | Solo 1 test de 401 (costFlow). No hay tests para: token expirado, token de otro restaurant, rol insuficiente (403). |
| 🔴 P0 | **Mermas CRUD + stock** | POST mermas, DELETE mermas (soft delete + stock restore), DELETE mermas/reset — 0 tests. |
| 🔴 P0 | **Race conditions** | 0 tests con `Promise.all()` para simular concurrencia. Stock corruption posible. |
| 🟠 P1 | **Compras pendientes approve** | Flow completo POST → PUT → approve → stock update — 0 tests end-to-end. |
| 🟠 P1 | **Bulk sales import** | POST /api/sales/bulk con datos corruptos, negativos, duplicados — 0 tests. |
| 🟠 P1 | **ventas_diarias_resumen sync** | Crear venta → resumen sube, borrar venta → resumen NO baja. 0 tests. |
| 🟡 P2 | **Input validation negativos** | ¿Qué pasa con cantidad: -5 en POST /api/sales? 0 tests de validación de API. |

### Problemas de calidad en tests existentes

1. `sale-stock-deduction.test.js:53` — Si no hay receta con ingredientes, test se salta silenciosamente (`if (!testRecipeId) return`)
2. `sale-stock-deduction.test.js:87` — `expect([200, 201]).toContain(status)` — assertion débil, debería ser exacta
3. Ningún test usa `Promise.all()` para concurrencia
4. `tests/critical/` no se ejecuta con `npm run test:integration`

---

## RESUMEN EJECUTIVO

| Categoría | Conteo |
|-----------|--------|
| Fixes verificados correctamente | **11/11** ✅ |
| Gaps en fixes aplicados | **2** (mermas/resumen y waste-stats sin `deleted_at IS NULL`) |
| Issues pendientes confirmados | **8** (2 críticos, 4 altos, 1 medio, 1 medio) |
| Issues nuevos descubiertos | **7** (2 altos, 3 medios, 2 bajos) |
| Tests críticos faltantes | **8** categorías |
| Frontend analizado | No (repo no disponible) |

### Top 5 acciones inmediatas

1. **NEW-02 + NEW-04**: Añadir `FOR UPDATE` al SELECT de approve + `AND restaurante_id = $X` al UPDATE → evita doble aprobación y cross-tenant
2. **NEW-03**: Validar `precio >= 0 && cantidad > 0` en POST/PUT compras pendientes → evita datos corruptos de n8n OCR
3. **BUG-04**: Normalizar `ingredienteId` en DELETE /api/sales/:id → `const ingId = ing.ingredienteId || ing.ingrediente_id || ing.id`
4. **BUG-06**: Añadir `cantidad_por_formato` a la query de balance/mes → costos correctos
5. **FIX-GAP-01+02**: Añadir `AND deleted_at IS NULL` a mermas/resumen y waste-stats → analytics correctos
