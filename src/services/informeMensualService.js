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
    // Plato más vendido con buen margen (precio_venta - coste). Para evitar
    // depender de tablas resumen, calculamos a partir de ventas + recetas.
    const sql = `
        SELECT
            r.nombre,
            SUM(v.cantidad)::int AS vendidas,
            r.precio_venta::numeric AS precio_venta,
            r.coste::numeric AS coste,
            CASE WHEN r.precio_venta > 0
                 THEN ROUND(((r.precio_venta - r.coste) / r.precio_venta * 100)::numeric, 2)
                 ELSE 0 END AS margen_pct,
            ROUND((SUM(v.cantidad) * r.precio_venta)::numeric, 2) AS ingresos
        FROM ventas v
        JOIN recetas r ON r.id = v.receta_id AND r.deleted_at IS NULL
        WHERE v.restaurante_id = $1
          AND v.deleted_at IS NULL
          AND v.fecha >= $2 AND v.fecha < $3
        GROUP BY r.id, r.nombre, r.precio_venta, r.coste
        HAVING SUM(v.cantidad) > 0
        ORDER BY (SUM(v.cantidad) * (r.precio_venta - COALESCE(r.coste, 0))) DESC
        LIMIT $4
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin, limit]);
    return r.rows;
}

async function getTopProblematicos(pool, restauranteId, rango, limit = 5) {
    // Platos con food cost alto (>40%) y volumen de venta significativo
    const sql = `
        SELECT
            r.nombre,
            SUM(v.cantidad)::int AS vendidas,
            r.precio_venta::numeric AS precio_venta,
            r.coste::numeric AS coste,
            CASE WHEN r.precio_venta > 0
                 THEN ROUND((r.coste / r.precio_venta * 100)::numeric, 2)
                 ELSE 0 END AS food_cost_pct
        FROM ventas v
        JOIN recetas r ON r.id = v.receta_id AND r.deleted_at IS NULL
        WHERE v.restaurante_id = $1
          AND v.deleted_at IS NULL
          AND v.fecha >= $2 AND v.fecha < $3
          AND r.precio_venta > 0
          AND r.coste > 0
        GROUP BY r.id, r.nombre, r.precio_venta, r.coste
        HAVING SUM(v.cantidad) > 0
           AND (r.coste / r.precio_venta) > 0.40
        ORDER BY (r.coste / r.precio_venta) DESC, SUM(v.cantidad) DESC
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
        JOIN ingredientes i ON i.id = actual.ingrediente_id AND i.deleted_at IS NULL
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
    // COGS calculado: sum(cantidad_recibida * precio_unitario) de los pedidos
    // recibidos en el mes (proxy razonable). Más adelante podemos refinar
    // con stock_deductions reales de ventas.
    const sql = `
        SELECT COALESCE(SUM(pcd.total_compra), 0)::numeric AS cogs_actual
        FROM precios_compra_diarios pcd
        WHERE pcd.restaurante_id = $1
          AND pcd.fecha >= $2 AND pcd.fecha < $3
    `;
    const r = await pool.query(sql, [restauranteId, rango.inicio, rango.fin]);
    return parseFloat(r.rows[0].cogs_actual) || 0;
}

/**
 * Punto de entrada principal. Recoge todos los datos en paralelo y
 * devuelve el JSON consolidado.
 */
async function generarInformeMensual(pool, restauranteId, mes) {
    if (!restauranteId) throw new Error('restauranteId requerido');

    const rango = rangoMes(mes);

    try {
        const [restaurante, ingresos, topRentables, topProblematicos, cambiosPrecio, stock, cogsActual] = await Promise.all([
            getRestaurante(pool, restauranteId),
            getIngresos(pool, restauranteId, rango),
            getTopRentables(pool, restauranteId, rango, 5),
            getTopProblematicos(pool, restauranteId, rango, 5),
            getCambiosPrecio(pool, restauranteId, rango, 10),
            getStock(pool, restauranteId),
            getCogsMes(pool, restauranteId, rango)
        ]);

        const foodCostPct = ingresos.mes_actual > 0
            ? Math.round((cogsActual / ingresos.mes_actual) * 10000) / 100
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
                cogs_actual: Math.round(cogsActual * 100) / 100
            },
            top_rentables: topRentables,
            top_problematicos: topProblematicos,
            cambios_precio: cambiosPrecio,
            stock
        };
    } catch (err) {
        log('error', 'generarInformeMensual failed', {
            restauranteId, mes, error: err.message, stack: err.stack
        });
        throw err;
    }
}

module.exports = { generarInformeMensual };
