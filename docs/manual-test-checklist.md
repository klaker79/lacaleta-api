# Checklist de tests manuales — staging

Batería de pruebas validada el 2026-05-02 contra `staging.mindloop.cloud` (Demo Trattoria KL).
Detectó 3 bugs (Smart Order proveedor, frontend sobrescribiendo precio, DELETE no recalcula).

Ejecutar antes de releases sensibles que toquen pedidos / inventario / precios.
El test crítico `tests/critical/order-recalcula-precio-ponderado.test.js` cubre A, B, E
automáticamente — esta checklist es para los flujos de UI que no automatizamos.

## Tests

### A — Compra simple
1. Crear ingrediente kg, cpf=1.
2. Pedido recibido: 5 kg.
3. **Esperado**: stock = 5.

### B — Receta + venta
1. Receta con ingrediente del A (0,2 kg, porciones=1, precio venta 10€).
2. Vender 1 unidad.
3. **Esperado**: stock baja 0,2; food cost 20%.

### C — Formato CAJA (×N)
1. Crear ingrediente con `formato_compra=CAJA`, `cantidad_por_formato=6`.
2. Pedido recibido: 1 caja.
3. **Esperado**: stock = 6 (no 1, no 36).

### D — Smart Order
1. Llevar stock de un ingrediente a 0 con `stock_minimo > 0`.
2. Pedidos → Smart Order → Crear Pedidos.
3. **Esperado**: pedido creado con proveedor correcto (no "Sin proveedor").

### E — Stock 0 (no negativo)
1. Llevar stock a 0.
2. Vender más unidades de las que hay.
3. **Esperado**: stock se queda en 0, NO -X.

### F — Edición de pedido
1. Pedido recibido con 5 kg → editar a 8 kg.
2. **Esperado**: stock = 8 (no 13, no 16).

### G — Mermas mayores que stock
1. Stock 5 → merma de 15.
2. **Esperado**: stock = 0.

### H — Media ponderada
1. Compra 1 kg @ 10€ + 9 kg @ 20€.
2. **Esperado** precio ingrediente: pmc = (10+180)/10 = **19€/kg**.
3. Comprobar tarjeta inventario, KPI dashboard, modal "Evolución del Precio".

### I — Eliminar pedido recibido (bug 2026-05-02)
1. Tras varias compras (pmc = X), eliminar el último pedido (pmc esperada sin él = Y).
2. **Esperado**: tras DELETE, `ingredientes.precio` = Y (NO sigue en X).
3. Si ves X después de borrar → bug recalcular en DELETE ha vuelto.

### J — Subrecetas
1. Receta base "Salsa" (4 porciones, 3,35€ total → 0,84€/porción).
2. Receta principal usa "Salsa" como ingrediente.
3. **Esperado**: el coste de la subreceta se incluye en el coste total.

### K — Variantes (botella/copa)
1. Receta vino con variantes BOTELLA factor=1, COPA factor=0,2.
2. Vender 1 botella → stock −1; vender 5 copas → stock −1.
3. **Esperado**: factor aplica correctamente al descuento.

### L — Inventario físico
1. Stock virtual = X. Introducir stock real = X-1.
2. Guardar.
3. **Esperado**: stock_actual ajusta a X-1, precio mantiene pmc.

### M — KPI vs inventario
1. Comparar `Valor Stock` del dashboard con suma de "Valor" en pestaña Inventario.
2. **Esperado**: coinciden.

### N — Chat IA
1. Preguntar "¿Cuál es mi food cost del mes?"
2. **Esperado**: número coherente con dashboard (≤2pp diferencia).

## Bugs históricos detectados aquí

| Fecha | Bug | Fix |
|---|---|---|
| 2026-04-22 | Stock multiplicado por Smart Order + batch | (anterior, ya cubierto) |
| 2026-05-02 | Smart Order envía `proveedor_id` en lugar de `proveedorId` → pedidos sin proveedor | PR #176 frontend |
| 2026-05-02 | Frontend sobrescribe precio del ingrediente al recibir pedido (cálculo aproximado) | PR `fix/no-overwrite-precio-from-frontend` |
| 2026-05-02 | DELETE /orders no recalcula precio_medio_compra tras borrar diarios | PR `fix/recalc-precio-on-delete-order` |
