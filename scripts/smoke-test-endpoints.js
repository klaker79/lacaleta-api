#!/usr/bin/env node
/**
 * 🧪 Smoke Test - Validación de Endpoints
 * 
 * Verifica que TODOS los endpoints del backend existen.
 * Un endpoint "existe" si NO devuelve 404.
 * 
 * USO:
 *   TEST_TOKEN=<token> API_URL=http://localhost:3000 node scripts/smoke-test-endpoints.js
 *   
 * O para producción:
 *   TEST_TOKEN=<token> API_URL=https://lacaleta-api.mindloop.cloud node scripts/smoke-test-endpoints.js
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const TEST_TOKEN = process.env.TEST_TOKEN || '';

// Colores para output
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m',
    bold: '\x1b[1m'
};

/**
 * Test un endpoint - devuelve true si NO es 404
 */
async function testEndpoint(method, path) {
    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': TEST_TOKEN ? `Bearer ${TEST_TOKEN}` : ''
            }
        });
        
        // 404 = endpoint no existe = FALLO
        // Cualquier otro código = endpoint existe = OK
        return {
            path,
            method,
            status: response.status,
            exists: response.status !== 404
        };
    } catch (error) {
        return { 
            path, 
            method, 
            status: 'ERROR', 
            exists: false, 
            error: error.message 
        };
    }
}

// Lista completa de endpoints del legacy server.js
const ENDPOINTS = [
    // Health
    { method: 'GET', path: '/api/health' },
    
    // Auth
    { method: 'POST', path: '/api/auth/login' },
    { method: 'POST', path: '/api/auth/logout' },
    { method: 'GET', path: '/api/auth/verify' },
    { method: 'POST', path: '/api/auth/refresh' },
    { method: 'POST', path: '/api/auth/api-token' },
    
    // Ingredients
    { method: 'GET', path: '/api/ingredients' },
    { method: 'POST', path: '/api/ingredients' },
    { method: 'GET', path: '/api/ingredients/1' },
    { method: 'PUT', path: '/api/ingredients/1' },
    { method: 'DELETE', path: '/api/ingredients/1' },
    { method: 'PATCH', path: '/api/ingredients/1/toggle-active' },
    { method: 'GET', path: '/api/ingredients/1/suppliers' },
    { method: 'POST', path: '/api/ingredients/1/suppliers' },
    
    // Recipes
    { method: 'GET', path: '/api/recipes' },
    { method: 'POST', path: '/api/recipes' },
    { method: 'GET', path: '/api/recipes/1' },
    { method: 'PUT', path: '/api/recipes/1' },
    { method: 'DELETE', path: '/api/recipes/1' },
    { method: 'GET', path: '/api/recipes-variants' },
    
    // Suppliers
    { method: 'GET', path: '/api/suppliers' },
    { method: 'POST', path: '/api/suppliers' },
    { method: 'GET', path: '/api/suppliers/1' },
    { method: 'PUT', path: '/api/suppliers/1' },
    { method: 'DELETE', path: '/api/suppliers/1' },
    
    // Orders
    { method: 'GET', path: '/api/orders' },
    { method: 'POST', path: '/api/orders' },
    { method: 'GET', path: '/api/orders/1' },
    { method: 'PUT', path: '/api/orders/1' },
    { method: 'DELETE', path: '/api/orders/1' },
    
    // Sales
    { method: 'GET', path: '/api/sales' },
    { method: 'POST', path: '/api/sales' },
    { method: 'DELETE', path: '/api/sales/1' },
    { method: 'POST', path: '/api/sales/bulk' },
    
    // Inventory
    { method: 'GET', path: '/api/inventory/complete' },
    { method: 'PUT', path: '/api/inventory/1/stock-real' },
    { method: 'PUT', path: '/api/inventory/bulk-update-stock' },
    
    // Empleados
    { method: 'GET', path: '/api/empleados' },
    { method: 'POST', path: '/api/empleados' },
    { method: 'PUT', path: '/api/empleados/1' },
    { method: 'DELETE', path: '/api/empleados/1' },
    
    // Horarios
    { method: 'GET', path: '/api/horarios' },
    { method: 'POST', path: '/api/horarios' },
    { method: 'DELETE', path: '/api/horarios/all' },
    { method: 'DELETE', path: '/api/horarios/empleado/1/fecha/2026-01-28' },
    { method: 'POST', path: '/api/horarios/copiar-semana' },
    
    // Intelligence
    { method: 'GET', path: '/api/intelligence/freshness' },
    { method: 'GET', path: '/api/intelligence/price-check' },
    { method: 'GET', path: '/api/intelligence/waste-stats' },
    { method: 'GET', path: '/api/intelligence/purchase-plan' },
    { method: 'GET', path: '/api/intelligence/overstock' },
    
    // Analytics / Balance
    { method: 'GET', path: '/api/analysis/menu-engineering' },
    { method: 'GET', path: '/api/balance/mes' },
    { method: 'GET', path: '/api/balance/comparativa' },
    { method: 'GET', path: '/api/monthly/summary' },
    
    // Daily
    { method: 'GET', path: '/api/daily/purchases' },
    { method: 'GET', path: '/api/daily/sales' },
    { method: 'POST', path: '/api/daily/purchases/bulk' },
    
    // Gastos Fijos
    { method: 'GET', path: '/api/gastos-fijos' },
    { method: 'POST', path: '/api/gastos-fijos' },
    { method: 'PUT', path: '/api/gastos-fijos/1' },
    { method: 'DELETE', path: '/api/gastos-fijos/1' },
    
    // Mermas
    { method: 'GET', path: '/api/mermas' },
    { method: 'POST', path: '/api/mermas' },
    { method: 'DELETE', path: '/api/mermas/1' },
    
    // Team
    { method: 'GET', path: '/api/team' },
    { method: 'POST', path: '/api/team/invite' },
    
    // Utils
    { method: 'POST', path: '/api/parse-pdf' },
    { method: 'GET', path: '/api/ingredients-suppliers' },
];

