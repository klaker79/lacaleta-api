# MindLoop CostOS - Scripts de Seguridad y Testing

## 📁 Estructura

```
lacaleta-api/
├── scripts/
│   ├── validate-data-integrity.js  # Valida integridad de datos
│   └── daily-health-check.js       # Check diario del sistema
├── tests/
│   └── test-stock-calculation.js   # Tests de cálculo de stock
└── backups/
    └── 2026-01-25/                 # Backups fechados
        ├── server.js.backup
        └── package.json.backup
```

## 🚀 Uso en Producción

### 1. Health Check Diario
Ejecutar antes de empezar el día o antes de importar ventas:
```bash
node scripts/daily-health-check.js
```

**Qué verifica:**
- ✅ Conexión a base de datos
- ✅ Tablas críticas accesibles
- ✅ Valor de stock calculado
- ✅ Alertas de stock bajo/negativo
- ✅ Recetas sin ingredientes
- ✅ Ventas del día

### 2. Validación de Integridad
Ejecutar si sospechas problemas en los datos:
```bash
node scripts/validate-data-integrity.js
```

**Qué verifica:**
- ✅ Recetas sin ingredientes vinculados
- ✅ Stock negativo
- ✅ Variantes sin factor
- ✅ Referencias a ingredientes inexistentes
- ✅ Vinos sin ingrediente
- ✅ Coherencia de KPIs

### 3. Tests de Cálculo de Stock
Ejecutar si hay dudas sobre el cálculo de stock:
```bash
node tests/test-stock-calculation.js
```

**Qué verifica:**
- ✅ Factores de variantes (copa=0.2, botella=1.0)
- ✅ Porciones en recetas
- ✅ Fórmula de descuento correcta
- ✅ Consistencia de stock

## 📋 Recomendaciones

1. **Antes de importar ventas:** Ejecutar `daily-health-check.js`
2. **Después de cambios en recetas:** Ejecutar `validate-data-integrity.js`
3. **Si hay problemas de stock:** Ejecutar `test-stock-calculation.js`
4. **Hacer backup en Hostinger:** Antes de cambios importantes

## ⚠️ Importante

Estos scripts son de **SOLO LECTURA**. No modifican ningún dato en la base de datos.
Son seguros de ejecutar en cualquier momento.
