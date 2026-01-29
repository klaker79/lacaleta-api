/**
 * Application Service: KPIService
 * Calcula KPIs financieros
 */

class KPIService {
    constructor(dependencies = {}) {
        this.pool = dependencies.pool || require('../../infrastructure/database/connection');
    }

    /**
     * Obtiene KPIs del día actual
     */
    async getDailyKPIs(restaurantId, date = new Date()) {
        const dateStr = date.toISOString().split('T')[0];

        // Query adaptada a la estructura existente de la tabla ventas
        const query = `
            SELECT
                COALESCE(SUM(total), 0) as revenue,
                COUNT(*) as sale_count
            FROM ventas
            WHERE restaurante_id = $1
              AND DATE(fecha) = $2
        `;

        const result = await this.pool.query(query, [restaurantId, dateStr]);
        const data = result.rows[0];

        const revenue = parseFloat(data.revenue) || 0;
        // Estimar coste basado en food cost promedio (30%)
        const estimatedCost = revenue * 0.30;
        const grossProfit = revenue - estimatedCost;
        const margin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
        const foodCost = revenue > 0 ? (estimatedCost / revenue) * 100 : 0;

        return {
            date: dateStr,
            revenue,
            cost: estimatedCost,
            grossProfit,
            margin: Math.round(margin * 10) / 10,
            foodCost: Math.round(foodCost * 10) / 10,
            saleCount: parseInt(data.sale_count) || 0
        };
    }

    /**
     * Obtiene KPIs del mes
     */
    async getMonthlyKPIs(restaurantId, year, month) {
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];

        const query = `
            SELECT
                DATE(fecha) as fecha,
                SUM(total) as revenue,
                COUNT(*) as sale_count
            FROM ventas
            WHERE restaurante_id = $1
              AND DATE(fecha) >= $2
              AND DATE(fecha) <= $3
            GROUP BY DATE(fecha)
            ORDER BY fecha
        `;

        const result = await this.pool.query(query, [restaurantId, startDate, endDate]);

        const dailyData = result.rows.map(row => ({
            date: row.fecha,
            revenue: parseFloat(row.revenue) || 0,
            cost: (parseFloat(row.revenue) || 0) * 0.30,
            saleCount: parseInt(row.sale_count) || 0
        }));

        // Totales del mes
        const totals = dailyData.reduce((acc, day) => ({
            revenue: acc.revenue + day.revenue,
            cost: acc.cost + day.cost,
            saleCount: acc.saleCount + day.saleCount
        }), { revenue: 0, cost: 0, saleCount: 0 });

        const grossProfit = totals.revenue - totals.cost;
        const margin = totals.revenue > 0 ? (grossProfit / totals.revenue) * 100 : 0;
        const foodCost = totals.revenue > 0 ? (totals.cost / totals.revenue) * 100 : 0;

        return {
            period: { year, month },
            totals: {
                revenue: totals.revenue,
                cost: totals.cost,
                grossProfit,
                margin: Math.round(margin * 10) / 10,
                foodCost: Math.round(foodCost * 10) / 10,
                saleCount: totals.saleCount,
                avgTicket: totals.saleCount > 0 ? Math.round(totals.revenue / totals.saleCount * 100) / 100 : 0
            },
            daily: dailyData
        };
    }

    /**
     * Obtiene comparativa de últimos N meses
     */
    async getMonthlyComparison(restaurantId, months = 6) {
        const query = `
            SELECT
                DATE_TRUNC('month', fecha) as month,
                SUM(total) as revenue,
                COUNT(*) as sale_count
            FROM ventas
            WHERE restaurante_id = $1
              AND fecha >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '${months} months'
            GROUP BY DATE_TRUNC('month', fecha)
            ORDER BY month
        `;

        const result = await this.pool.query(query, [restaurantId]);

        return result.rows.map(row => {
            const revenue = parseFloat(row.revenue) || 0;
            const cost = revenue * 0.30;
            const grossProfit = revenue - cost;

            return {
                month: row.month,
                revenue,
                cost,
                grossProfit,
                margin: revenue > 0 ? Math.round(((grossProfit / revenue) * 100) * 10) / 10 : 0,
                foodCost: 30, // Estimado
                saleCount: parseInt(row.sale_count) || 0
            };
        });
    }

    /**
     * Obtiene top recetas por rentabilidad
     */
    async getTopRecipesByMargin(restaurantId, limit = 10) {
        const query = `
            SELECT
                r.id,
                r.nombre,
                r.precio_venta,
                COALESCE(SUM(v.cantidad), 0) as total_vendido,
                COALESCE(SUM(v.total), 0) as ingresos
            FROM recetas r
            LEFT JOIN ventas v ON r.id = v.receta_id
                AND v.restaurante_id = $1
                AND v.fecha >= CURRENT_DATE - INTERVAL '30 days'
            WHERE r.restaurante_id = $1
            GROUP BY r.id, r.nombre, r.precio_venta
            ORDER BY ingresos DESC
            LIMIT $2
        `;

        const result = await this.pool.query(query, [restaurantId, limit]);
        return result.rows.map(row => ({
            ...row,
            margen_porcentaje: 70, // Estimado - calcular real si existe coste_calculado
            precio_venta: parseFloat(row.precio_venta) || 0,
            total_vendido: parseInt(row.total_vendido) || 0,
            ingresos: parseFloat(row.ingresos) || 0
        }));
    }
}

module.exports = KPIService;
