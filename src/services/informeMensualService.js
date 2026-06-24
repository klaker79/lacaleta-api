/**
 * informeMensualService — recoge todos los datos para el informe ejecutivo
 * mensual del chat add-on. SOLO LECTURA, no escribe nada en BBDD.
 *
 * Devuelve un JSON estructurado con KPIs principales del mes en curso para
 * el tenant indicado. Diseñado para pasar a Claude como contexto y que
 * genere recomendaciones accionables.
 *
 * Argumentos:
 *   pool: Pool de pg
 *   restauranteId: int
 *   mes: 'YYYY-MM' (opcional, default = mes en curso)
 *
 * Resultado:
 *   {
 *     periodo: { mes_actual, mes_anterior, fecha_generacion },
 *     restaurante: { nombre, moneda },
 *     ingresos: { mes_actual, mes_anterior, variacion_pct },
 *     food_cost: { mes_actual_pct, mes_anterior_pct, cogs_actual },
 *     top_rentables: [{ nombre, vendidas, margen_pct, ingresos }, ...],
 *     top_problematicos: [{ nombre, vendidas, food_cost_pct, ... }, ...],
 *     cambios_precio: [{ ingrediente, precio_actual, precio_anterior, variacion_pct }, ...],
 *     stock: { valor_total, items_bajo_minimo, items_sin_stock },
 *     personal: { coste_mes, horas_totales }
 *   }
 */

const { log } = require('../utils/logger');
const { personalCostExpr } = require('../utils/personalCost');

function rangoMes(mes) {
    // mes: 'YYYY-MM' o null/undefined → mes actual
    let inicio;
    if (mes && /^\d{4}-\d{2}$/.test(mes)) {
        inicio = new Date(`${mes}-01T00:00:00Z`);
    } else {
        const hoy = new Date();
        inicio = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
    }
    const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 1));
    const anteriorInicio = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() - 1, 1));
    const anteriorFin = inicio;
    return {
        inicio: inicio.toISOString().slice(0, 10),
        fin: fin.toISOString().slice(0, 10),
        anteriorInicio: anteriorInicio.toISOString().slice(0, 10),
        anteriorFin: anteriorFin.toISOString().slice(0, 10),
        mesEtiqueta: inicio.toISOString().slice(0, 7),
        mesAnteriorEtiqueta: anteriorInicio.toISOString().slice(0, 7)
    };
}

async function getRestaurante(pool, restauranteId) {
    const r = await pool.query(
        'SELECT nombre, moneda FROM restaurantes WHERE id = $1 LIMIT 1',
        [restauranteId]
    );
    return r.rows[0] || { nombre: '', moneda: '€' };
}

async function getIngresos(pool, restauranteId, rango) {
    const sql = `
        SELECT
            COALESCE(SUM(CASE WHEN fecha >= $2 AND fecha < $3 THEN total ELSE 0 END), 0)::numeric AS actual,
            COALESCE(SUM(CASE WHEN fecha >= $4 AND fecha < $5 THEN total ELSE 0 END), 0)::numeric AS anterior
        FROM ventas
        WHERE restaurante_id = $1
          AND deleted_at IS NULL
          AND fecha >= $4 AND fecha < $3
    `;
    const r = await pool.query(sql, [
        restauranteId,
        rango.inicio, rango.fin,
        rango.anteriorInicio, rango.anteriorFin
    ]);
    const actual = parseFloat(r.rows[0].actual) || 0;
    const anterior = parseFloat(r.rows[0].anterior) || 0;
    const variacion = anterior > 0 ? ((actual - anterior) / anterior) * 100 : null;
    return { mes_actual: actual, mes_anterior: anterior, variacion_pct: variacion };
}

