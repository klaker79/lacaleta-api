/**
 * Monthly Routes — monthly summary endpoint (used by dashboard Top Proveedores).
 *
 * Extracted from balance.routes.js on 2026-04-20.
 *
 * Endpoint:
 *   - GET /monthly/summary?mes=X&ano=Y — full monthly data in Excel-shape
 *     (per-day purchases + sales + supplier aggregates + resumen).
 *     Used by dashboard (Top Proveedores) and Diario tab.
 *
 * Source of truth for compras:  precios_compra_diarios (with fallback to
 *   ingredientes_proveedores.es_proveedor_principal when pedido has no proveedor).
 * Source of truth for ventas:    tabla `ventas` (aggregated by day + receta here).
 * Cost formula:                  Jack Miller — see CLAUDE.md.
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/auth');
const { log } = require('../utils/logger');

module.exports = function (pool) {
    const router = Router();

    router.get('/monthly/summary', authMiddleware, async (req, res) => {
        try {
            const { mes, ano } = req.query;
            const mesActual = parseInt(mes) || new Date().getMonth() + 1;
            const anoActual = parseInt(ano) || new Date().getFullYear();

            // Compras diarias (con fallback a proveedor principal del ingrediente)
            const comprasDiarias = await pool.query(`
                SELECT
                    p.fecha,
                    i.id as ingrediente_id,
                    i.nombre as ingrediente,
                    p.precio_unitario,
                    p.cantidad_comprada,
                    p.total_compra,
                    COALESCE(pr.nombre, pr_fallback.nombre) as proveedor_nombre,
                    COALESCE(p.proveedor_id, ip.proveedor_id) as proveedor_id
                FROM precios_compra_diarios p
                JOIN ingredientes i ON p.ingrediente_id = i.id
                LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
                LEFT JOIN ingredientes_proveedores ip ON ip.ingrediente_id = p.ingrediente_id AND ip.es_proveedor_principal = true
                LEFT JOIN proveedores pr_fallback ON ip.proveedor_id = pr_fallback.id AND p.proveedor_id IS NULL
                LEFT JOIN pedidos ped ON p.pedido_id = ped.id
                WHERE p.restaurante_id = $1
                  AND p.fecha >= $2 AND p.fecha < $3
                  AND i.deleted_at IS NULL
                  AND (p.pedido_id IS NULL OR ped.deleted_at IS NULL)
                ORDER BY p.fecha, i.nombre
            `, [req.restauranteId, `${anoActual}-${String(mesActual).padStart(2, '0')}-01`, `${mesActual === 12 ? anoActual + 1 : anoActual}-${String(mesActual === 12 ? 1 : mesActual + 1).padStart(2, '0')}-01`]);

            // Ventas diarias agrupadas por día y receta
            const ventasDiarias = await pool.query(`
                SELECT
                    DATE(v.fecha) as fecha,
                    r.id as receta_id,
                    r.nombre as receta,
                    r.ingredientes as receta_ingredientes,
                    r.porciones,
                    SUM(v.cantidad) as cantidad_vendida,
                    AVG(v.precio_unitario) as precio_venta_unitario,
                    SUM(v.total) as total_ingresos,
                    SUM(v.cantidad * COALESCE(v.factor_variante, 1)) as cantidad_ponderada
                FROM ventas v
                JOIN recetas r ON v.receta_id = r.id
                WHERE v.restaurante_id = $1 AND v.deleted_at IS NULL AND r.deleted_at IS NULL
                  AND v.fecha >= $2 AND v.fecha < $3
                GROUP BY DATE(v.fecha), r.id, r.nombre, r.ingredientes, r.porciones
                ORDER BY DATE(v.fecha), r.nombre
            `, [req.restauranteId, `${anoActual}-${String(mesActual).padStart(2, '0')}-01`, `${mesActual === 12 ? anoActual + 1 : anoActual}-${String(mesActual === 12 ? 1 : mesActual + 1).padStart(2, '0')}-01`]);

            // Precios de ingredientes (prioridad: precio_medio_compra > precio/cpf)
            const ingredientesPrecios = await pool.query(
                `SELECT i.id, i.precio, i.cantidad_por_formato, i.rendimiento,
                        pcd.precio_medio_compra
                 FROM ingredientes i
                 LEFT JOIN (
                     SELECT ingrediente_id, ROUND(AVG(precio_unitario)::numeric, 4) as precio_medio_compra
                     FROM precios_compra_diarios WHERE restaurante_id = $1
                     GROUP BY ingrediente_id
                 ) pcd ON pcd.ingrediente_id = i.id
                 WHERE i.restaurante_id = $1 AND i.deleted_at IS NULL`,
                [req.restauranteId]
            );
            const preciosMap = {};
            const rendimientoBaseMap = {};
            ingredientesPrecios.rows.forEach(ing => {
                if (ing.precio_medio_compra) {
                    preciosMap[ing.id] = parseFloat(ing.precio_medio_compra);
                } else {
                    const precio = parseFloat(ing.precio) || 0;
                    const cpf = parseFloat(ing.cantidad_por_formato) || 1;
                    preciosMap[ing.id] = precio / cpf;
                }
                if (ing.rendimiento) rendimientoBaseMap[ing.id] = parseFloat(ing.rendimiento);
            });

            // Función para calcular coste de una receta (Jack Miller con rendimiento + porciones)
            const calcularCosteReceta = (ingredientesReceta, porciones) => {
                if (!ingredientesReceta || !Array.isArray(ingredientesReceta)) return 0;
                const porcionesVal = Math.max(1, parseInt(porciones) || 1);
                const costeTotal = ingredientesReceta.reduce((sum, item) => {
                    const precio = preciosMap[item.ingredienteId] || 0;
                    const cantidad = parseFloat(item.cantidad) || 0;
                    let rendimiento = parseFloat(item.rendimiento);
                    if (!rendimiento) rendimiento = rendimientoBaseMap[item.ingredienteId] || 100;
                    const factorRendimiento = rendimiento / 100;
                    const costeReal = factorRendimiento > 0 ? (precio / factorRendimiento) : precio;
                    return sum + (costeReal * cantidad);
                }, 0);
                return costeTotal / porcionesVal;
            };

            // Agregación por ingrediente / receta / proveedor
            const ingredientesData = {};
            const recetasData = {};
            const diasSet = new Set();

            comprasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                diasSet.add(fechaStr);

                if (!ingredientesData[row.ingrediente]) {
                    ingredientesData[row.ingrediente] = { id: row.ingrediente_id, dias: {}, total: 0, totalCantidad: 0 };
                }

                if (!ingredientesData[row.ingrediente].dias[fechaStr]) {
                    ingredientesData[row.ingrediente].dias[fechaStr] = {
                        precio: parseFloat(row.precio_unitario),
                        cantidad: parseFloat(row.cantidad_comprada),
                        total: parseFloat(row.total_compra)
                    };
                } else {
                    // Acumular múltiples pedidos del mismo día
                    const existing = ingredientesData[row.ingrediente].dias[fechaStr];
                    existing.cantidad += parseFloat(row.cantidad_comprada);
                    existing.total += parseFloat(row.total_compra);
                    existing.precio = existing.cantidad > 0 ? existing.total / existing.cantidad : existing.precio;
                }
                ingredientesData[row.ingrediente].total += parseFloat(row.total_compra);
                ingredientesData[row.ingrediente].totalCantidad += parseFloat(row.cantidad_comprada);
            });

            const proveedoresData = {};
            comprasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                const provNombre = row.proveedor_nombre || 'Sin proveedor';
                if (!proveedoresData[provNombre]) {
                    proveedoresData[provNombre] = { id: row.proveedor_id, dias: {}, total: 0 };
                }
                if (!proveedoresData[provNombre].dias[fechaStr]) {
                    proveedoresData[provNombre].dias[fechaStr] = 0;
                }
                proveedoresData[provNombre].dias[fechaStr] += parseFloat(row.total_compra);
                proveedoresData[provNombre].total += parseFloat(row.total_compra);
            });

            ventasDiarias.rows.forEach(row => {
                const fechaStr = row.fecha.toISOString().split('T')[0];
                diasSet.add(fechaStr);

                const cantidadVendida = parseInt(row.cantidad_vendida);
                const totalIngresos = parseFloat(row.total_ingresos);

                // Coste ponderado por factor_variante (botella vs copa, etc.)
                const costePorUnidad = calcularCosteReceta(row.receta_ingredientes, row.porciones);
                const cantidadPonderada = parseFloat(row.cantidad_ponderada) || cantidadVendida;
                const costeTotal = costePorUnidad * cantidadPonderada;
                const beneficio = totalIngresos - costeTotal;

                if (!recetasData[row.receta]) {
                    recetasData[row.receta] = {
                        id: row.receta_id, dias: {},
                        totalVendidas: 0, totalIngresos: 0,
                        totalCoste: 0, totalBeneficio: 0
                    };
                }

                recetasData[row.receta].dias[fechaStr] = {
                    vendidas: cantidadVendida,
                    precioVenta: parseFloat(row.precio_venta_unitario),
                    coste: costeTotal,
                    ingresos: totalIngresos,
                    beneficio: beneficio
                };
                recetasData[row.receta].totalVendidas += cantidadVendida;
                recetasData[row.receta].totalIngresos += totalIngresos;
                recetasData[row.receta].totalCoste += costeTotal;
                recetasData[row.receta].totalBeneficio += beneficio;
            });

            const dias = Array.from(diasSet).sort();
            const totalesCompras = Object.values(ingredientesData).reduce((sum, i) => sum + i.total, 0);
            const totalesVentas = Object.values(recetasData).reduce((sum, r) => sum + r.totalIngresos, 0);
            const totalesCostes = Object.values(recetasData).reduce((sum, r) => sum + r.totalCoste, 0);
            const totalesBeneficio = Object.values(recetasData).reduce((sum, r) => sum + r.totalBeneficio, 0);

            res.json({
                mes: mesActual,
                ano: anoActual,
                dias,
                compras: {
                    ingredientes: ingredientesData,
                    porProveedor: proveedoresData,
                    total: totalesCompras
                },
                ventas: {
                    recetas: recetasData,
                    totalIngresos: totalesVentas,
                    totalCostes: totalesCostes,
                    beneficioBruto: totalesBeneficio
                },
                resumen: {
                    margenBruto: totalesVentas > 0 ? ((totalesBeneficio / totalesVentas) * 100).toFixed(1) : 0,
                    foodCost: totalesVentas > 0 ? ((totalesCostes / totalesVentas) * 100).toFixed(1) : 0
                }
            });
        } catch (err) {
            log('error', 'Error resumen mensual', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
