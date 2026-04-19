/**
 * Chat Service — Claude API backend for MindLoop CostOS chatbot
 *
 * Replaces the n8n webhook flow. Uses Anthropic SDK with:
 * - Multi-tenant (restauranteId from JWT, NOT hardcoded)
 * - Prompt caching on system prompt (~90% cost reduction on reused prompts)
 * - Tool use: 9 DB query tools + calculator (handled natively by model)
 * - Agent loop with safety cap (max 10 iterations)
 *
 * Contract preserved: response is plain text. If model wants to execute an
 * action (update price, register sale, etc.), it writes `[ACTION:...]` in
 * the text and frontend parses it, same as the n8n flow did.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const { log } = require('../utils/logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
const MAX_AGENT_ITERATIONS = 10;

if (!ANTHROPIC_API_KEY) {
    log('warn', 'Chat: ANTHROPIC_API_KEY not set — chat endpoint will fail');
}

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ============================================================================
// SYSTEM PROMPT (static portion, cacheable)
// ============================================================================
// Copied verbatim from the n8n flow, with these surgical edits:
// - Removed tools the model was told to use but did not exist in the flow
//   (ingredientes_multiples_proveedores, detectar_perdidas, etc.)
// - Removed the "restaurante_id = 3 hardcoded" assumption — the backend
//   injects the correct restauranteId per request from the JWT.

const SYSTEM_PROMPT_STATIC = `🧑🍳 CHEF COSTOS - Asistente Ejecutivo de Restauración

Soy tu Chef Ejecutivo y CFO virtual. Gestiono costes, recetas, inventario y operaciones.

═══════════════════════════════════════════════════════════
🧠 REGLAS DE CONTEXTO CONVERSACIONAL
═══════════════════════════════════════════════════════════
1. Si el usuario dice "estos", "esos", "los anteriores":
   → Usar datos de MI RESPUESTA ANTERIOR
2. Si ya mostré precios/costes y preguntan "precio ideal":
   → Responder directamente, NO pedir más info
3. NUNCA responder "¿Podrías especificar...?" si ya tengo los datos
4. Los VINOS son RECETAS, no ingredientes

═══════════════════════════════════════════════════════════
🔧 HERRAMIENTAS (usar SIEMPRE antes de responder)
═══════════════════════════════════════════════════════════
LISTAS / DETALLE (para análisis por ítem concreto):
- obtener_ingredientes → Ingredientes con precios reales (precio_unitario_real, valor_stock, activo)
- obtener_recetas → Recetas Y VINOS con precio venta e ingredientes
- obtener_ventas → SOLO últimas 300 ventas. NO uses para totales del mes.
- obtener_pedidos → SOLO últimos 300 pedidos. NO uses para totales del mes.
- obtener_gastos → Gastos fijos mensuales
- obtener_proveedores → Lista proveedores
- obtener_horarios → Turnos de trabajo

AGREGADOS EXACTOS (USA SIEMPRE estas para "cuánto", "total", "top", "peor", "mejor"):
- resumen_inventario → Valor stock, nº ingredientes con/sin stock, stock bajo, activos/inactivos.
- resumen_ventas_periodo(fecha_desde, fecha_hasta) → Total ingresos, nº tickets, ticket medio, top recetas.
- resumen_pyg(fecha_desde, fecha_hasta) → P&L: ingresos, compras del periodo, gastos fijos, margen aprox.
- resumen_food_cost_recetas → Food cost por receta ordenado de peor a mejor + margen + precio venta.
- resumen_compras_periodo(fecha_desde, fecha_hasta) → Total compras + por proveedor.
- obtener_resumen_ventas → KPIs últimos 7 días agrupados por día (para análisis semanal corto).
- stock_critico → Ingredientes que hay que reponer.

⚠️ RANGO DE FECHAS para tools que lo piden:
- Formato: YYYY-MM-DD
- hasta es EXCLUSIVE (primer día del MES SIGUIENTE).
- Abril 2026 completo → fecha_desde='2026-04-01', fecha_hasta='2026-05-01'
- Marzo 2026 → '2026-03-01' a '2026-04-01'
- NUNCA uses '2026-04-30' como hasta. Siempre usa el 1º del mes siguiente con '<'.

🚨 PROHIBIDO sumar totales manualmente sobre obtener_ventas u obtener_pedidos.
  Siempre usa la tool de resumen_*_periodo correspondiente.

═══════════════════════════════════════════════════════════
📐 FÓRMULAS (CRÍTICO - USAR CORRECTAMENTE)
═══════════════════════════════════════════════════════════

⚠️ DOS TIPOS DE PRECIO — NO MEZCLAR:
- Para CÁLCULO DE COSTE DE RECETAS / FOOD COST → usa "precio_unitario_real"
  (incluye media real de compras, refleja lo que te cuesta DE VERDAD cada gramo).
- Para VALORACIÓN DE INVENTARIO (¿cuánto vale mi stock?) → SUMA el campo "valor_stock"
  que ya devuelve la tool (precio nominal × stock_actual). Coincide con el dashboard.

⚠️ CONTEOS DEL DASHBOARD — para que cuadren con lo que el usuario ve:
- "Items con stock" o "Valor Stock (274 items)" → cuenta solo ingredientes con stock_actual > 0.
- "Valor total stock" → suma valor_stock SOLO de los ingredientes con stock_actual > 0.
- Si el usuario pregunta "¿cuántos ingredientes tengo?" responde con el conteo
  de ingredientes activos (activo != false). Los inactivos existen en DB pero no
  aparecen en la pestaña Ingredientes del usuario.
- "Stock bajo" → stock_actual = 0 OR (stock_minimo > 0 AND stock_actual <= stock_minimo).

COSTE RECETA (fórmula EXACTA de la app):
  Para cada ingrediente de la receta:
    1. Buscar precio_unitario_real del ingrediente en obtener_ingredientes
    2. Aplicar rendimiento: coste_ajustado = precio_unitario_real / (rendimiento / 100)
       Si rendimiento = 100 o no existe → no ajustar
       Ejemplo: precio 17.50€, rendimiento 60% → 17.50 / 0.60 = 29.17€
    3. Multiplicar: coste_ingrediente = coste_ajustado × cantidad
  Sumar todos los ingredientes → coste_lote
  Dividir por porciones: coste_porcion = coste_lote / porciones
  ⚠️ SIEMPRE dividir por porciones si porciones > 1

FOOD COST: (coste_porcion / precio_venta) × 100

PRECIO IDEAL COMIDA (objetivo 30%):
  precio = coste_porcion / 0.30
PRECIO IDEAL VINOS (objetivo 45%):
  precio = coste_porcion / 0.45
  Ejemplo: coste 11.20€ → precio ideal = 11.20/0.45 = 24.89€
PRECIO IDEAL VINOS (objetivo 50%):
  precio = coste_porcion / 0.50
  Ejemplo: coste 11.20€ → precio ideal = 11.20/0.50 = 22.40€

MARGEN: precio_venta - coste_porcion
RACIONES: stock / cantidad_por_receta
⚠️ IMPORTANTE: Para VINOS usar 45-50%, NUNCA 30-33%

═══════════════════════════════════════════════════════════
🎯 UMBRALES RENTABILIDAD
═══════════════════════════════════════════════════════════
COMIDA: ≤28% 🟢 | 29-33% 🟡 | 34-38% 🟠 | >38% 🔴
VINOS:  ≤40% 🟢 | 41-50% 🟡 | >50% 🔴

═══════════════════════════════════════════════════════════
📈 INFORMES P&L (PÉRDIDAS Y GANANCIAS)
═══════════════════════════════════════════════════════════
Cuando pidan P&L, informe financiero o cuenta de resultados:
1. Usar obtener_ventas + obtener_gastos + obtener_recetas para calcular
2. SIEMPRE incluir en formato tabla markdown:
   | Concepto | Importe |
   |----------|---------|
   | 💰 Ingresos Totales | X€ |
   | 🥩 Coste Productos (COGS) | X€ |
   | 📊 Food Cost % | X% |
   | 💵 Margen Bruto | X€ |
   | 🏢 Gastos Fijos | X€ |
   | ✅ Beneficio Neto | X€ |
3. Añadir análisis: ¿Es rentable? ¿Food cost saludable?
4. Una recomendación específica de mejora

═══════════════════════════════════════════════════════════
🚨 REGLAS
═══════════════════════════════════════════════════════════
✅ Ejecutar herramientas ANTES de responder
✅ Datos REALES, nunca inventar
✅ Usar fórmula CORRECTA según tipo (comida vs vino)
✅ Recomendaciones con números específicos
✅ Usar precio_unitario_real (NUNCA ing.precio directo)
✅ Aplicar rendimiento cuando sea < 100%
✅ Dividir por porciones cuando porciones > 1
❌ NO pedir clarificación si ya tengo los datos
❌ NO usar 30% para vinos (usar 45-50%)
❌ NO dividir precio / cantidad_por_formato manualmente

═══════════════════════════════════════════════════════════
📋 FORMATO RESPUESTA (ESTILO OBLIGATORIO) / MANDATORY RESPONSE STYLE
═══════════════════════════════════════════════════════════
Estructura de toda respuesta / Structure for EVERY reply:

1. PRIMERA LÍNEA / FIRST LINE: la respuesta directa con la cifra clave en
   **NEGRITA MARKDOWN OBLIGATORIA** (**...**). No es opcional. La cifra
   DEBE ir entre asteriscos dobles.
   ES: "**Tu stock vale 30.437,84 €** (274 ingredientes con stock)."
   EN: "**Your stock is worth RM 81,083.18** (75 ingredients in stock)."

2. DESPUÉS / AFTER (opcional): 1-3 líneas de contexto o explicación,
   SOLO si aporta valor real. Si el dato se basta, para ahí.

3. PROHIBIDO cerrar con oferta de más ayuda. Do NOT end with:
     • "¿Quieres que...?" / "¿Te ayudo con...?"
     • "Want me to...?" / "Would you like me to...?"
     • "Let me know if you want..." / "Feel free to ask..."
   Solo pregunta de vuelta si la pregunta original era GENUINAMENTE ambigua
   y necesitas aclarar algo para responder. Si ya respondiste, para.

Reglas de estilo:
- **Negrita SOLO en el dato o conclusión** (no en cada línea).
- Números con 2 decimales máximo.
- Emojis con moderación (1-2 por respuesta como máx, no uno en cada bullet).
- Bullets solo si hay lista real (3+ items comparables).

CASOS ESPECIALES:
- "¿Cómo se calcula X?" / fórmulas → da la fórmula y UN ejemplo con los números
  reales del restaurante (no ejemplo genérico).
- "¿Cómo hago X en la app?" / funcionalidad → pasos numerados concretos, sin
  adornos ni explicaciones de contexto.
- "Dame un informe / P&L / reporte" → entonces SÍ formato largo: tabla
  markdown con todas las métricas + 2-3 observaciones + 1 recomendación
  concreta con número. Ese formato es amigo del export a PDF del usuario.

NO añadas alertas proactivas no solicitadas. Si el usuario quiere saber
problemas, los preguntará.

═══════════════════════════════════════════════════════════
🎬 ACCIONES EJECUTABLES
═══════════════════════════════════════════════════════════
Si el usuario te pide modificar datos (cambiar precio, registrar venta, etc.),
incluye en tu respuesta un marcador [ACTION:...] que el frontend parseará
y ejecutará (previo confirmación del usuario).

Formatos soportados:
- [ACTION:update|ingrediente|NOMBRE|precio|VALOR]
- [ACTION:update|ingrediente|NOMBRE|stock|VALOR]
- [ACTION:update|receta|NOMBRE|precio|VALOR]
- [ACTION:update|receta_ingrediente|RECETA|INGREDIENTE|cantidad|VALOR]
- [ACTION:add|ingrediente|NOMBRE|precio|VALOR|unidad|UNIDAD]
- [ACTION:merma|ingrediente|NOMBRE|cantidad|VALOR]
- [ACTION:add|pedido|PROVEEDOR|ingrediente|NOMBRE|cantidad|VALOR|precio|PRECIO]
- [ACTION:add|venta|RECETA|cantidad|VALOR]

═══════════════════════════════════════════════════════════
📱 GUÍA DE LA APP - AYUDA AL USUARIO
═══════════════════════════════════════════════════════════
Además de analizar costes, puedo guiar al usuario por la app.
Si preguntan "¿cómo hago X?", "¿dónde está Y?", "¿para qué sirve Z?", responder con pasos concretos.

🗂️ PESTAÑAS Y NAVEGACIÓN:
La app tiene sidebar izquierdo con 4 secciones:

INGREDIENTES:
- Ingredientes → Gestionar productos (nombre, precio, stock, proveedor, rendimiento)
- Recetas → Crear platos con ingredientes, ver food cost y margen en tiempo real
- Proveedores → Gestionar proveedores y vincular ingredientes

OPERACIONES:
- Pedidos → Crear pedidos a proveedores
- Ventas → Registrar ventas diarias por plato/variante
- Inventario → Recuento físico, mermas, historial de pérdidas

ANÁLISIS:
- Diario → Control diario tipo Excel (compras vs ventas por día)
- Análisis → Gráficos de ingresos vs gastos
- Inteligencia → Predicciones IA (demanda, stock óptimo, tendencias)

CONFIGURACIÓN:
- Horarios → Planificador de turnos con generación IA
- Configuración → Equipo, datos restaurante, integraciones

📐 EXPLICACIÓN DE FÓRMULAS (para cuando el usuario pregunte):
- Food Cost = (coste producción / precio venta) × 100. Ideal: ≤33% comida, ≤50% vinos
- Precio ideal comida = coste / 0.30 (objetivo 30%)
- Precio ideal vinos = coste / 0.45 (objetivo 45-50%)
- Margen = precio venta - coste producción
- Raciones disponibles = stock ingrediente / cantidad por receta
- Valor stock = Σ(cantidad × precio unitario) de cada ingrediente
- Stock bajo = cuando stock actual < stock mínimo configurado
`;

// ============================================================================
// TOOLS (function declarations)
// ============================================================================
// Each tool declares input schema. The tool handler below executes the
// equivalent SQL query filtered by restauranteId from the JWT.

const TOOLS = [
    {
        name: 'obtener_ingredientes',
        description: 'Lista todos los ingredientes del restaurante con stock, proveedor, y DOS precios distintos: (a) precio_unitario_real para CÁLCULO DE COSTE DE RECETAS (incluye media de compras reales), (b) valor_stock para VALORACIÓN DE INVENTARIO (usa precio nominal configurado, coincide con el dashboard). También devuelve el flag activo (si es FALSE el dashboard NO lo cuenta).',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'resumen_inventario',
        description: 'Devuelve números agregados y EXACTOS del inventario (SQL SUM/COUNT hecho en base de datos, NO suma en JS). Usa esta tool SIEMPRE que el usuario pregunte por "cuánto vale mi inventario", "cuántos ingredientes tengo", "cuántos con stock", "cuántos sin stock", "cuántos stock bajo". Los números coinciden exactamente con el dashboard. NUNCA intentes sumar manualmente los resultados de obtener_ingredientes para estas preguntas.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_recetas',
        description: 'Lista todas las recetas y vinos del restaurante con su precio de venta, porciones e ingredientes.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_ventas',
        description: 'Historial de ventas (últimas 300) con receta, cantidad, precio y fecha.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_gastos',
        description: 'Lista de gastos fijos mensuales del restaurante (alquiler, personal, suministros, etc.).',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_proveedores',
        description: 'Lista de proveedores con contacto.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_pedidos',
        description: 'Últimos 300 pedidos a proveedores con detalle de ingredientes, cantidades y precios.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_resumen_ventas',
        description: 'KPIs de ventas de los últimos 7 días agrupados por día y receta.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'obtener_horarios',
        description: 'Turnos de trabajo de los empleados.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'stock_critico',
        description: 'Ingredientes con stock bajo (<5 días de consumo estimado o bajo el mínimo configurado).',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'resumen_ventas_periodo',
        description: 'Ventas AGREGADAS EXACTAS de un rango de fechas: total ingresos, número de tickets, ticket medio y top recetas ordenadas por ingresos. Usa esto SIEMPRE para preguntas de "cuánto facturé este mes", "top platos del mes", "ventas de abril", etc. NO sumes manualmente sobre obtener_ventas (solo trae 300). Para todo abril 2026: fecha_desde=2026-04-01, fecha_hasta=2026-05-01 (el rango es [desde, hasta), hasta NO se incluye).',
        input_schema: {
            type: 'object',
            properties: {
                fecha_desde: { type: 'string', description: 'Inicio del rango YYYY-MM-DD (inclusive)' },
                fecha_hasta: { type: 'string', description: 'Fin del rango YYYY-MM-DD (exclusive, usa el 1º del mes siguiente)' }
            },
            required: ['fecha_desde', 'fecha_hasta']
        }
    },
    {
        name: 'resumen_pyg',
        description: 'P&L (Pérdidas y Ganancias) AGREGADO EXACTO de un rango de fechas: ingresos totales, coste productos (COGS), margen bruto, gastos fijos del mes, beneficio neto, food cost %. Usa esto para preguntas de P&L, "cuenta de resultados", "beneficio del mes".',
        input_schema: {
            type: 'object',
            properties: {
                fecha_desde: { type: 'string', description: 'Inicio del rango YYYY-MM-DD (inclusive)' },
                fecha_hasta: { type: 'string', description: 'Fin del rango YYYY-MM-DD (exclusive)' }
            },
            required: ['fecha_desde', 'fecha_hasta']
        }
    },
    {
        name: 'resumen_food_cost_recetas',
        description: 'Food cost calculado por cada receta (con precio_unitario_real y rendimiento) ordenado de peor a mejor. Usa esto para preguntas de "qué recetas tienen peor food cost", "recetas fuera de rango", etc. Devuelve también margen y precio venta.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'resumen_compras_periodo',
        description: 'Compras AGREGADAS EXACTAS a proveedores en un rango: total gastado, por proveedor, y por ingrediente. Usa esto para preguntas de "cuánto gasté en compras este mes", "a qué proveedor le compro más".',
        input_schema: {
            type: 'object',
            properties: {
                fecha_desde: { type: 'string', description: 'Inicio del rango YYYY-MM-DD (inclusive)' },
                fecha_hasta: { type: 'string', description: 'Fin del rango YYYY-MM-DD (exclusive)' }
            },
            required: ['fecha_desde', 'fecha_hasta']
        }
    }
];

// ============================================================================
// TOOL HANDLERS (SQL queries equivalent to n8n flow, with restauranteId)
// ============================================================================

// Helper: validate YYYY-MM-DD date string; throws if invalid
function parseIsoDate(value, fieldName) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${fieldName} debe ser YYYY-MM-DD, recibido: ${value}`);
    }
    return value;
}

async function runTool(name, pool, restauranteId, args = {}) {
    switch (name) {
        case 'obtener_ingredientes':
            // Consistency rule (see CLAUDE.md of this project):
            //   - precio_unitario_real (with precio_medio_compra) → FOR RECIPE COST ONLY
            //   - valor_stock (with precio/cpf) → FOR STOCK VALUATION (matches dashboard)
            // The model decides which to use based on the question.
            return (await pool.query(`
                SELECT i.id, i.nombre, i.precio, i.unidad, i.cantidad_por_formato,
                       i.stock_actual, i.stock_minimo, i.familia, i.rendimiento,
                       i.activo,
                       p.nombre as proveedor_nombre,
                       COALESCE(pcd.precio_medio_compra,
                         CASE WHEN i.cantidad_por_formato > 0
                              THEN i.precio / i.cantidad_por_formato
                              ELSE i.precio END
                       ) as precio_unitario_real,
                       (i.stock_actual * CASE
                           WHEN i.cantidad_por_formato IS NOT NULL AND i.cantidad_por_formato > 0
                           THEN i.precio / i.cantidad_por_formato
                           ELSE i.precio
                       END) as valor_stock
                FROM ingredientes i
                LEFT JOIN proveedores p ON i.proveedor_id = p.id
                LEFT JOIN (
                    SELECT ingrediente_id, ROUND(AVG(precio_unitario)::numeric, 4) as precio_medio_compra
                    FROM precios_compra_diarios WHERE restaurante_id = $1
                    GROUP BY ingrediente_id
                ) pcd ON pcd.ingrediente_id = i.id
                WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL
                ORDER BY i.nombre
            `, [restauranteId])).rows;

        case 'obtener_recetas':
            return (await pool.query(`
                SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.porciones, r.ingredientes
                FROM recetas r
                WHERE r.restaurante_id = $1 AND r.deleted_at IS NULL
                ORDER BY r.nombre
            `, [restauranteId])).rows;

        case 'obtener_ventas':
            return (await pool.query(`
                SELECT v.id, v.receta_id, r.nombre as receta_nombre, r.categoria,
                       v.cantidad, v.precio_unitario, v.total, v.fecha
                FROM ventas v
                LEFT JOIN recetas r ON v.receta_id = r.id
                WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL
                ORDER BY v.fecha DESC
                LIMIT 300
            `, [restauranteId])).rows;

        case 'obtener_gastos':
            // Schema real: concepto (VARCHAR), monto_mensual (NUMERIC, ya mensualizado),
            // activo (BOOL, no hay deleted_at). Sin columnas "frecuencia" ni "categoria".
            return (await pool.query(`
                SELECT id, concepto, monto_mensual, activo, created_at
                FROM gastos_fijos
                WHERE restaurante_id = $1 AND (activo IS NULL OR activo = TRUE)
                ORDER BY concepto
            `, [restauranteId])).rows;

        case 'obtener_proveedores':
            return (await pool.query(`
                SELECT p.id, p.nombre, p.telefono, p.email
                FROM proveedores p
                WHERE p.restaurante_id = $1 AND p.deleted_at IS NULL
                ORDER BY p.nombre
            `, [restauranteId])).rows;

        case 'obtener_pedidos':
            return (await pool.query(`
                SELECT p.id, p.fecha, p.estado, p.total,
                       pr.nombre as proveedor_nombre,
                       i.nombre as ingrediente, i.unidad,
                       (ing->>'cantidad')::numeric as cantidad,
                       COALESCE((ing->>'precioUnitario')::numeric, (ing->>'precio_unitario')::numeric) as precio_unitario,
                       COALESCE((ing->>'precioReal')::numeric,
                                (ing->>'cantidad')::numeric *
                                COALESCE((ing->>'precioUnitario')::numeric, (ing->>'precio_unitario')::numeric)) as subtotal
                FROM pedidos p
                LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
                CROSS JOIN LATERAL jsonb_array_elements(p.ingredientes) AS ing
                LEFT JOIN ingredientes i ON i.id = (ing->>'ingredienteId')::int OR i.id = (ing->>'ingrediente_id')::int
                WHERE p.restaurante_id = $1 AND p.deleted_at IS NULL
                ORDER BY p.fecha DESC
                LIMIT 300
            `, [restauranteId])).rows;

        case 'obtener_resumen_ventas':
            return (await pool.query(`
                SELECT DATE(v.fecha) as dia,
                       r.nombre as receta_nombre,
                       SUM(v.cantidad) as cantidad_vendida,
                       SUM(v.total) as total_ingresos
                FROM ventas v
                LEFT JOIN recetas r ON v.receta_id = r.id
                WHERE v.restaurante_id = $1
                  AND v.deleted_at IS NULL
                  AND v.fecha >= CURRENT_DATE - INTERVAL '7 days'
                GROUP BY DATE(v.fecha), r.nombre
                ORDER BY dia DESC, total_ingresos DESC
            `, [restauranteId])).rows;

        case 'obtener_horarios':
            return (await pool.query(`
                SELECT e.nombre as empleado, h.dia_semana, h.hora_inicio, h.hora_fin
                FROM horarios h
                LEFT JOIN empleados e ON h.empleado_id = e.id
                WHERE h.restaurante_id = $1
                ORDER BY e.nombre, h.dia_semana
            `, [restauranteId])).rows;

        case 'resumen_ventas_periodo': {
            const desde = parseIsoDate(args.fecha_desde, 'fecha_desde');
            const hasta = parseIsoDate(args.fecha_hasta, 'fecha_hasta');
            const totals = (await pool.query(`
                SELECT
                    COALESCE(SUM(total), 0)::numeric(12,2) AS total_ingresos,
                    COUNT(*) AS num_tickets,
                    ROUND(COALESCE(AVG(total), 0)::numeric, 2) AS ticket_medio
                FROM ventas
                WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3 AND deleted_at IS NULL
            `, [restauranteId, desde, hasta])).rows[0];
            const topRecetas = (await pool.query(`
                SELECT r.nombre, r.categoria,
                       SUM(v.cantidad)::int AS vendidas,
                       ROUND(SUM(v.total)::numeric, 2) AS ingresos
                FROM ventas v
                LEFT JOIN recetas r ON v.receta_id = r.id
                WHERE v.restaurante_id = $1 AND v.fecha >= $2 AND v.fecha < $3 AND v.deleted_at IS NULL
                GROUP BY r.nombre, r.categoria
                ORDER BY ingresos DESC NULLS LAST
                LIMIT 20
            `, [restauranteId, desde, hasta])).rows;
            return { periodo: { desde, hasta }, totales: totals, top_recetas: topRecetas };
        }

        case 'resumen_pyg': {
            const desde = parseIsoDate(args.fecha_desde, 'fecha_desde');
            const hasta = parseIsoDate(args.fecha_hasta, 'fecha_hasta');
            const ventas = (await pool.query(`
                SELECT COALESCE(SUM(total), 0)::numeric(12,2) AS ingresos,
                       COUNT(*) AS num_tickets
                FROM ventas
                WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3 AND deleted_at IS NULL
            `, [restauranteId, desde, hasta])).rows[0];
            const compras = (await pool.query(`
                SELECT COALESCE(SUM(total), 0)::numeric(12,2) AS total_compras
                FROM pedidos
                WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3 AND deleted_at IS NULL
            `, [restauranteId, desde, hasta])).rows[0];
            // Real schema of gastos_fijos: monto_mensual is already monthly,
            // no frecuencia column, activo boolean (no deleted_at).
            const gastos = (await pool.query(`
                SELECT COALESCE(SUM(monto_mensual), 0)::numeric(12,2) AS gastos_fijos_mes
                FROM gastos_fijos
                WHERE restaurante_id = $1 AND (activo IS NULL OR activo = TRUE)
            `, [restauranteId])).rows[0];
            const ingresos = parseFloat(ventas.ingresos) || 0;
            const compras_periodo = parseFloat(compras.total_compras) || 0;
            const gastos_fijos_mes = parseFloat(gastos.gastos_fijos_mes) || 0;
            // COGS exact (cost of goods sold) cannot be calculated precisely here
            // without replicating the full recipe expansion from the frontend.
            // Exposed numbers are honest: sales, purchases in period, fixed costs.
            // The model should explain compras_periodo is "purchases", not "COGS".
            return {
                periodo: { desde, hasta },
                ingresos,
                compras_periodo,
                gastos_fijos_mes,
                margen_aproximado_sin_cogs_exacto: ingresos - compras_periodo - gastos_fijos_mes,
                num_tickets: parseInt(ventas.num_tickets) || 0,
                nota: 'compras_periodo es lo comprado en el periodo (albaranes/pedidos). No es COGS exacto, pero es una aproximación útil. Para COGS exacto haría falta expandir las recetas de cada venta.'
            };
        }

        case 'resumen_food_cost_recetas':
            return (await pool.query(`
                WITH recetas_coste AS (
                    SELECT
                        r.id, r.nombre, r.categoria, r.precio_venta, r.porciones,
                        COALESCE(SUM(
                            (ing->>'cantidad')::numeric *
                            COALESCE(pcd.precio_medio_compra,
                                CASE WHEN i.cantidad_por_formato > 0
                                     THEN i.precio / i.cantidad_por_formato
                                     ELSE i.precio END
                            ) /
                            NULLIF(COALESCE(i.rendimiento, 100) / 100.0, 0)
                        ), 0) AS coste_lote
                    FROM recetas r
                    LEFT JOIN LATERAL jsonb_array_elements(COALESCE(r.ingredientes::jsonb, '[]'::jsonb)) ing ON true
                    LEFT JOIN ingredientes i ON i.id = (ing->>'ingredienteId')::int
                      AND i.restaurante_id = $1 AND i.deleted_at IS NULL
                    LEFT JOIN (
                        SELECT ingrediente_id, AVG(precio_unitario) AS precio_medio_compra
                        FROM precios_compra_diarios WHERE restaurante_id = $1
                        GROUP BY ingrediente_id
                    ) pcd ON pcd.ingrediente_id = i.id
                    WHERE r.restaurante_id = $1 AND r.deleted_at IS NULL
                    GROUP BY r.id, r.nombre, r.categoria, r.precio_venta, r.porciones
                )
                SELECT nombre, categoria,
                       ROUND(precio_venta::numeric, 2) AS precio_venta,
                       porciones,
                       ROUND((coste_lote / NULLIF(porciones, 0))::numeric, 2) AS coste_porcion,
                       ROUND(((coste_lote / NULLIF(porciones, 0)) / NULLIF(precio_venta, 0) * 100)::numeric, 1) AS food_cost_pct,
                       ROUND((precio_venta - (coste_lote / NULLIF(porciones, 0)))::numeric, 2) AS margen
                FROM recetas_coste
                WHERE precio_venta > 0 AND porciones > 0 AND coste_lote > 0
                ORDER BY food_cost_pct DESC NULLS LAST
            `, [restauranteId])).rows;

        case 'resumen_compras_periodo': {
            const desde = parseIsoDate(args.fecha_desde, 'fecha_desde');
            const hasta = parseIsoDate(args.fecha_hasta, 'fecha_hasta');
            const total = (await pool.query(`
                SELECT COALESCE(SUM(total), 0)::numeric(12,2) AS total_compras,
                       COUNT(*) AS num_pedidos
                FROM pedidos
                WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3 AND deleted_at IS NULL
            `, [restauranteId, desde, hasta])).rows[0];
            const porProveedor = (await pool.query(`
                SELECT COALESCE(pr.nombre, '(sin proveedor)') AS proveedor,
                       COALESCE(SUM(p.total), 0)::numeric(12,2) AS gasto,
                       COUNT(*) AS num_pedidos
                FROM pedidos p
                LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
                WHERE p.restaurante_id = $1 AND p.fecha >= $2 AND p.fecha < $3 AND p.deleted_at IS NULL
                GROUP BY pr.nombre
                ORDER BY gasto DESC
                LIMIT 20
            `, [restauranteId, desde, hasta])).rows;
            return { periodo: { desde, hasta }, total, por_proveedor: porProveedor };
        }

        case 'resumen_inventario':
            // Aggregated numbers matching the dashboard formulas exactly.
            // The model must NOT sum over obtener_ingredientes to answer
            // these questions — aritmética de lista larga es imprecisa.
            return (await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE stock_actual > 0) AS items_con_stock,
                    ROUND(COALESCE(SUM(
                        CASE WHEN stock_actual > 0 THEN
                            stock_actual * CASE
                                WHEN cantidad_por_formato IS NOT NULL AND cantidad_por_formato > 0
                                THEN precio / cantidad_por_formato
                                ELSE precio
                            END
                        ELSE 0 END
                    ), 0)::numeric, 2) AS valor_stock_total,
                    COUNT(*) FILTER (WHERE activo IS NULL OR activo = TRUE) AS ingredientes_activos,
                    COUNT(*) FILTER (WHERE activo = FALSE) AS ingredientes_inactivos,
                    COUNT(*) FILTER (WHERE stock_actual = 0) AS ingredientes_sin_stock,
                    COUNT(*) FILTER (
                        WHERE stock_minimo > 0 AND stock_actual <= stock_minimo
                    ) AS ingredientes_stock_bajo_por_minimo,
                    COUNT(*) AS total_ingredientes
                FROM ingredientes
                WHERE restaurante_id = $1 AND deleted_at IS NULL
            `, [restauranteId])).rows[0];

        case 'stock_critico':
            return (await pool.query(`
                SELECT i.nombre, i.stock_actual, i.stock_minimo, i.unidad,
                       p.nombre as proveedor,
                       COALESCE(consumo.consumo_diario, 0) as consumo_diario,
                       CASE WHEN COALESCE(consumo.consumo_diario, 0) > 0
                            THEN FLOOR(i.stock_actual / consumo.consumo_diario)
                            ELSE 999 END as dias_stock,
                       CASE
                           WHEN COALESCE(consumo.consumo_diario, 0) > 0
                                AND FLOOR(i.stock_actual / consumo.consumo_diario) <= 2 THEN 'CRITICO'
                           WHEN COALESCE(consumo.consumo_diario, 0) > 0
                                AND FLOOR(i.stock_actual / consumo.consumo_diario) <= 5 THEN 'BAJO'
                           WHEN i.stock_actual <= COALESCE(i.stock_minimo, 0) THEN 'BAJO'
                           ELSE 'OK'
                       END as nivel_alerta
                FROM ingredientes i
                LEFT JOIN proveedores p ON i.proveedor_id = p.id
                LEFT JOIN LATERAL (
                    SELECT SUM((ing->>'cantidad')::numeric * v.cantidad) /
                           NULLIF(COUNT(DISTINCT DATE(v.fecha)), 0) as consumo_diario
                    FROM ventas v
                    JOIN recetas r ON v.receta_id = r.id
                    CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes::jsonb) ing
                    WHERE (ing->>'ingredienteId')::int = i.id
                      AND v.restaurante_id = $1
                      AND v.deleted_at IS NULL
                      AND v.fecha >= CURRENT_DATE - INTERVAL '30 days'
                ) consumo ON true
                WHERE i.restaurante_id = $1
                  AND i.deleted_at IS NULL
                  AND (
                    (COALESCE(consumo.consumo_diario, 0) > 0 AND FLOOR(i.stock_actual / consumo.consumo_diario) <= 5)
                    OR i.stock_actual <= COALESCE(i.stock_minimo, 0)
                  )
                ORDER BY dias_stock ASC
                LIMIT 100
            `, [restauranteId])).rows;

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// ============================================================================
// MAIN ENTRY: processChat
// ============================================================================
// Runs the agent loop: ask model → execute tools it requests → loop until
// it produces a final text response. Returns plain text (preserves n8n contract).

async function processChat({ message, pool, restauranteId, lang = 'es', restauranteNombre = '', moneda = '€' }) {
    if (!client) {
        throw new Error('Claude API not configured: ANTHROPIC_API_KEY missing');
    }

    const today = new Date();
    const fechaHoy = today.toLocaleDateString(lang === 'en' ? 'en-GB' : 'es-ES', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // Split system into two blocks so the big static portion is cached and
    // the small dynamic portion (date, language, restaurant) is not.
    const systemBlocks = [
        {
            type: 'text',
            text: SYSTEM_PROMPT_STATIC,
            cache_control: { type: 'ephemeral' }
        },
        {
            type: 'text',
            text: `🌐 Idioma: ${lang === 'en' ? 'English (respond in English)' : 'Español (responder en español)'}\n📅 Fecha: ${fechaHoy}\n🏪 Restaurante: ${restauranteNombre || '(sin nombre)'}\n💱 Moneda: ${moneda}\n\n⚠️ USA SIEMPRE el símbolo "${moneda}" en TODAS las cifras monetarias de tu respuesta, tanto en texto como en tablas. Los ejemplos en el prompt con € son solo ilustrativos — tú debes usar "${moneda}". No añadas € si la moneda configurada es distinta.`
        }
    ];

    const messages = [{ role: 'user', content: message }];

    let usageAggregate = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    let finalText = '';

    for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: systemBlocks,
            tools: TOOLS,
            messages
        });

        if (response.usage) {
            usageAggregate.input += response.usage.input_tokens || 0;
            usageAggregate.output += response.usage.output_tokens || 0;
            usageAggregate.cache_read += response.usage.cache_read_input_tokens || 0;
            usageAggregate.cache_creation += response.usage.cache_creation_input_tokens || 0;
        }

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
            finalText = response.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n')
                .trim();
            break;
        }

        if (response.stop_reason === 'tool_use') {
            messages.push({ role: 'assistant', content: response.content });

            const toolResults = [];
            for (const block of response.content) {
                if (block.type === 'tool_use') {
                    try {
                        const result = await runTool(block.name, pool, restauranteId, block.input || {});
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: JSON.stringify(result)
                        });
                    } catch (err) {
                        log('error', 'Chat tool execution failed', {
                            tool: block.name, restauranteId, error: err.message
                        });
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: JSON.stringify({ error: err.message }),
                            is_error: true
                        });
                    }
                }
            }
            messages.push({ role: 'user', content: toolResults });
            continue;
        }

        // Unexpected stop reason (max_tokens, etc.)
        log('warn', 'Chat: unexpected stop_reason', {
            stop_reason: response.stop_reason, restauranteId
        });
        finalText = response.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim() || '⚠️ Respuesta incompleta. Intenta reformular la pregunta.';
        break;
    }

    if (!finalText) {
        finalText = '⚠️ Alcanzado el límite de iteraciones internas. Intenta hacer la pregunta más concreta.';
    }

    log('info', 'Chat: response generated', {
        restauranteId,
        iterations: Math.min(MAX_AGENT_ITERATIONS, messages.length - 1),
        usage: usageAggregate
    });

    return { text: finalText, usage: usageAggregate };
}

module.exports = { processChat, TOOLS, MODEL };
