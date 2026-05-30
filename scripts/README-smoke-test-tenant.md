# Smoke-test de coherencia de un tenant

Verifica que la cuenta de un restaurante quedó **consistente** tras un alta
nueva, un import masivo, o como auditoría periódica.

## Cuándo usarlo

- Tras crear un tenant nuevo (Stripe / Polar / SQL seed).
- Tras un import masivo (Excel) de ingredientes y/o recetas.
- Como check rutinario antes de pasar la cuenta a un cliente real.

## Qué comprueba

| Check | Por qué |
|---|---|
| `INGREDIENTES_HUERFANOS_PIVOT` | Ingredientes con `proveedor_id` directo pero sin fila en `ingredientes_proveedores`. El desplegable de pedidos los ignora. (Bug Iker 2026-05-31, CALABACIN) |
| `STOCK_POSIBLE_DOBLE_MULTIPLICACION` | `stock_actual` > 1000 con `cantidad_por_formato` > 1. Síntoma de bug 22-abril. |
| `STOCK_NEGATIVO` | Nunca debería; los UPDATEs llevan `GREATEST(0, …)`. |
| `INGREDIENTES_NOMBRE_DUPLICADO` | Duplicados (case-insensitive, trim) fragmentan stock/precios y rompen el matching del import de escandallo. |
| `RECETAS_CON_INGS_INVALIDOS` | Líneas de receta cuyo `ingredienteId` no existe / está borrado. |
| `RECETAS_SIN_ESCANDALLO` | Recetas (no-base, no-bebida) sin líneas. |
| `INGREDIENTES_CPF_DISTINTO_DE_1` | Regla cuentas nuevas: `cantidad_por_formato = 1`. |
| `INGREDIENTE_CON_2+_PROVEEDORES_PRINCIPALES` | Bug del 28-may: añadir 2º proveedor no desmarca el principal anterior → totales inflados. |

## Cómo correrlo

### Staging

```bash
docker exec $(docker ps -q -f name=mindloopstagingdb) \
  psql -U mindloop_staging_admin -d mindloop_staging \
  -v rest_id=1 -f scripts/smoke-test-tenant.sql
```

### Producción

```bash
# SSH al VPS primero:  ssh root@72.61.103.248
docker exec $(docker ps -q -f name=anais-postgres) \
  psql -U <user> -d <db> \
  -v rest_id=3 -f scripts/smoke-test-tenant.sql
```

(Sustituye `rest_id=3` por el id del tenant a comprobar.)

## Lectura del resultado

- Todas las filas con `items_problematicos = 0` → ✅ cuenta limpia, lista
  para venderse.
- Filas con `items_problematicos > 0` → revisar el campo `detalle`
  (lista hasta 10 ítems con id, nombre y contexto) antes de entregar la
  cuenta al cliente.

El script es de **solo lectura** (SELECTs). Seguro contra cualquier
tenant en cualquier entorno.