async function getTopRentables(pool, restauranteId, rango, limit = 5) {
    // Top platos por beneficio bruto. Fuente: ventas_diarias_resumen, que ya
    // tiene coste_ingredientes y total_ingresos por día/receta — evitamos
    // depender de un coste persistido en recetas (no existe esa columna).
    const sql = `
        SELECT
            r.nombre,
            SUM(vdr.cantidad_vendida)::int AS vendidas,
            ROUND(SUM(vdr.total_ingresos)::numeric, 2) AS ingresos,
            ROUND(SUM(vdr.coste_ingredientes)::numeric, 2) AS coste,
            CASE WHEN SUM(vdr.total_ingresos) > 0
                 THEN ROUND(((SUM(vdr.total_ingresos) - SUM(vdr.coste_ingredientes))
                              / SUM(vdr.total_ingresos) * 100)::numeric, 2)
                 ELSE 0 END AS margen_pct
        FROM ventas_diarias_resumen vdr
        JOIN recetas r ON r.id = vdr.receta_id AND r.deleted_at IS NULL
        WHERE vdr.restaurante_id = $1
          AND vdr.fecha >= $2 AND vdr.fecha < $3
        GROUP BY r.id, r.nombre
        HAVING SUM(vdr.cantidad_vendida) > 0
           AND SUM(vdr.total_ingresos) > 0
        ORDER BY (SUM(vdr.total_ingresos) - SUM(vdr.coste_ingredientes)) DESC
        LIMIT $4
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin, limit]);
    return r.rows;
}

async function getTopProblematicos(pool, restauranteId, rango, limit = 5) {
    // Platos con food cost > 40% y volumen significativo. Misma fuente que
    // top_rentables para coherencia.
    const sql = `
        SELECT
            r.nombre,
            SUM(vdr.cantidad_vendida)::int AS vendidas,
            ROUND(SUM(vdr.total_ingresos)::numeric, 2) AS ingresos,
            ROUND(SUM(vdr.coste_ingredientes)::numeric, 2) AS coste,
            CASE WHEN SUM(vdr.total_ingresos) > 0
                 THEN ROUND((SUM(vdr.coste_ingredientes)
                              / SUM(vdr.total_ingresos) * 100)::numeric, 2)
                 ELSE 0 END AS food_cost_pct
        FROM ventas_diarias_resumen vdr
        JOIN recetas r ON r.id = vdr.receta_id AND r.deleted_at IS NULL
        WHERE vdr.restaurante_id = $1
          AND vdr.fecha >= $2 AND vdr.fecha < $3
        GROUP BY r.id, r.nombre
        HAVING SUM(vdr.cantidad_vendida) > 0
           AND SUM(vdr.total_ingresos) > 0
           AND SUM(vdr.coste_ingredientes) > 0
           AND (SUM(vdr.coste_ingredientes) / SUM(vdr.total_ingresos)) > 0.40
        ORDER BY (SUM(vdr.coste_ingredientes) / SUM(vdr.total_ingresos)) DESC,
                 SUM(vdr.cantidad_vendida) DESC
        LIMIT $4
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin, limit]);
    return r.rows;
}

async function getCambiosPrecio(pool, restauranteId, rango, limit = 10) {
    // Ingredientes con cambio de precio > 10% entre mes anterior y actual,
    // basado en media de compras (precios_compra_diarios)
    const sql = `
        WITH actual AS (
            SELECT pcd.ingrediente_id,
                   AVG(pcd.precio_unitario)::numeric AS precio
            FROM precios_compra_diarios pcd
            WHERE pcd.restaurante_id = $1
              AND pcd.fecha >= $2 AND pcd.fecha < $3
            GROUP BY pcd.ingrediente_id
        ),
        anterior AS (
            SELECT pcd.ingrediente_id,
                   AVG(pcd.precio_unitario)::numeric AS precio
            FROM precios_compra_diarios pcd
            WHERE pcd.restaurante_id = $1
              AND pcd.fecha >= $4 AND pcd.fecha < $5
            GROUP BY pcd.ingrediente_id
        )
        SELECT
            i.nombre AS ingrediente,
            i.unidad,
            ROUND(actual.precio, 4) AS precio_actual,
            ROUND(anterior.precio, 4) AS precio_anterior,
            ROUND(((actual.precio - anterior.precio) / anterior.precio * 100)::numeric, 2) AS variacion_pct
        FROM actual
        JOIN anterior USING (ingrediente_id)
        JOIN ingredientes i ON i.id = actual.ingrediente_id AND i.restaurante_id = $1 AND i.deleted_at IS NULL
        WHERE anterior.precio > 0
          AND ABS((actual.precio - anterior.precio) / anterior.precio) > 0.10
        ORDER BY ABS((actual.precio - anterior.precio) / anterior.precio) DESC
        LIMIT $6
    `;
    const r = await pool.query(sql, [
        restauranteId,
        rango.inicio, rango.fin,
        rango.anteriorInicio, rango.anteriorFin,
        limit
    ]);
    return r.rows;
}

