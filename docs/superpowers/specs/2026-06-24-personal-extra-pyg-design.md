# Personal extra por horas → PyG (Diseño)

**Fecha:** 2026-06-24
**Repos:** `lacaleta-api` (backend) + `MindLoop-CostOS` (frontend). App en PRODUCCIÓN (La Nave 5) — no romper nada; se prueba en staging antes de main.

## Objetivo
Registrar el dinero que se paga a **extras por horas** (personal eventual) y que ese gasto **cuente en el PyG** (baja el beneficio del periodo), como un coste operativo con fecha — al estilo de "comida de personal", pero con su propia tabla porque comida_personal se deriva de las compras, no es una libreta.

## Decisiones (cerradas en brainstorming)
- Registro por apunte: **fecha + horas + €/hora (+ nombre opcional)**; `total = horas × €/hora` calculado y guardado.
- **Cuenta en el PyG**: se resta del beneficio neto del periodo, **sin prorratear** (coste real con fecha).
- UI: **junto a los gastos fijos**, en el módulo `balance` del frontend (no nueva pestaña).

## 1. Modelo de datos (Postgres, backend)
Tabla nueva `personal_extra`:
```sql
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
```
- Migración idempotente en `src/db/init.js` (mismo patrón que `gastos_fijos`).
- `total` lo calcula el backend al INSERT/UPDATE (`horas * precio_hora`, redondeo a 2 decimales) — el cliente no lo envía como fuente de verdad.

## 2. Backend — rutas (`src/routes/personal-extra.routes.js`)
CRUD calcado de `gastos.routes.js` (mismo estilo, validaciones, auditoría, **siempre `restaurante_id`**):
- `GET /api/personal-extra?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` → lista del rango (si no hay rango, mes en curso). Filtra por `restaurante_id`.
- `POST /api/personal-extra` `{ fecha, nombre?, horas, precio_hora, observaciones? }` → valida, calcula `total`, inserta con `restaurante_id`.
- `PUT /api/personal-extra/:id` → recalcula `total`; `WHERE id=? AND restaurante_id=?`.
- `DELETE /api/personal-extra/:id` → `WHERE id=? AND restaurante_id=?`.
Montar el router en el bootstrap igual que el resto. Validar números con el validador existente (`validatePrecio`/equivalente).

## 3. Integración en el PyG (lo crítico — que cuadre en TODOS los puntos)
Beneficio nuevo = `ingresos − cogs_periodo − gastos_fijos_periodo − comida_personal − personal_extra_periodo`.
`personal_extra_periodo = SUM(total) FROM personal_extra WHERE restaurante_id=? AND fecha BETWEEN desde AND hasta` (**sin prorratear**).

Puntos donde el beneficio se calcula y hay que añadir la línea (el plan rastreará que no quede ninguno):
1. **`src/services/chatService.js` → tool `resumen_pyg`**: añadir `personal_extra_periodo` a la query/objeto y restarlo en `margen_neto`. Actualizar la **descripción y la `nota`** de la tool para que el chat explique el concepto (igual que hace con comida_personal).
2. **`src/services/informeMensualService.js`** (+ `informeMensualHtml.js`): incluir la línea "Personal extra" en el informe mensual y en el beneficio.
3. **Frontend módulo `balance`**: si la pantalla muestra beneficio calculado, restar también el personal extra (front y back idénticos). Si el balance solo lee del backend, no recalcular en cliente.

Regla de oro: si dos módulos dan beneficios distintos = bug. El plan verifica los 3.

## 4. Frontend (`MindLoop-CostOS`, módulo `balance`)
Bajo la lista de **gastos fijos**, una sección **"Personal extra (por horas)"**:
- Form: fecha (default hoy) · nombre (opcional) · horas · €/hora → muestra **total** en vivo.
- Tabla del periodo: fecha · nombre · horas · €/h · total · borrar. **Subtotal** del periodo.
- Cliente API en `src/api/client.js` (4 métodos). Sanitizar/`escapeHTML` el `nombre` en el render (anti-XSS, regla del repo).
- Null-guards en accesos al DOM (regla DOM Safety). Cache-bust + bump SW si cambia JS cacheado.

## 5. Tests
**Backend (Jest):**
- CRUD: POST calcula `total = horas×precio_hora` (incl. decimales 4.5×12.50=56.25); GET filtra por rango de fechas; **aislamiento multi-tenant** (restaurante A no ve los de B); PUT recalcula total; DELETE scoped.
- PyG: con apuntes sembrados, `resumen_pyg` baja `margen_neto` exactamente el `personal_extra_periodo`; un apunte fuera del rango NO afecta; invariante `personal_extra_periodo == SUM(apuntes del rango)`.
- Regresión: tests existentes de PyG (gastos fijos prorrateados, comida personal) siguen verdes.

**Frontend (Jest/jsdom):** el subtotal del periodo = suma de filas; render escapa el nombre.

## 6. Despliegue (staging primero)
- Backend: branch desde `develop`; al desplegar a staging, la migración de `init.js` crea la tabla en la BD de staging (`mindloop_staging`).
- Frontend: branch desde `develop`.
- Probar en `staging.mindloop.cloud` (tenant Demo Trattoria): apuntar un extra → verlo en la lista → comprobar que el beneficio del periodo baja ese importe (vía chat `resumen_pyg` o el balance).
- Solo tras validar en staging y con tu visto bueno → PR a `main` (NO sin pedirlo).

## Fuera de alcance
- Vincular extras a empleados/turnos del módulo Horarios (sería la opción 3, descartada por ahora).
- Prorrateo (no aplica: es coste real con fecha).
- Informes/export específicos más allá de la línea en el PyG y el informe mensual.
