#!/usr/bin/env node
/**
 * extract-routes.js — Reads server.js and extracts route handlers into separate modules.
 * 
 * Strategy:
 *   1. Read server.js
 *   2. Copy lines belonging to each route section into domain-specific route files
 *   3. Wrap each in an Express Router factory function
 *   4. Generate a new server.js that requires and mounts each router
 *
 * This is a one-shot migration script, NOT a permanent part of the codebase.
 */
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');

// Ensure routes directory exists
if (!fs.existsSync(ROUTES_DIR)) {
    fs.mkdirSync(ROUTES_DIR, { recursive: true });
}

const lines = fs.readFileSync(SERVER_PATH, 'utf8').split('\n');

// ────────────────────────────────────────────
// SECTION DEFINITIONS — line ranges (1-indexed, inclusive)
// ────────────────────────────────────────────
const sections = [
    // Auth is already extracted manually — skip
    {
        name: 'ingredients',
        file: 'ingredients.routes.js',
        startLine: 1314,
        endLine: 1925,
        mountPath: '/api',
        description: 'Ingredients CRUD, match, stock adjustment, toggle, ingredient-supplier associations'
    },
    {
        name: 'recipes',
        file: 'recipes.routes.js',
        startLine: 1927,  // Variants start here
        endLine: 2520,
        mountPath: '/api',
        description: 'Recipes CRUD & recipe variants (bottle/glass)'
    },
    {
        name: 'inventory',
        file: 'inventory.routes.js',
        startLine: 2049,
        endLine: 2350,
        mountPath: '/api',
        description: 'Advanced inventory: complete view, stock real updates, bulk updates, health check, consolidation'
    },
    {
        name: 'analysis',
        file: 'analysis.routes.js',
        startLine: 2351,
        endLine: 2457,
        mountPath: '/api',
        description: 'Menu engineering analysis (BCG matrix)'
    },
    {
        name: 'orders',
        file: 'orders.routes.js',
        startLine: 2532,
        endLine: 2810,
        mountPath: '/api',
        description: 'Orders CRUD with daily purchase tracking & stock rollback on delete'
    },
    {
        name: 'sales',
        file: 'sales.routes.js',
        startLine: 2812,
        endLine: 3447,
        mountPath: '/api',
        description: 'Sales CRUD, PDF parsing (Claude), bulk import with stock deduction'
    },
    {
        name: 'staff',
        file: 'staff.routes.js',
        startLine: 3448,
        endLine: 3665,
        mountPath: '/api',
        description: 'Staff management & scheduling'
    },
    {
        name: 'gastos',
        file: 'gastos.routes.js',
        startLine: 3666,
        endLine: 3747,
        mountPath: '/api',
        description: 'Fixed expenses (gastos fijos) CRUD'
    },
    {
        name: 'balance',
        file: 'balance.routes.js',
        startLine: 3748,
        endLine: 4623,
        mountPath: '/api',
        description: 'Balance, statistics, daily cost/sales tracking'
    },
    {
        name: 'intelligence',
        file: 'intelligence.routes.js',
        startLine: 4624,
        endLine: 4885,
        mountPath: '/api',
        description: 'AI Intelligence: freshness, purchase planning, overstock detection, price review'
    },
    {
        name: 'mermas',
        file: 'mermas.routes.js',
        startLine: 4886,
        endLine: 5241,
        mountPath: '/api',
        description: 'Waste (mermas) tracking: register, intelligence, history, monthly summary, delete, monthly reset'
    },
    {
        name: 'system',
        file: 'system.routes.js',
        startLine: 5242,
        endLine: 5406,
        mountPath: '/api',
        description: 'Health check, 404 handler, backup endpoint'
    }
];

