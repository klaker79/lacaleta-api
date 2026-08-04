/**
 * intelligence Routes — Extracted from server.js
 * AI Intelligence: freshness, purchase planning, overstock detection, price review
 */
const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { costlyApiLimiter } = require('../middleware/rateLimit');
// 2026-06-08: requirePlan retirado. El gating ahora es global en server.js.
const { log } = require('../utils/logger');
const { buildIngredientPriceMap, getBackendIngredientUnitPrice, getRecipeCostBase, computePriceDrift, computeSuppliesOverstock, computeReorderSuggestions } = require('../utils/businessHelpers');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== 🧠 INTELIGENCIA - ENDPOINT FRESCURA ==========
    // Días de vida útil por familia (estándares conservadores para seguridad alimentaria)
    // NOTA: Valores conservadores asumiendo producto fresco/descongelado
    const VIDA_UTIL_DIAS = {
        'pescado': 3,    // Fresco o descongelado: usar rápido
        'marisco': 3,    // Fresco o descongelado: usar rápido  
        'carne': 4,
        'verdura': 5,
        'lacteo': 5,
        'bebida': 30,
        'alimento': 4,
        'default': 7
    };

    router.get('/intelligence/freshness', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            // 🔒 cantidadRecibida con fallback a cantidad (auditoria A1-C3):
            //    para pedidos en estado 'recibido', cantidadRecibida puede diferir
            //    de cantidad pedida (incluso 0 si el item se marcó 'no-entregado').
            //    Antes este endpoint usaba siempre `cantidad` y alertaba sobre
            //    productos que en realidad nunca llegaron al restaurante.
            //    Patrón idéntico al de search.routes.js y chatService.js.
            const result = await pool.query(`
            WITH compras_recientes AS (
                SELECT
                    p.id as pedido_id,
                    p.fecha_recepcion,
                    CURRENT_DATE - p.fecha_recepcion::date as dias_desde_compra,
                    ing->>'ingredienteId' as ingrediente_id,
                    COALESCE((ing->>'cantidadRecibida')::numeric, (ing->>'cantidad')::numeric) as cantidad_comprada
                FROM pedidos p
                CROSS JOIN LATERAL jsonb_array_elements(p.ingredientes) AS ing
                WHERE p.restaurante_id = $1
                  AND p.deleted_at IS NULL
                  AND p.estado = 'recibido'
                  AND p.fecha_recepcion IS NOT NULL
                  AND p.fecha_recepcion >= CURRENT_DATE - INTERVAL '7 days'
                  AND COALESCE(ing->>'estado', '') <> 'no-entregado'
                  AND COALESCE((ing->>'cantidadRecibida')::numeric, (ing->>'cantidad')::numeric) > 0
                  AND COALESCE((ing->>'personal')::boolean, false) = false
            )
            SELECT 
                i.id,
                i.nombre,
                i.familia,
                i.stock_actual,
                i.unidad,
                c.dias_desde_compra,
                c.fecha_recepcion
            FROM compras_recientes c
            JOIN ingredientes i ON i.id = c.ingrediente_id::int
            WHERE i.stock_actual > 0 AND i.deleted_at IS NULL
            ORDER BY c.dias_desde_compra DESC
        `, [req.restauranteId]);

            // Solo productos frescos (carne, pescado, marisco)
            const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];

            const alertas = result.rows
                .filter(row => FAMILIAS_FRESCAS.includes((row.familia || '').toLowerCase()))
                .map(row => {
                    const familia = (row.familia || 'default').toLowerCase();
                    const vidaUtil = VIDA_UTIL_DIAS[familia] || VIDA_UTIL_DIAS['default'];
                    const diasRestantes = vidaUtil - (row.dias_desde_compra || 0);

                    return {
                        ...row,
                        vida_util: vidaUtil,
                        dias_restantes: diasRestantes,
                        urgencia: diasRestantes <= 0 ? 'critico' : diasRestantes === 1 ? 'hoy' : diasRestantes <= 2 ? 'mañana' : 'ok'
                    };
                })
                .filter(a => a.dias_restantes <= 2);

            res.json(alertas);
        } catch (err) {
            log('error', 'Error en intelligence/freshness', { error: err.message });
            res.status(500).json({ error: 'Error interno', alertas: [] });
        }
    });

    // ========== 🧠 INTELIGENCIA - PLAN COMPRAS ==========
    router.get('/intelligence/purchase-plan', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const targetDay = parseInt(req.query.day) || 6; // Sábado por defecto
            const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

            const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    ri.ingrediente_id,
                    SUM(ri.cantidad * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_distintos
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                CROSS JOIN LATERAL (
                    SELECT 
                        (ri_json->>'ingredienteId')::int as ingrediente_id,
                        (ri_json->>'cantidad')::numeric as cantidad
                ) ri
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                  AND v.deleted_at IS NULL AND r.deleted_at IS NULL
                GROUP BY EXTRACT(DOW FROM v.fecha), ri.ingrediente_id
            )
            SELECT 
                i.id,
                i.nombre,
                i.familia,
                i.stock_actual,
                i.unidad,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) as consumo_promedio,
                COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2 as par_level,
                i.stock_actual - (COALESCE(c.consumo_total / NULLIF(c.dias_distintos, 0), 0) * 1.2) as diferencia
            FROM ingredientes i
            LEFT JOIN consumo_por_dia c ON c.ingrediente_id = i.id AND c.dia_semana = $2
            WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL
              AND c.consumo_total > 0
            ORDER BY diferencia ASC
        `, [req.restauranteId, targetDay]);

            const sugerencias = result.rows
                .filter(r => parseFloat(r.diferencia) < 0)
                .map(r => ({
                    ...r,
                    sugerencia_pedido: Math.abs(parseFloat(r.diferencia))
                }));

            res.json({
                dia_objetivo: DIAS[targetDay],
                sugerencias
            });
        } catch (err) {
            log('error', 'Error en intelligence/purchase-plan', { error: err.message });
            res.status(500).json({ error: 'Error interno', sugerencias: [] });
        }
    });

    // ========== 🧠 INTELIGENCIA - SOBRESTOCK ==========
    // Festivos Galicia 2026 - tratar como sábados
    const FESTIVOS_GALICIA = [
        '2026-01-01', '2026-01-06', '2026-04-09', '2026-04-10',
        '2026-05-01', '2026-05-17', '2026-07-25', '2026-08-15',
        '2026-10-12', '2026-11-01', '2026-12-06', '2026-12-08', '2026-12-25'
    ];

    router.get('/intelligence/overstock', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            // Calcular día efectivo (festivos = sábado)
            const hoy = new Date().toISOString().split('T')[0];
            const esFestivo = FESTIVOS_GALICIA.includes(hoy);
            const diaActual = esFestivo ? 6 : new Date().getDay();

            const result = await pool.query(`
            WITH consumo_por_dia AS (
                SELECT 
                    ri.ingrediente_id,
                    EXTRACT(DOW FROM v.fecha) as dia_semana,
                    SUM(ri.cantidad * v.cantidad) as consumo_total,
                    COUNT(DISTINCT v.fecha) as dias_contados
                FROM ventas v
                JOIN recetas r ON r.id = v.receta_id
                CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) AS ri_json
                CROSS JOIN LATERAL (
                    SELECT 
                        (ri_json->>'ingredienteId')::int as ingrediente_id,
                        (ri_json->>'cantidad')::numeric as cantidad
                ) ri
                WHERE v.restaurante_id = $1
                  AND v.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
                  AND v.deleted_at IS NULL AND r.deleted_at IS NULL
                GROUP BY ri.ingrediente_id, EXTRACT(DOW FROM v.fecha)
            ),
            consumo_dia_actual AS (
                SELECT 
                    ingrediente_id,
                    consumo_total / NULLIF(dias_contados, 0) as consumo_dia
                FROM consumo_por_dia
                WHERE dia_semana = $2
            )
            SELECT 
                i.id, i.nombre, i.familia, i.stock_actual, i.unidad,
                COALESCE(c.consumo_dia, 0) as consumo_diario,
                CASE WHEN COALESCE(c.consumo_dia, 0) > 0 
                    THEN i.stock_actual / c.consumo_dia ELSE 999 END as dias_stock
            FROM ingredientes i
            LEFT JOIN consumo_dia_actual c ON c.ingrediente_id = i.id
            WHERE i.restaurante_id = $1 AND i.stock_actual > 0 AND i.deleted_at IS NULL
              AND COALESCE(c.consumo_dia, 0) > 0
            ORDER BY dias_stock DESC
        `, [req.restauranteId, diaActual]);

            const FAMILIAS_FRESCAS = ['carne', 'pescado', 'marisco'];
            const UMBRAL_DIAS = { 'marisco': 3, 'pescado': 3, 'carne': 5, 'default': 7 };

            const sobrestock = result.rows
                .filter(r => FAMILIAS_FRESCAS.includes(r.familia?.toLowerCase()))
                .filter(r => {
                    const umbral = UMBRAL_DIAS[r.familia?.toLowerCase()] || UMBRAL_DIAS['default'];
                    return parseFloat(r.dias_stock) > umbral;
                });

            res.json(sobrestock);
        } catch (err) {
            log('error', 'Error en intelligence/overstock', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== 🧠 INTELIGENCIA - REVISION PRECIOS ==========
    router.get('/intelligence/price-check', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const TARGET_FOOD_COST = 35;
            const ALERT_THRESHOLD = 40;

            const result = await pool.query(`
            SELECT
                r.id,
                r.nombre,
                r.precio_venta,
                r.porciones,
                r.ingredientes
            FROM recetas r
            WHERE r.restaurante_id = $1
              AND r.precio_venta > 0
              AND r.deleted_at IS NULL
        `, [req.restauranteId]);

            // 🔒 Bloqueante residual B1 (post-auditoría 2026-04-28):
            //    Antes este endpoint usaba AVG(pcd.precio_unitario) (no ponderado) y un
            //    bucle inline que NO expandía subrecetas. Capa 2 + Capa 3 cerraron esto
            //    en las otras 6 rutas pero ésta quedó fuera del scope. Ahora aplica el
            //    mismo patrón canónico: getBackendIngredientUnitPrice + getRecipeCostBase.
            const ingredientes = await pool.query(
                `SELECT i.id, i.precio, i.cantidad_por_formato, i.rendimiento, i.precio_fijado,
                        pcd.precio_medio_compra
                 FROM ingredientes i
                 LEFT JOIN (
                     SELECT ingrediente_id,
                            ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) AS precio_medio_compra
                     FROM precios_compra_diarios
                     WHERE restaurante_id = $1
                     GROUP BY ingrediente_id
                 ) pcd ON pcd.ingrediente_id = i.id
                 WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );

            const preciosMap = new Map();
            const rendimientoBaseMap = new Map();
            ingredientes.rows.forEach(i => {
                preciosMap.set(i.id, getBackendIngredientUnitPrice(i));
                if (i.rendimiento) rendimientoBaseMap.set(i.id, parseFloat(i.rendimiento));
            });

            // Cargar TODAS las recetas para que getRecipeCostBase pueda expandir subrecetas
            // (ingredienteId > 100000 → preparación base). Mismo patrón que analytics.routes.js.
            const todasRecetasResult = await pool.query(
                'SELECT id, porciones, ingredientes FROM recetas WHERE restaurante_id = $1 AND deleted_at IS NULL',
                [req.restauranteId]
            );
            const recetasMap = new Map(todasRecetasResult.rows.map(r => [r.id, r]));

            const recetasProblema = result.rows
                .map(r => {
                    // 🔒 Auditoría A1-C1 (Capa 6) + B1 (post-auditoría): coste-de-lote
                    //    expandido (subrecetas resueltas) dividido por porciones para
                    //    obtener coste por porción, alineado con el frontend
                    //    (calcularCosteRecetaCompleto) y con el resto del backend.
                    const porciones = Math.max(1, parseInt(r.porciones) || 1);
                    const recetaShape = recetasMap.get(r.id) || {
                        id: r.id, porciones, ingredientes: r.ingredientes
                    };
                    const costeLote = getRecipeCostBase(recetaShape, preciosMap, recetasMap, rendimientoBaseMap);
                    const costePorPorcion = costeLote / porciones;
                    const precioVenta = parseFloat(r.precio_venta) || 0;
                    const foodCost = precioVenta > 0 ? (costePorPorcion / precioVenta) * 100 : 0;
                    const precioSugerido = costePorPorcion / (TARGET_FOOD_COST / 100);

                    return {
                        id: r.id,
                        nombre: r.nombre,
                        coste: costePorPorcion,
                        precio_actual: precioVenta,
                        food_cost: Math.round(foodCost),
                        precio_sugerido: precioSugerido
                    };
                })
                .filter(r => r.food_cost > ALERT_THRESHOLD);

            res.json({
                objetivo: TARGET_FOOD_COST,
                umbral_alerta: ALERT_THRESHOLD,
                recetas_problema: recetasProblema
            });
        } catch (err) {
            log('error', 'Error en intelligence/price-check', { error: err.message });
            res.status(500).json({ error: 'Error interno', recetas_problema: [] });
        }
    });


    // ========== 🧠 INTELIGENCIA - DERIVA DE PRECIO SOSTENIDA ==========
    // Alerta "caso tomate" (Anais, 2026-07-05): el food cost usa la media ponderada
    // de TODO el histórico; si un proveedor sube un precio y SE MANTIENE caro, la
    // media tarda meses en reflejarlo y el escandallo enseña un margen mejor que el
    // real. Este endpoint es READ-ONLY y ADITIVO: no cambia ningún cálculo, solo
    // compara "precio que usa la app" vs "media ponderada de los últimos 90 días"
    // y devuelve las subidas sostenidas en ingredientes de alto gasto.
    // Query params opcionales (clamped): umbral (%), min_compras, min_gasto (€).
    router.get('/intelligence/price-drift', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const VENTANA_DIAS = 90;
            const clamp = (v, lo, hi, def) => {
                const n = parseFloat(v);
                return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
            };
            const umbralPct = clamp(req.query.umbral, 1, 500, 15);
            const minCompras = clamp(req.query.min_compras, 1, 30, 3);
            const minGasto = clamp(req.query.min_gasto, 0, 100000, 100);

            // Una fila por ingrediente comprado en la ventana: precio configurado
            // (para getBackendIngredientUnitPrice), media histórica (la que usa el
            // food cost) y media ponderada de los últimos 90 días.
            const result = await pool.query(`
            SELECT i.id, i.nombre, i.unidad, i.precio, i.cantidad_por_formato, i.precio_fijado,
                   hist.precio_medio_compra,
                   d90.media_90d, d90.n_compras_90d, d90.gasto_90d, d90.cantidad_90d, d90.ultima_compra
            FROM ingredientes i
            JOIN (
                SELECT ingrediente_id,
                       ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) AS media_90d,
                       COUNT(*) AS n_compras_90d,
                       ROUND(SUM(total_compra)::numeric, 2) AS gasto_90d,
                       ROUND(SUM(cantidad_comprada)::numeric, 3) AS cantidad_90d,
                       MAX(fecha) AS ultima_compra
                FROM precios_compra_diarios
                WHERE restaurante_id = $1
                  AND fecha >= CURRENT_DATE - INTERVAL '${VENTANA_DIAS} days'
                GROUP BY ingrediente_id
            ) d90 ON d90.ingrediente_id = i.id
            LEFT JOIN (
                SELECT ingrediente_id,
                       ROUND((SUM(total_compra) / NULLIF(SUM(cantidad_comprada), 0))::numeric, 4) AS precio_medio_compra
                FROM precios_compra_diarios
                WHERE restaurante_id = $1
                GROUP BY ingrediente_id
            ) hist ON hist.ingrediente_id = i.id
            WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL
        `, [req.restauranteId]);

            const alertas = computePriceDrift(result.rows, { umbralPct, minCompras, minGasto });

            // Nº de recetas afectadas por cada ingrediente alertado (defensivo: si
            // esta query fallara, las alertas salen igualmente sin el contador).
            if (alertas.length > 0) {
                try {
                    const ids = alertas.map(a => a.id);
                    const recetasResult = await pool.query(`
                    SELECT (e->>'ingredienteId')::int AS ingrediente_id,
                           COUNT(DISTINCT r.id)::int AS n_recetas
                    FROM recetas r
                    CROSS JOIN LATERAL jsonb_array_elements(r.ingredientes) e
                    WHERE r.restaurante_id = $1
                      AND r.deleted_at IS NULL
                      AND (e->>'ingredienteId') ~ '^[0-9]+$'
                      AND (e->>'ingredienteId')::int = ANY($2::int[])
                    GROUP BY 1
                `, [req.restauranteId, ids]);
                    const porIng = new Map(recetasResult.rows.map(r => [r.ingrediente_id, r.n_recetas]));
                    alertas.forEach(a => { a.recetas_afectadas = porIng.get(a.id) || 0; });
                } catch (recErr) {
                    log('error', 'price-drift: conteo de recetas falló (no bloqueante)', { error: recErr.message });
                    alertas.forEach(a => { a.recetas_afectadas = null; });
                }
            }

            res.json({
                ventana_dias: VENTANA_DIAS,
                umbral_pct: umbralPct,
                min_compras: minCompras,
                min_gasto: minGasto,
                alertas
            });
        } catch (err) {
            log('error', 'Error en intelligence/price-drift', { error: err.message });
            res.status(500).json({ error: 'Error interno', alertas: [] });
        }
    });

    // ========== 🛒 INTELIGENCIA - PUNTO DE PEDIDO RECOMENDADO ==========
    // consumo diario real × plazo del proveedor + stock de seguridad. El consumo
    // sale de `stock_deductions.calculado` (demanda real aunque el clamp no
    // descontara) y el plazo de la media real de recepción de cada proveedor.
    // SOLO SUGIERE: no crea pedidos ni toca stock.
    router.get('/intelligence/reorder', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const VENTANA_DIAS = 90;
            const clamp = (v, lo, hi, def) => {
                const n = parseFloat(v);
                return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
            };
            const leadDefault = clamp(req.query.lead_default, 1, 30, 2);
            const coberturaObjetivoDias = clamp(req.query.cobertura, 1, 60, 7);

            const result = await pool.query(`
            SELECT i.id, i.nombre, i.unidad, i.stock_actual, i.stock_minimo,
                   i.proveedor_id, p.nombre AS proveedor_nombre,
                   c.consumido_ventana,
                   lt.lead_dias_medio
            FROM ingredientes i
            JOIN (
                SELECT (d->>'ingredienteId')::int AS ingrediente_id,
                       SUM(COALESCE((d->>'calculado')::numeric, 0)) AS consumido_ventana
                FROM ventas v
                CROSS JOIN LATERAL jsonb_array_elements(v.stock_deductions) d
                WHERE v.restaurante_id = $1
                  AND v.deleted_at IS NULL
                  AND v.stock_deductions IS NOT NULL
                  AND v.fecha >= CURRENT_DATE - INTERVAL '${VENTANA_DIAS} days'
                GROUP BY 1
            ) c ON c.ingrediente_id = i.id
            LEFT JOIN proveedores p
                   ON p.id = i.proveedor_id
                  AND p.restaurante_id = $1
                  AND p.deleted_at IS NULL
            LEFT JOIN (
                SELECT proveedor_id,
                       AVG(GREATEST(1, EXTRACT(EPOCH FROM (fecha_recepcion - fecha_creacion)) / 86400.0)) AS lead_dias_medio
                FROM pedidos
                WHERE restaurante_id = $1
                  AND deleted_at IS NULL
                  AND estado = 'recibido'
                  AND fecha_recepcion IS NOT NULL
                  AND fecha_creacion IS NOT NULL
                  AND fecha_creacion >= CURRENT_DATE - INTERVAL '180 days'
                GROUP BY proveedor_id
            ) lt ON lt.proveedor_id = i.proveedor_id
            WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL
        `, [req.restauranteId]);

            const sugerencias = computeReorderSuggestions(result.rows, {
                ventanaDias: VENTANA_DIAS,
                leadDefault,
                coberturaObjetivoDias
            });

            res.json({
                ventana_dias: VENTANA_DIAS,
                lead_default: leadDefault,
                cobertura_objetivo_dias: coberturaObjetivoDias,
                sugerencias
            });
        } catch (err) {
            log('error', 'Error en intelligence/reorder', { error: err.message });
            res.status(500).json({ error: 'Error interno', sugerencias: [] });
        }
    });

    // ========== 🧹 INTELIGENCIA - SUMINISTROS ACUMULADOS ==========
    // Los suministros no están en ninguna receta ⇒ vender NO los descuenta: solo
    // entran, nunca salen. Su stock deja de medir el almacén y pasa a medir todo
    // lo comprado desde el primer día. Aquí se compara el stock contra el RITMO
    // REAL DE COMPRA (el único proxy de consumo que existe para ellos) y se avisa
    // para que el usuario haga recuento. NO corrige nada: la app no puede saber
    // cuántos guantes quedan en el cajón.
    router.get('/intelligence/supplies-overstock', costlyApiLimiter, authMiddleware, async (req, res) => {
        try {
            const VENTANA_DIAS = 90;
            const clamp = (v, lo, hi, def) => {
                const n = parseFloat(v);
                return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
            };
            const umbralMeses = clamp(req.query.umbral_meses, 0.5, 60, 2);
            const minCompras = clamp(req.query.min_compras, 1, 30, 2);
            const minValor = clamp(req.query.min_valor, 0, 100000, 25);

            const result = await pool.query(`
            SELECT i.id, i.nombre, i.unidad, i.stock_actual, i.stock_real,
                   i.precio, i.cantidad_por_formato,
                   COALESCE(c.cantidad_90d, 0)  AS cantidad_90d,
                   COALESCE(c.n_compras_90d, 0) AS n_compras_90d,
                   c.ultima_compra
            FROM ingredientes i
            LEFT JOIN (
                SELECT ingrediente_id,
                       SUM(cantidad_comprada) AS cantidad_90d,
                       COUNT(*)               AS n_compras_90d,
                       MAX(fecha)             AS ultima_compra
                FROM precios_compra_diarios
                WHERE restaurante_id = $1
                  AND fecha >= CURRENT_DATE - INTERVAL '${VENTANA_DIAS} days'
                GROUP BY ingrediente_id
            ) c ON c.ingrediente_id = i.id
            WHERE i.restaurante_id = $1
              AND i.deleted_at IS NULL
              AND LOWER(COALESCE(i.familia, 'alimento')) IN ('suministro', 'suministros')
        `, [req.restauranteId]);

            const alertas = computeSuppliesOverstock(result.rows, { umbralMeses, minCompras, minValor, ventanaDias: VENTANA_DIAS });

            // Contexto agregado: el frontend muestra UN aviso resumen (no 60), así
            // que necesita el total y cuántos suministros no se han contado nunca.
            const conStock = result.rows.filter(r => (parseFloat(r.stock_actual) || 0) > 0);
            const valorTotal = conStock.reduce((s, r) => {
                const cpf = parseFloat(r.cantidad_por_formato) || 0;
                const precio = parseFloat(r.precio) || 0;
                return s + (parseFloat(r.stock_actual) || 0) * (cpf > 0 ? precio / cpf : precio);
            }, 0);

            res.json({
                ventana_dias: VENTANA_DIAS,
                umbral_meses: umbralMeses,
                min_compras: minCompras,
                min_valor: minValor,
                n_suministros_con_stock: conStock.length,
                valor_total: Math.round(valorTotal * 100) / 100,
                valor_exceso_total: Math.round(alertas.reduce((s, a) => s + a.valor_exceso, 0) * 100) / 100,
                nunca_contados: conStock.filter(r => r.stock_real === null || r.stock_real === undefined).length,
                alertas
            });
        } catch (err) {
            log('error', 'Error en intelligence/supplies-overstock', { error: err.message });
            res.status(500).json({ error: 'Error interno', alertas: [] });
        }
    });

    return router;
};
