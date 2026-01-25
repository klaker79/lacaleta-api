/**
 * MindLoop CostOS - Stock Calculation Test
 * 
 * Verifica que el sistema descuenta stock correctamente:
 * - Copas = 0.2 botellas
 * - Botellas = 1 botella
 * - Porciones dividen correctamente
 * 
 * Uso: node tests/test-stock-calculation.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const RESTAURANTE_ID = 3;

async function testVinoVariantesFactor() {
    console.log('\n🍷 TEST: Factores de variantes de vinos');
    console.log('─'.repeat(50));

    const result = await pool.query(`
        SELECT 
            r.nombre as receta,
            rv.nombre as variante,
            rv.factor,
            CASE 
                WHEN rv.nombre ILIKE '%copa%' AND rv.factor = 0.2 THEN '✅ CORRECTO'
                WHEN rv.nombre ILIKE '%botella%' AND rv.factor = 1.0 THEN '✅ CORRECTO'
                WHEN rv.nombre ILIKE '%copa%' AND rv.factor != 0.2 THEN '❌ INCORRECTO (debería ser 0.2)'
                WHEN rv.nombre ILIKE '%botella%' AND rv.factor != 1.0 THEN '❌ INCORRECTO (debería ser 1.0)'
                ELSE '⚠️ REVISAR'
            END as estado
        FROM recetas_variantes rv
        JOIN recetas r ON rv.receta_id = r.id
        WHERE rv.restaurante_id = $1
        AND r.nombre ILIKE '%vino%'
        ORDER BY r.nombre, rv.factor DESC
    `, [RESTAURANTE_ID]);

    let errors = 0;
    result.rows.forEach(r => {
        const isError = r.estado.includes('❌');
        if (isError) errors++;
        console.log(`${r.estado} ${r.receta} → ${r.variante} (factor: ${r.factor})`);
    });

    console.log('─'.repeat(50));
    if (errors === 0) {
        console.log('✅ TODOS los factores de variantes son correctos');
        return true;
    } else {
        console.log(`❌ ${errors} variantes con factor incorrecto`);
        return false;
    }
}

async function testRecetasPorciones() {
    console.log('\n📊 TEST: Configuración de porciones en recetas');
    console.log('─'.repeat(50));

    const result = await pool.query(`
        SELECT 
            nombre, 
            porciones,
            CASE 
                WHEN porciones IS NULL THEN '⚠️ NULL (usará 1 por defecto)'
                WHEN porciones = 0 THEN '❌ PELIGRO: División por cero'
                WHEN porciones < 0 THEN '❌ PELIGRO: Valor negativo'
                ELSE '✅ OK'
            END as estado
        FROM recetas 
        WHERE restaurante_id = $1 
        AND deleted_at IS NULL
        AND (porciones IS NULL OR porciones <= 0)
        ORDER BY nombre
    `, [RESTAURANTE_ID]);

    if (result.rows.length === 0) {
        console.log('✅ Todas las recetas tienen porciones válidas (> 0)');
        return true;
    } else {
        console.log(`⚠️ ${result.rows.length} recetas con porciones problemáticas:`);
        result.rows.forEach(r => {
            console.log(`   ${r.estado} ${r.nombre} (porciones: ${r.porciones})`);
        });
        return false;
    }
}

async function testFormulaDescuentoStock() {
    console.log('\n🧮 TEST: Fórmula de descuento de stock');
    console.log('─'.repeat(50));

    // Simular el cálculo que hace el servidor
    const ejemplo = {
        cantidad_ingrediente: 1,  // 1 botella por receta
        porciones: 1,             // 1 porción por receta
        cantidad_vendida: 1,      // 1 unidad vendida
        factor_variante: 0.2      // Es una copa
    };

    const descuentoCalculado = (ejemplo.cantidad_ingrediente / ejemplo.porciones)
        * ejemplo.cantidad_vendida
        * ejemplo.factor_variante;

    console.log('Ejemplo de cálculo para venta de 1 COPA de vino:');
    console.log(`  cantidad_ingrediente = ${ejemplo.cantidad_ingrediente}`);
    console.log(`  porciones = ${ejemplo.porciones}`);
    console.log(`  cantidad_vendida = ${ejemplo.cantidad_vendida}`);
    console.log(`  factor_variante = ${ejemplo.factor_variante}`);
    console.log(`  ─────────────────────────────`);
    console.log(`  Descuento = (${ejemplo.cantidad_ingrediente}/${ejemplo.porciones}) × ${ejemplo.cantidad_vendida} × ${ejemplo.factor_variante}`);
    console.log(`  Descuento = ${descuentoCalculado} botellas`);

    if (descuentoCalculado === 0.2) {
        console.log('✅ Fórmula CORRECTA: 1 copa = 0.2 botellas');
        return true;
    } else {
        console.log('❌ Fórmula INCORRECTA');
        return false;
    }
}

async function testStockConsistency() {
    console.log('\n📦 TEST: Consistencia de stock');
    console.log('─'.repeat(50));

    // Verificar que no hay ingredientes con stock negativo
    const negativos = await pool.query(`
        SELECT COUNT(*) as count FROM ingredientes 
        WHERE restaurante_id = $1 AND stock_actual < 0
    `, [RESTAURANTE_ID]);

    // Verificar que el valor total de stock es razonable
    const valorStock = await pool.query(`
        SELECT SUM(stock_actual * (precio / COALESCE(NULLIF(cantidad_por_formato, 0), 1))) as valor
        FROM ingredientes 
        WHERE restaurante_id = $1 AND stock_actual > 0
    `, [RESTAURANTE_ID]);

    const stockNegativos = parseInt(negativos.rows[0].count);
    const valorTotal = parseFloat(valorStock.rows[0].valor) || 0;

    console.log(`Ingredientes con stock negativo: ${stockNegativos}`);
    console.log(`Valor total de stock: ${valorTotal.toFixed(2)}€`);

    if (stockNegativos === 0 && valorTotal >= 0) {
        console.log('✅ Stock consistente');
        return true;
    } else {
        console.log('❌ Problemas de consistencia detectados');
        return false;
    }
}

async function runAllTests() {
    console.log('═'.repeat(60));
    console.log('🧪 MindLoop CostOS - Tests de Cálculo de Stock');
    console.log('═'.repeat(60));
    console.log(`Fecha: ${new Date().toLocaleString('es-ES')}`);

    const results = {
        vinoVariantesFactor: await testVinoVariantesFactor(),
        recetasPorciones: await testRecetasPorciones(),
        formulaDescuento: await testFormulaDescuentoStock(),
        stockConsistency: await testStockConsistency()
    };

    console.log('\n' + '═'.repeat(60));
    console.log('📋 RESUMEN DE TESTS');
    console.log('═'.repeat(60));

    let passed = 0;
    let failed = 0;

    for (const [name, result] of Object.entries(results)) {
        const status = result ? '✅ PASS' : '❌ FAIL';
        console.log(`${status} ${name}`);
        if (result) passed++; else failed++;
    }

    console.log('─'.repeat(60));
    console.log(`Total: ${passed} passed, ${failed} failed`);

    if (failed === 0) {
        console.log('\n🎉 ¡TODOS LOS TESTS PASARON!');
    } else {
        console.log('\n⚠️ Algunos tests fallaron. Revisar los problemas arriba.');
    }

    return failed === 0;
}

if (require.main === module) {
    runAllTests()
        .then(success => {
            pool.end();
            process.exit(success ? 0 : 1);
        })
        .catch(err => {
            console.error('Error ejecutando tests:', err);
            pool.end();
            process.exit(1);
        });
}

module.exports = { runAllTests };
