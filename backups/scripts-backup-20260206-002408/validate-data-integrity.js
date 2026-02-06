/**
 * MindLoop CostOS - Data Integrity Validator
 * 
 * Este script verifica la integridad de los datos sin modificar nada.
 * Detecta problemas potenciales antes de que causen errores en producción.
 * 
 * Uso: node scripts/validate-data-integrity.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const RESTAURANTE_ID = 3; // La Caleta

// Colores para consola
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

function log(type, message, data = null) {
    const emoji = {
        ok: '✅',
        warn: '⚠️',
        error: '❌',
        info: 'ℹ️'
    };
    const color = {
        ok: colors.green,
        warn: colors.yellow,
        error: colors.red,
        info: colors.blue
    };
    console.log(`${color[type]}${emoji[type]} ${message}${colors.reset}`);
    if (data) console.log(data);
}

async function validateRecetasSinIngredientes() {
    console.log('\n📋 Verificando recetas sin ingredientes...');

    const result = await pool.query(`
        SELECT id, nombre, ingredientes::text
        FROM recetas 
        WHERE restaurante_id = $1 
        AND deleted_at IS NULL
        AND (ingredientes IS NULL OR ingredientes::text = '[]' OR ingredientes::text = 'null')
        ORDER BY nombre
    `, [RESTAURANTE_ID]);

    if (result.rows.length === 0) {
        log('ok', 'Todas las recetas tienen ingredientes vinculados');
        return { passed: true, issues: [] };
    } else {
        log('warn', `${result.rows.length} recetas SIN ingredientes:`);
        result.rows.forEach(r => console.log(`   - [${r.id}] ${r.nombre}`));
        return { passed: false, issues: result.rows };
    }
}

async function validateStockNegativo() {
    console.log('\n📦 Verificando stock negativo...');

    const result = await pool.query(`
        SELECT id, nombre, stock_actual, unidad
        FROM ingredientes 
        WHERE restaurante_id = $1 
        AND stock_actual < 0
        ORDER BY stock_actual
    `, [RESTAURANTE_ID]);

    if (result.rows.length === 0) {
        log('ok', 'No hay ingredientes con stock negativo');
        return { passed: true, issues: [] };
    } else {
        log('error', `${result.rows.length} ingredientes con stock NEGATIVO:`);
        result.rows.forEach(r => console.log(`   - ${r.nombre}: ${r.stock_actual} ${r.unidad}`));
        return { passed: false, issues: result.rows };
    }
}

async function validateVariantesSinFactor() {
    console.log('\n🏷️ Verificando variantes sin factor...');

    const result = await pool.query(`
        SELECT rv.id, rv.nombre, rv.factor, r.nombre as receta_nombre
        FROM recetas_variantes rv
        JOIN recetas r ON rv.receta_id = r.id
        WHERE rv.restaurante_id = $1 
        AND (rv.factor IS NULL OR rv.factor = 0)
    `, [RESTAURANTE_ID]);

    if (result.rows.length === 0) {
        log('ok', 'Todas las variantes tienen factor válido');
        return { passed: true, issues: [] };
    } else {
        log('warn', `${result.rows.length} variantes sin factor válido:`);
        result.rows.forEach(r => console.log(`   - ${r.receta_nombre} → ${r.nombre} (factor: ${r.factor})`));
        return { passed: false, issues: result.rows };
    }
}

async function validateIngredientesHuerfanos() {
    console.log('\n🔗 Verificando ingredientes huérfanos en recetas...');

    const result = await pool.query(`
        SELECT r.id as receta_id, r.nombre as receta_nombre, 
               (ing->>'ingredienteId')::int as ingrediente_id_referenciado
        FROM recetas r,
             jsonb_array_elements(r.ingredientes) as ing
        WHERE r.restaurante_id = $1 
        AND r.deleted_at IS NULL
        AND NOT EXISTS (
            SELECT 1 FROM ingredientes i 
            WHERE i.id = (ing->>'ingredienteId')::int
        )
    `, [RESTAURANTE_ID]);

    if (result.rows.length === 0) {
        log('ok', 'Todos los ingredientes referenciados existen');
        return { passed: true, issues: [] };
    } else {
        log('error', `${result.rows.length} referencias a ingredientes inexistentes:`);
        result.rows.forEach(r => console.log(`   - ${r.receta_nombre} referencia ingrediente ID ${r.ingrediente_id_referenciado}`));
        return { passed: false, issues: result.rows };
    }
}

async function validateVinosConIngredientes() {
    console.log('\n🍷 Verificando que TODOS los vinos tengan ingrediente...');

    const result = await pool.query(`
        SELECT r.id, r.nombre,
               CASE 
                   WHEN r.ingredientes IS NULL THEN 'SIN INGREDIENTES (NULL)'
                   WHEN r.ingredientes::text = '[]' THEN 'ARRAY VACÍO'
                   WHEN r.ingredientes::text = 'null' THEN 'NULL STRING'
                   ELSE 'OK'
               END as estado
        FROM recetas r
        WHERE r.restaurante_id = $1 
        AND r.deleted_at IS NULL
        AND r.nombre ILIKE '%vino%'
        AND (r.ingredientes IS NULL OR r.ingredientes::text = '[]' OR r.ingredientes::text = 'null')
        ORDER BY r.nombre
    `, [RESTAURANTE_ID]);

    if (result.rows.length === 0) {
        log('ok', 'Todos los vinos tienen ingredientes correctamente vinculados');
        return { passed: true, issues: [] };
    } else {
        log('error', `${result.rows.length} vinos SIN ingrediente:`);
        result.rows.forEach(r => console.log(`   - [${r.id}] ${r.nombre}: ${r.estado}`));
        return { passed: false, issues: result.rows };
    }
}

async function validateCoherenciaKPIs() {
    console.log('\n📊 Verificando coherencia de KPIs...');

    // Verificar valor stock calculado
    const stockValue = await pool.query(`
        SELECT 
            SUM(stock_actual * (precio / COALESCE(NULLIF(cantidad_por_formato, 0), 1))) as valor_calculado,
            COUNT(*) as items_con_stock
        FROM ingredientes 
        WHERE restaurante_id = $1 AND stock_actual > 0
    `, [RESTAURANTE_ID]);

    const valor = parseFloat(stockValue.rows[0].valor_calculado) || 0;
    const items = parseInt(stockValue.rows[0].items_con_stock) || 0;

    log('info', `Valor Stock Total: ${valor.toFixed(2)}€ (${items} items con stock)`);

    if (valor < 0) {
        log('error', 'El valor de stock no puede ser negativo');
        return { passed: false, issues: [{ valor, items }] };
    }

    return { passed: true, issues: [] };
}

async function runAllValidations() {
    console.log('═'.repeat(60));
    console.log('🔍 MindLoop CostOS - Validación de Integridad de Datos');
    console.log('═'.repeat(60));
    console.log(`Fecha: ${new Date().toLocaleString('es-ES')}`);
    console.log(`Restaurante ID: ${RESTAURANTE_ID}`);

    const results = {
        recetasSinIngredientes: await validateRecetasSinIngredientes(),
        stockNegativo: await validateStockNegativo(),
        variantesSinFactor: await validateVariantesSinFactor(),
        ingredientesHuerfanos: await validateIngredientesHuerfanos(),
        vinosConIngredientes: await validateVinosConIngredientes(),
        coherenciaKPIs: await validateCoherenciaKPIs()
    };

    console.log('\n' + '═'.repeat(60));
    console.log('📋 RESUMEN DE VALIDACIÓN');
    console.log('═'.repeat(60));

    let totalIssues = 0;
    for (const [name, result] of Object.entries(results)) {
        const status = result.passed ? '✅ OK' : `❌ ${result.issues.length} problemas`;
        console.log(`${name}: ${status}`);
        totalIssues += result.issues.length;
    }

    console.log('─'.repeat(60));
    if (totalIssues === 0) {
        log('ok', '¡TODOS LOS TESTS PASARON! El sistema está en buen estado.');
    } else {
        log('warn', `Se encontraron ${totalIssues} problemas que requieren atención.`);
    }

    return results;
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    runAllValidations()
        .then(() => {
            pool.end();
            process.exit(0);
        })
        .catch(err => {
            console.error('Error ejecutando validaciones:', err);
            pool.end();
            process.exit(1);
        });
}

module.exports = { runAllValidations };
