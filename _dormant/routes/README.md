# ⚠️ Código Dormant (No se usa en producción)

Estos archivos fueron parte del plan de modularización pero **NUNCA se cargaron en producción**.

**Producción usa `server.js`** (monolito), no estos archivos.

`server.js` NO importa `src/routes/index.js`, por lo tanto ninguna de estas rutas se ejecuta.

Si en el futuro se migra a `server.modular.js`, estos archivos pueden reactivarse.

Fecha: 2026-02-08
