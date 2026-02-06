/**
 * MindLoop CostOS - Daily Health Check
 * 
 * Script para ejecutar cada día (o antes de importar ventas)
 * Verifica que el sistema está en buen estado.
 * 
 * Uso: node scripts/daily-health-check.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const RESTAURANTE_ID = 3;

async function checkDatabaseConnection() {
    try {
        await pool.query('SELECT 1');
        return { ok: true, message: 'Conexión a base de datos OK' };
    } catch (err) {
        return { ok: false, message: 'Error de conexión: ' + err.message };
    }
}

async function checkCriticalTables() {
    const tables = ['ingredientes', 'recetas', 'recetas_variantes', 'ventas', 'pedidos'];
    const results = [];

    for (const table of tables) {
        try {
            const result = await pool.query(`SELECT COUNT(*) as count FROM ${table} WHERE restaurante_id = $1`, [RESTAURANTE_ID]);
            results.push({ table, count: parseInt(result.rows[0].count), ok: true });
        } catch (err) {
            results.push({ table, count: 0, ok: false, error: err.message });
        }
    }

    return results;
}

async function checkStockAlerts() {
    // Ingredientes con stock bajo o negativo
    const result = await pool.query(`
        SELECT nombre, stock_actual, stock_minimo, unidad,
               CASE 
                   WHEN stock_actual < 0 THEN 'NEGATIVO'
                   WHEN stock_minimo IS NOT NULL AND stock_actual <= stock_minimo THEN 'BAJO'
                   ELSE 'OK'
               END as estado
        FROM ingredientes 
        WHERE restaurante_id = $1 
        AND (stock_actual < 0 OR (stock_minimo IS NOT NULL AND stock_actual <= stock_minimo))
        ORDER BY stock_actual
    `, [RESTAURANTE_ID]);

    return result.rows;
}

async function checkRecetasIntegrity() {
    // Recetas sin ingredientes
    const result = await pool.query(`
        SELECT id, nombre
        FROM recetas 
        WHERE restaurante_id = $1 
        AND deleted_at IS NULL
        AND (ingredientes IS NULL OR ingredientes::text = '[]')
    `, [RESTAURANTE_ID]);

    return result.rows;
}

async function checkVentasHoy() {
    const today = new Date().toISOString().split('T')[0];

    const result = await pool.query(`
        SELECT 
            COUNT(*) as num_ventas,
            COALESCE(SUM(total), 0) as total_ventas
        FROM ventas 
        WHERE restaurante_id = $1 
        AND fecha::date = $2
        AND deleted_at IS NULL
    `, [RESTAURANTE_ID, today]);

    return {
        fecha: today,
        num_ventas: parseInt(result.rows[0].num_ventas),
        total_ventas: parseFloat(result.rows[0].total_ventas)
    };
}

async function checkValorStock() {
    const result = await pool.query(`
        SELECT 
            SUM(stock_actual * (precio / COALESCE(NULLIF(cantidad_por_formato, 0), 1))) as valor_total,
            COUNT(*) as items_con_stock
        FROM ingredientes 
        WHERE restaurante_id = $1 AND stock_actual > 0
    `, [RESTAURANTE_ID]);

    return {
        valor_total: parseFloat(result.rows[0].valor_total) || 0,
        items_con_stock: parseInt(result.rows[0].items_con_stock)
    };
}

async function runHealthCheck() {
    const timestamp = new Date().toLocaleString('es-ES');

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         🏥 MINDLOOP COSTOS - HEALTH CHECK DIARIO          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`📅 Fecha/Hora: ${timestamp}`);
    console.log(`🏠 Restaurante ID: ${RESTAURANTE_ID}`);
    console.log('');

    // 1. Conexión
    console.log('─── 1. CONEXIÓN ───────────────────────────────────────────');
    const dbCheck = await checkDatabaseConnection();
    console.log(dbCheck.ok ? `✅ ${dbCheck.message}` : `❌ ${dbCheck.message}`);

    if (!dbCheck.ok) {
        console.log('\n❌ HEALTH CHECK FALLIDO - No hay conexión a la base de datos');
        return false;
    }

    // 2. Tablas críticas
    console.log('\n─── 2. TABLAS CRÍTICAS ────────────────────────────────────');
    const tables = await checkCriticalTables();
    tables.forEach(t => {
        console.log(t.ok ? `✅ ${t.table}: ${t.count} registros` : `❌ ${t.table}: ERROR`);
    });

    // 3. Stock
    console.log('\n─── 3. VALOR DE STOCK ─────────────────────────────────────');
    const stock = await checkValorStock();
    console.log(`📦 Valor total: ${stock.valor_total.toFixed(2)}€`);
    console.log(`📊 Items con stock: ${stock.items_con_stock}`);

    // 4. Alertas de stock
    console.log('\n─── 4. ALERTAS DE STOCK ───────────────────────────────────');
    const alertas = await checkStockAlerts();
    if (alertas.length === 0) {
        console.log('✅ No hay alertas de stock');
    } else {
        const negativos = alertas.filter(a => a.estado === 'NEGATIVO');
        const bajos = alertas.filter(a => a.estado === 'BAJO');

        if (negativos.length > 0) {
            console.log(`❌ ${negativos.length} ingredientes con stock NEGATIVO:`);
            negativos.slice(0, 5).forEach(a => console.log(`   • ${a.nombre}: ${a.stock_actual} ${a.unidad}`));
            if (negativos.length > 5) console.log(`   ... y ${negativos.length - 5} más`);
        }
        if (bajos.length > 0) {
            console.log(`⚠️ ${bajos.length} ingredientes con stock BAJO`);
        }
    }

    // 5. Recetas sin ingredientes
    console.log('\n─── 5. INTEGRIDAD DE RECETAS ──────────────────────────────');
    const recetasSinIng = await checkRecetasIntegrity();
    if (recetasSinIng.length === 0) {
        console.log('✅ Todas las recetas tienen ingredientes');
    } else {
        console.log(`⚠️ ${recetasSinIng.length} recetas sin ingredientes:`);
        recetasSinIng.slice(0, 5).forEach(r => console.log(`   • [${r.id}] ${r.nombre}`));
        if (recetasSinIng.length > 5) console.log(`   ... y ${recetasSinIng.length - 5} más`);
    }

    // 6. Ventas hoy
    console.log('\n─── 6. VENTAS DE HOY ──────────────────────────────────────');
    const ventas = await checkVentasHoy();
    console.log(`📅 Fecha: ${ventas.fecha}`);
    console.log(`🧾 Ventas registradas: ${ventas.num_ventas}`);
    console.log(`💰 Total: ${ventas.total_ventas.toFixed(2)}€`);

    // Resumen
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    const hasProblems = alertas.some(a => a.estado === 'NEGATIVO') || recetasSinIng.length > 0;
    if (hasProblems) {
        console.log('║  ⚠️  ATENCIÓN: Se detectaron algunos problemas menores     ║');
    } else {
        console.log('║  ✅  SISTEMA EN BUEN ESTADO                                ║');
    }
    console.log('╚════════════════════════════════════════════════════════════╝');

    return !hasProblems;
}

if (require.main === module) {
    runHealthCheck()
        .then(success => {
            pool.end();
            process.exit(success ? 0 : 1);
        })
        .catch(err => {
            console.error('Error en health check:', err);
            pool.end();
            process.exit(1);
        });
}

module.exports = { runHealthCheck };
