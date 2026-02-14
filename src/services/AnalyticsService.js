/**
 * ============================================
 * services/AnalyticsService.js
 * ============================================
 *
 * Lógica de negocio para análisis y KPIs.
 *
 * @author MindLoopIA
 * @version 1.0.0
 */

const BaseService = require('./BaseService');
const { log } = require('../utils/logger');

class AnalyticsService extends BaseService {
    constructor() {
        super('ventas');
    }

    /**
     * Balance mensual completo
     */
    async getMonthlyBalance(mes, ano, restauranteId) {
        const m = parseInt(mes), y = parseInt(ano);
        const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
        const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
        const endDate = `${ny}-${String(nm).padStart(2, '0')}-01`;

        // Ingresos
        const ingresos = await this.query(
            `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as num_ventas
             FROM ventas
             WHERE fecha >= $1 AND fecha < $2
               AND restaurante_id = $3 AND deleted_at IS NULL`,
            [startDate, endDate, restauranteId]
        );

        // Precios de ingredientes
        const preciosResult = await this.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [restauranteId]
        );
        const preciosMap = new Map();
        preciosResult.forEach(i => {
            const precioUnitario = (parseFloat(i.precio) || 0) / (parseFloat(i.cantidad_por_formato) || 1);
            preciosMap.set(i.id, precioUnitario);
        });

        // Calcular costos
        const ventasDetalle = await this.query(
            `SELECT v.cantidad, r.ingredientes
             FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE v.fecha >= $1 AND v.fecha < $2
               AND v.restaurante_id = $3 AND v.deleted_at IS NULL`,
            [startDate, endDate, restauranteId]
        );

        let costos = 0;
        for (const v of ventasDetalle) {
            for (const ing of (v.ingredientes || [])) {
                costos += (preciosMap.get(ing.ingredienteId) || 0) * (ing.cantidad || 0) * v.cantidad;
            }
        }

        const totalIngresos = parseFloat(ingresos[0]?.total || 0);
        const ganancia = totalIngresos - costos;
        const margen = totalIngresos > 0 ? (ganancia / totalIngresos) * 100 : 0;

        return {
            ingresos: totalIngresos,
            costos,
            ganancia,
            margen: Math.round(margen * 10) / 10,
            num_ventas: parseInt(ingresos[0]?.num_ventas || 0)
        };
    }

    /**
     * Menu Engineering - Clasificación BCG
     */
    async getMenuEngineering(restauranteId) {
        const ventas = await this.query(
            `SELECT r.id, r.nombre, r.categoria, r.precio_venta, r.ingredientes,
                    SUM(v.cantidad) as cantidad_vendida, SUM(v.total) as total_ventas
             FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
             GROUP BY r.id`,
            [restauranteId]
        );

        if (ventas.length === 0) return [];

        // Precios unitarios
        const preciosResult = await this.query(
            'SELECT id, precio, cantidad_por_formato FROM ingredientes WHERE restaurante_id = $1',
            [restauranteId]
        );
        const preciosMap = new Map();
        preciosResult.forEach(i => {
            preciosMap.set(i.id, (parseFloat(i.precio) || 0) / (parseFloat(i.cantidad_por_formato) || 1));
        });

        const totalVentas = ventas.reduce((sum, v) => sum + parseFloat(v.cantidad_vendida), 0);
        const promedioPopularidad = totalVentas / ventas.length;
        let sumaMargenes = 0;

        const analisis = ventas.map(plato => {
            let costePlato = 0;
            for (const ing of (plato.ingredientes || [])) {
                costePlato += (preciosMap.get(ing.ingredienteId) || 0) * (ing.cantidad || 0);
            }
            const margen = parseFloat(plato.precio_venta) - costePlato;
            sumaMargenes += margen * parseFloat(plato.cantidad_vendida);

            return {
                ...plato,
                coste: costePlato,
                margen,
                foodCost: parseFloat(plato.precio_venta) > 0 ? (costePlato / parseFloat(plato.precio_venta)) * 100 : 0
            };
        });

        const promedioMargen = totalVentas > 0 ? sumaMargenes / totalVentas : 0;

        return analisis.map(p => {
            const esPopular = parseFloat(p.cantidad_vendida) >= promedioPopularidad * 0.7;
            const esRentable = p.margen >= promedioMargen;

            let clasificacion = 'perro';
            if (esPopular && esRentable) clasificacion = 'estrella';
            else if (esPopular && !esRentable) clasificacion = 'caballo';
            else if (!esPopular && esRentable) clasificacion = 'puzzle';

            return { ...p, clasificacion, esPopular, esRentable };
        });
    }

    /**
     * Top productos vendidos
     */
    async getTopProducts(restauranteId, limit = 10) {
        return this.query(
            `SELECT r.nombre, SUM(v.cantidad) as total_vendido, SUM(v.total) as total_ingresos
             FROM ventas v JOIN recetas r ON v.receta_id = r.id
             WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL
             GROUP BY r.nombre ORDER BY total_vendido DESC LIMIT $2`,
            [restauranteId, limit]
        );
    }
}

module.exports = AnalyticsService;