// ────────────────────────────────────────────
// Helper: Determine what external deps each section uses
// ────────────────────────────────────────────
function analyzeSection(code) {
    const deps = new Set();

    if (code.includes('authMiddleware')) deps.add('authMiddleware');
    if (code.includes('requireAdmin')) deps.add('requireAdmin');
    if (code.includes('authLimiter')) deps.add('authLimiter');
    if (code.includes('costlyApiLimiter')) deps.add('costlyApiLimiter');
    if (/\blog\(/.test(code)) deps.add('log');
    if (code.includes('validatePrecio')) deps.add('validatePrecio');
    if (code.includes('validateCantidad')) deps.add('validateCantidad');
    if (code.includes('validateNumber')) deps.add('validateNumber');
    if (code.includes('upsertCompraDiaria')) deps.add('upsertCompraDiaria');
    if (code.includes('SupplierController')) deps.add('SupplierController');
    if (code.includes('bcrypt')) deps.add('bcrypt');
    if (code.includes('jwt')) deps.add('jwt');
    if (code.includes('crypto')) deps.add('crypto');
    if (code.includes('Sentry')) deps.add('Sentry');

    return deps;
}

function buildImports(deps) {
    const imports = [];
    imports.push("const { Router } = require('express');");

    // Auth middleware
    const authDeps = [];
    if (deps.has('authMiddleware')) authDeps.push('authMiddleware');
    if (deps.has('requireAdmin')) authDeps.push('requireAdmin');
    if (authDeps.length > 0) {
        imports.push(`const { ${authDeps.join(', ')} } = require('../middleware/auth');`);
    }

    // Rate limiters
    const limitDeps = [];
    if (deps.has('authLimiter')) limitDeps.push('authLimiter');
    if (deps.has('costlyApiLimiter')) limitDeps.push('costlyApiLimiter');
    if (limitDeps.length > 0) {
        imports.push(`const { ${limitDeps.join(', ')} } = require('../middleware/rateLimit');`);
    }

    // Logger
    if (deps.has('log')) {
        imports.push("const { log } = require('../utils/logger');");
    }

    // Validators
    const valDeps = [];
    if (deps.has('validatePrecio')) valDeps.push('validatePrecio');
    if (deps.has('validateCantidad')) valDeps.push('validateCantidad');
    if (deps.has('validateNumber')) valDeps.push('validateNumber');
    if (valDeps.length > 0) {
        imports.push(`const { ${valDeps.join(', ')} } = require('../utils/validators');`);
    }

    // Crypto/bcrypt/jwt
    if (deps.has('bcrypt')) imports.push("const bcrypt = require('bcryptjs');");
    if (deps.has('jwt')) imports.push("const jwt = require('jsonwebtoken');");
    if (deps.has('crypto')) imports.push("const crypto = require('crypto');");

    // Helpers
    if (deps.has('upsertCompraDiaria')) {
        imports.push("const { upsertCompraDiaria } = require('../utils/helpers');");
    }

    // Controllers
    if (deps.has('SupplierController')) {
        imports.push("const SupplierController = require('../controllers/supplier.controller');");
    }

    if (deps.has('Sentry')) {
        imports.push("const Sentry = require('@sentry/node');");
    }

    return imports.join('\n');
}

// ────────────────────────────────────────────
// EXTRACT EACH SECTION
// ────────────────────────────────────────────
console.log('🔧 Extracting routes from server.js...\n');

for (const section of sections) {
    // 0-indexed
    const code = lines.slice(section.startLine - 1, section.endLine).join('\n');

    // Replace app.verb -> router.verb
    const routerCode = code
        .replace(/^app\.(get|post|put|delete|patch)\('/gm, "router.$1('/")
        .replace(/^app\.(get|post|put|delete|patch)\((`|")/gm, "router.$1($2");

    // Remove /api prefix from route paths (since we mount at /api)
    const cleanCode = routerCode.replace(
        /router\.(get|post|put|delete|patch)\(['"`]\/api\//gm,
        "router.$1('/"
    );

    const deps = analyzeSection(code);
    const imports = buildImports(deps);

    // Build file content
    const needsPool = code.includes('pool.');
    const needsUpsert = deps.has('upsertCompraDiaria');

    let factoryParams = 'pool';
    let factoryParamsDoc = '@param {Pool} pool - PostgreSQL connection pool';

    const fileContent = `/**
 * ${section.name} Routes — Extracted from server.js
 * ${section.description}
 */
${imports}

/**
 * ${factoryParamsDoc}
 */
module.exports = function(${factoryParams}) {
    const router = Router();

${cleanCode}

    return router;
};
`;

    const filePath = path.join(ROUTES_DIR, section.file);

    // Don't overwrite if already exists
    if (fs.existsSync(filePath)) {
        console.log(`⏭️  ${section.file} already exists, skipping`);
        continue;
    }

    fs.writeFileSync(filePath, fileContent, 'utf8');
    const lineCount = fileContent.split('\n').length;
    console.log(`✅ ${section.file} (${lineCount} lines, ${deps.size} deps)`);
}

// ────────────────────────────────────────────
// GENERATE src/routes/index.js (central registry)
// ────────────────────────────────────────────
const indexContent = `/**
 * Route Registry — Central mounting point for all domain routes
 * Generated by extract-routes.js
 */
module.exports = function(app, pool) {
    const config = {
        resend: require('../config').resend,          // Only used by auth
        JWT_SECRET: process.env.JWT_SECRET,
        INVITATION_CODE: process.env.INVITATION_CODE
    };

    // Auth routes (manually extracted, includes team management)
    app.use('/api/auth', require('./auth.routes')(pool, config));

    // Domain routes (auto-extracted)
${sections.map(s => `    app.use('${s.mountPath}', require('./${s.file}')(pool));`).join('\n')}
};
`;

// Don't write index.js yet — we need to verify the structure first
console.log('\n📋 Route Registry (would go in src/routes/index.js):');
console.log('─'.repeat(60));
console.log(indexContent);
console.log('─'.repeat(60));

// Compute stats
const totalExtracted = sections.reduce((sum, s) => sum + (s.endLine - s.startLine + 1), 0);
const authLines = 1245 - 755 + 1; // already done
console.log(`\n📊 Stats:`);
console.log(`   Total route lines in server.js: ~${totalExtracted + authLines}`);
console.log(`   Auth (already extracted): ${authLines} lines`);
console.log(`   Remaining extracted: ${totalExtracted} lines across ${sections.length} files`);
console.log(`   server.js will shrink by ~${totalExtracted + authLines} lines (from ${lines.length} to ~${lines.length - totalExtracted - authLines})`);

console.log('\n✅ Done. Review generated files in src/routes/');