async function getStock(pool, restauranteId) {
    const sql = `
        SELECT
            ROUND(SUM(stock_actual * (precio / NULLIF(cantidad_por_formato, 0)))::numeric, 2) AS valor_total,
            COUNT(*) FILTER (WHERE stock_actual = 0 OR (stock_minimo > 0 AND stock_actual <= stock_minimo)) AS items_bajo_minimo,
            COUNT(*) FILTER (WHERE stock_actual = 0) AS items_sin_stock
        FROM ingredientes
        WHERE restaurante_id = $1
          AND deleted_at IS NULL
    `;
    const r = await pool.query(sql, [restauranteId]);
    return r.rows[0] || {};
}

async function getCogsMes(pool, restauranteId, rango) {
    // COGS canónico = SUM(coste_ingredientes) de ventas_diarias_resumen.
    // Es la misma fórmula sellada en el baseline (project_kpis_sellados_2026_04_20).
    // Usar compras (precios_compra_diarios) inflaría food cost en meses con
    // pedidos grandes que aún no se han vendido.
    const sql = `
        SELECT COALESCE(SUM(coste_ingredientes), 0)::numeric AS cogs_actual
        FROM ventas_diarias_resumen
        WHERE restaurante_id = $1
          AND fecha >= $2 AND fecha < $3
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin]);
    return parseFloat(r.rows[0].cogs_actual) || 0;
}

async function getGastosFijosMes(pool, restauranteId) {
    // gastos_fijos.monto_mensual ya es mensual (no hay frecuencia)
    const sql = `
        SELECT COALESCE(SUM(monto_mensual), 0)::numeric AS total,
               COUNT(*) AS num_conceptos
        FROM gastos_fijos
        WHERE restaurante_id = $1
          AND (activo IS NULL OR activo = TRUE)
    `;
    const r = await pool.query(sql, [restauranteId]);
    return {
        total: parseFloat(r.rows[0].total) || 0,
        num_conceptos: parseInt(r.rows[0].num_conceptos) || 0
    };
}

async function getComidaPersonalMes(pool, restauranteId, rango) {
    // 🍽️ Gasto en comida de personal del mes (líneas personal de los pedidos).
    // Es un GASTO operativo aparte: resta al beneficio neto, pero NO es food cost
    // ni COGS ni entra en compras/gasto por proveedor.
    const sql = `
        SELECT COALESCE(SUM(${personalCostExpr('p')}), 0)::numeric AS total
        FROM pedidos p
        WHERE p.restaurante_id = $1 AND p.fecha >= $2 AND p.fecha < $3 AND p.deleted_at IS NULL
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin]);
    return parseFloat(r.rows[0].total) || 0;
}