async function runTests() {
    console.log(`\n${colors.bold}🧪 SMOKE TEST - Validación de Endpoints${colors.reset}`);
    console.log(`${'='.repeat(50)}`);
    console.log(`API URL: ${BASE_URL}`);
    console.log(`Token: ${TEST_TOKEN ? '✓ Configurado' : '✗ No configurado (algunos tests fallarán con 401)'}`);
    console.log(`Total endpoints: ${ENDPOINTS.length}`);
    console.log(`${'='.repeat(50)}\n`);
    
    let passed = 0;
    let failed = 0;
    const failures = [];
    
    for (const endpoint of ENDPOINTS) {
        const result = await testEndpoint(endpoint.method, endpoint.path);
        
        if (result.exists) {
            console.log(`${colors.green}✓${colors.reset} ${endpoint.method.padEnd(7)} ${endpoint.path} (${result.status})`);
            passed++;
        } else {
            console.log(`${colors.red}✗${colors.reset} ${endpoint.method.padEnd(7)} ${endpoint.path} (${result.status})`);
            failed++;
            failures.push(result);
        }
    }
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`${colors.bold}RESULTADOS:${colors.reset}`);
    console.log(`  ${colors.green}✓ Pasaron: ${passed}${colors.reset}`);
    console.log(`  ${colors.red}✗ Fallaron: ${failed}${colors.reset}`);
    console.log(`${'='.repeat(50)}`);
    
    if (failed > 0) {
        console.log(`\n${colors.red}${colors.bold}❌ HAY ENDPOINTS FALTANTES - NO DESPLEGAR${colors.reset}\n`);
        console.log('Endpoints que fallan:');
        failures.forEach(f => {
            console.log(`  - ${f.method} ${f.path} (${f.status})`);
        });
        process.exit(1);
    } else {
        console.log(`\n${colors.green}${colors.bold}✅ TODOS LOS ENDPOINTS EXISTEN - OK PARA DESPLEGAR${colors.reset}\n`);
        process.exit(0);
    }
}

// Ejecutar tests
runTests().catch(err => {
    console.error('Error ejecutando tests:', err);
    process.exit(1);
});