async function getPersonalExtraMes(pool, restauranteId, rango) {
    // 👷 Pagos a extras por horas del mes. Gasto operativo REAL con fecha que
    // resta al beneficio neto (como comida_personal), NO es food cost ni COGS.
    const sql = `
        SELECT COALESCE(SUM(total), 0)::numeric AS total
        FROM personal_extra
        WHERE restaurante_id = $1 AND fecha >= $2 AND fecha < $3
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin]);
    return parseFloat(r.rows[0].total) || 0;
}

async function getTopProveedores(pool, restauranteId, rango, limit = 8) {
    // Cuánto se compró a cada proveedor en el mes + mes anterior para variación.
    // Se basa en pedidos.total (cash-flow real de albaranes), RESTANDO el coste de
    // las líneas de comida personal (no son gasto del restaurante; van a su pestaña).
    const gastoExpr = `COALESCE(SUM(p.total - ${personalCostExpr('p')}), 0)::numeric`;
    const sql = `
        WITH actual AS (
            SELECT COALESCE(pr.nombre, '(sin proveedor)') AS proveedor,
                   ${gastoExpr} AS gasto
            FROM pedidos p
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            WHERE p.restaurante_id = $1
              AND p.fecha >= $2 AND p.fecha < $3
              AND p.deleted_at IS NULL
            GROUP BY pr.nombre
        ),
        anterior AS (
            SELECT COALESCE(pr.nombre, '(sin proveedor)') AS proveedor,
                   ${gastoExpr} AS gasto
            FROM pedidos p
            LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
            WHERE p.restaurante_id = $1
              AND p.fecha >= $4 AND p.fecha < $5
              AND p.deleted_at IS NULL
            GROUP BY pr.nombre
        )
        SELECT actual.proveedor,
               ROUND(actual.gasto, 2) AS gasto_actual,
               ROUND(COALESCE(anterior.gasto, 0), 2) AS gasto_anterior,
               CASE WHEN COALESCE(anterior.gasto, 0) > 0
                    THEN ROUND(((actual.gasto - anterior.gasto) / anterior.gasto * 100)::numeric, 1)
                    ELSE NULL END AS variacion_pct
        FROM actual
        LEFT JOIN anterior USING (proveedor)
        WHERE actual.gasto > 0
        ORDER BY actual.gasto DESC
        LIMIT $6
    `;
    const r = await pool.query(sql, [
        restauranteId,
        rango.inicio, rango.fin,
        rango.anteriorInicio, rango.anteriorFin,
        limit
    ]);
    return r.rows;
}

async function getMermasMes(pool, restauranteId, rango) {
    // Valor perdido por mermas + top motivos
    const totalSql = `
        SELECT COALESCE(SUM(valor_perdida), 0)::numeric AS valor_total,
               COUNT(*) AS num_registros
        FROM mermas
        WHERE restaurante_id = $1
          AND fecha >= $2 AND fecha < $3
          AND deleted_at IS NULL
    `;
    const total = (await pool.query(totalSql, [restauranteId, rango.inicio, rango.fin])).rows[0];

    const topMotivosSql = `
        SELECT COALESCE(NULLIF(TRIM(motivo), ''), 'sin motivo') AS motivo,
               COUNT(*)::int AS num,
               ROUND(SUM(valor_perdida)::numeric, 2) AS valor
        FROM mermas
        WHERE restaurante_id = $1
          AND fecha >= $2 AND fecha < $3
          AND deleted_at IS NULL
        GROUP BY 1
        ORDER BY valor DESC NULLS LAST
        LIMIT 5
    `;
    const motivos = (await pool.query(topMotivosSql, [restauranteId, rango.inicio, rango.fin])).rows;

    return {
        valor_total: parseFloat(total.valor_total) || 0,
        num_registros: parseInt(total.num_registros) || 0,
        top_motivos: motivos
    };
}

async function getEvolucionDiaria(pool, restauranteId, rango) {
    // Ingresos diarios del mes. Para sparkline. Solo días con datos.
    const sql = `
        SELECT DATE(fecha)::text AS dia,
               ROUND(SUM(total)::numeric, 2) AS ingresos
        FROM ventas
        WHERE restaurante_id = $1
          AND fecha >= $2 AND fecha < $3
          AND deleted_at IS NULL
        GROUP BY DATE(fecha)
        ORDER BY DATE(fecha) ASC
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin]);
    return r.rows;
}

/**
 * Punto de entrada principal. Recoge todos los datos en paralelo y
 * devuelve el JSON consolidado.
 */
async function generarInformeMensual(pool, restauranteId, mes) {
    if (!restauranteId) throw new Error('restauranteId requerido');

    const rango = rangoMes(mes);

    try {
        const [
            restaurante, ingresos, topRentables, topProblematicos, cambiosPrecio,
            stock, cogsActual, gastosFijos, topProveedores, mermas, evolucion, comidaPersonal,
            personalExtra
        ] = await Promise.all([
            getRestaurante(pool, restauranteId),
            getIngresos(pool, restauranteId, rango),
            getTopRentables(pool, restauranteId, rango, 5),
            getTopProblematicos(pool, restauranteId, rango, 5),
            getCambiosPrecio(pool, restauranteId, rango, 10),
            getStock(pool, restauranteId),
            getCogsMes(pool, restauranteId, rango),
            getGastosFijosMes(pool, restauranteId),
            getTopProveedores(pool, restauranteId, rango, 8),
            getMermasMes(pool, restauranteId, rango),
            getEvolucionDiaria(pool, restauranteId, rango),
            getComidaPersonalMes(pool, restauranteId, rango),
            getPersonalExtraMes(pool, restauranteId, rango)
        ]);

        const foodCostPct = ingresos.mes_actual > 0
            ? Math.round((cogsActual / ingresos.mes_actual) * 10000) / 100
            : 0;

        // Food cost REAL: incluye también lo perdido por mermas. Un plato
        // bien escandallado puede tener buen food cost por unidad, pero si
        // se tira el 10% del producto antes de venderlo, el food cost real
        // del mes es mayor. Mostrar ambos números educa al dueño sobre dónde
        // se le va el dinero (mal escandallado vs descontrol operativo).
        // NOTA: este número es SOLO INFORMATIVO. El P&L y beneficio neto
        // mantienen el cálculo conservador (sin restar mermas) para no
        // cambiar la cifra que el dueño enseña a socios/inversores. Decisión
        // de Iker 2026-05-12.
        const mermasValor = parseFloat(mermas.valor_total) || 0;
        const cogsConMermas = cogsActual + mermasValor;
        const foodCostRealPct = ingresos.mes_actual > 0
            ? Math.round((cogsConMermas / ingresos.mes_actual) * 10000) / 100
            : 0;

        // P&L: ingresos − COGS − gastos fijos − comida de personal = beneficio neto.
        // 🍽️ La comida de personal SÍ resta (es gasto operativo real), pero NO es food
        // cost (no toca cogs/food_cost_pct). Las mermas NO se restan aquí (variante
        // conservadora; ver food cost real arriba y la sección Mermas).
        const margenBruto = ingresos.mes_actual - cogsActual;
        const beneficioNeto = margenBruto - gastosFijos.total - comidaPersonal - personalExtra;
        const margenNetoPct = ingresos.mes_actual > 0
            ? Math.round((beneficioNeto / ingresos.mes_actual) * 10000) / 100
            : 0;

        return {
            periodo: {
                mes: rango.mesEtiqueta,
                mes_anterior: rango.mesAnteriorEtiqueta,
                inicio: rango.inicio,
                fin: rango.fin,
                fecha_generacion: new Date().toISOString()
            },
            restaurante,
            ingresos,
            food_cost: {
                mes_actual_pct: foodCostPct,
                cogs_actual: Math.round(cogsActual * 100) / 100,
                // Food cost REAL = (COGS ventas + valor mermas) / ingresos.
                // Refleja la pérdida operativa total, no solo lo vendido.
                real_pct: foodCostRealPct,
                cogs_con_mermas: Math.round(cogsConMermas * 100) / 100,
                mermas_valor: Math.round(mermasValor * 100) / 100
            },
            pyg: {
                ingresos: Math.round(ingresos.mes_actual * 100) / 100,
                cogs: Math.round(cogsActual * 100) / 100,
                margen_bruto: Math.round(margenBruto * 100) / 100,
                gastos_fijos: Math.round(gastosFijos.total * 100) / 100,
                gastos_fijos_conceptos: gastosFijos.num_conceptos,
                comida_personal: Math.round(comidaPersonal * 100) / 100,
                personal_extra: Math.round(personalExtra * 100) / 100,
                beneficio_neto: Math.round(beneficioNeto * 100) / 100,
                margen_neto_pct: margenNetoPct
            },
            top_rentables: topRentables,
            top_problematicos: topProblematicos,
            cambios_precio: cambiosPrecio,
            stock,
            top_proveedores: topProveedores,
            mermas,
            evolucion_diaria: evolucion
        };
    } catch (err) {
        log('error', 'generarInformeMensual failed', {
            restauranteId, mes, error: err.message, stack: err.stack
        });
        throw err;
    }
}

module.exports = { generarInformeMensual };
