#!/usr/bin/env node
/**
 * ============================================
 * benchmark.js — API Performance Benchmark
 * ============================================
 *
 * Measures: response time (ms), response size (bytes), record count
 * Target: all endpoints < 500ms
 * Load test: 20 concurrent requests
 *
 * Usage: node tests/benchmark.js
 *
 * @author MindLoopIA
 * @date 2026-02-13
 */

const http = require('http');
const https = require('https');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const TEST_EMAIL = process.env.TEST_USER_EMAIL || 'test@test.com';
const TEST_PASS = process.env.TEST_USER_PASSWORD || 'test123';

// ── Helpers ──────────────────────────────────────────────

function request(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_URL);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://localhost:3001',
            },
        };

        if (token) options.headers['Authorization'] = `Bearer ${token}`;

        const start = process.hrtime.bigint();
        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
                const buffer = Buffer.concat(chunks);
                let parsed;
                try { parsed = JSON.parse(buffer.toString()); } catch { parsed = null; }
                resolve({
                    status: res.statusCode,
                    timeMs: Math.round(elapsed * 100) / 100,
                    sizeBytes: buffer.length,
                    body: parsed,
                    raw: buffer.toString().slice(0, 200),
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function login() {
    const res = await request('POST', '/api/auth/login', {
        email: TEST_EMAIL,
        password: TEST_PASS,
    });
    if (res.body && res.body.token) return res.body.token;
    throw new Error(`Login failed: ${res.status} — ${res.raw}`);
}

function recordCount(body) {
    if (Array.isArray(body)) return body.length;
    if (body && typeof body === 'object') {
        // Check common wrapper patterns
        for (const key of ['data', 'items', 'results', 'rows', 'ventas', 'sugerencias', 'recetas_problema']) {
            if (Array.isArray(body[key])) return body[key].length;
        }
        return Object.keys(body).length + ' keys';
    }
    return '—';
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   🏎️  API PERFORMANCE BENCHMARK — lacaleta-api       ║');
    console.log('║   Target: localhost:3001 | Threshold: 500ms          ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Login
    console.log('🔐 Authenticating...');
    const token = await login();
    console.log('   ✅ Token obtained\n');

    // ── 1. Endpoint benchmarks ───────────────────────────

    const endpoints = [
        { method: 'GET', path: '/api/ingredients', name: 'Ingredients' },
        { method: 'GET', path: '/api/recipes', name: 'Recipes' },
        { method: 'GET', path: '/api/orders', name: 'Orders' },
        { method: 'GET', path: '/api/sales', name: 'Sales' },
        { method: 'GET', path: '/api/inventory/complete', name: 'Inventory Complete' },
        { method: 'GET', path: '/api/analysis/menu-engineering', name: 'Menu Engineering' },
        { method: 'GET', path: '/api/balance/mes?mes=1&ano=2026', name: 'Balance Mes (Jan 2026)' },
        { method: 'GET', path: '/api/backup', name: 'Backup' },
        { method: 'GET', path: '/api/suppliers', name: 'Suppliers' },
        { method: 'GET', path: '/api/mermas', name: 'Mermas' },
    ];

    console.log('📊 ENDPOINT BENCHMARK (single request each)');
    console.log('─'.repeat(90));
    console.log(
        'Endpoint'.padEnd(25) +
        'Status'.padEnd(8) +
        'Time (ms)'.padEnd(12) +
        'Size'.padEnd(12) +
        'Records'.padEnd(10) +
        'Result'
    );
    console.log('─'.repeat(90));

    const results = [];

    for (const ep of endpoints) {
        try {
            const res = await request(ep.method, ep.path, null, token);
            const records = recordCount(res.body);
            const flag = res.timeMs > 500 ? '⚠️  SLOW' : '✅';
            const statusFlag = res.status >= 400 ? `❌ ${res.status}` : `${res.status}`;

            console.log(
                ep.name.padEnd(25) +
                statusFlag.padEnd(8) +
                `${res.timeMs}`.padEnd(12) +
                formatSize(res.sizeBytes).padEnd(12) +
                `${records}`.padEnd(10) +
                flag
            );

            results.push({
                name: ep.name,
                path: ep.path,
                status: res.status,
                timeMs: res.timeMs,
                sizeBytes: res.sizeBytes,
                records,
                slow: res.timeMs > 500,
            });
        } catch (err) {
            console.log(
                ep.name.padEnd(25) +
                '💥'.padEnd(8) +
                '—'.padEnd(12) +
                '—'.padEnd(12) +
                '—'.padEnd(10) +
                `ERROR: ${err.message}`
            );
            results.push({
                name: ep.name,
                path: ep.path,
                status: 'ERROR',
                timeMs: null,
                sizeBytes: null,
                records: null,
                slow: true,
                error: err.message,
            });
        }
    }

    console.log('─'.repeat(90));

    // Summary
    const validResults = results.filter(r => r.timeMs !== null);
    const slowCount = results.filter(r => r.slow).length;
    const avgTime = validResults.reduce((s, r) => s + r.timeMs, 0) / validResults.length;
    const maxTime = Math.max(...validResults.map(r => r.timeMs));
    const totalSize = validResults.reduce((s, r) => s + r.sizeBytes, 0);

    console.log(`\n📈 SUMMARY`);
    console.log(`   Average response: ${avgTime.toFixed(1)}ms`);
    console.log(`   Slowest: ${maxTime.toFixed(1)}ms`);
    console.log(`   Total data transferred: ${formatSize(totalSize)}`);
    console.log(`   Slow endpoints (>500ms): ${slowCount}`);
    console.log(`   Status: ${slowCount === 0 ? '✅ ALL UNDER 500ms' : `⚠️ ${slowCount} ENDPOINT(S) OVER 500ms`}`);

    // ── 2. Load test ─────────────────────────────────────

    console.log('\n\n🔥 LOAD TEST — 20 concurrent requests');
    console.log('─'.repeat(70));

    for (const target of ['/api/ingredients', '/api/recipes']) {
        const promises = [];
        const concurrency = 20;

        const batchStart = process.hrtime.bigint();
        for (let i = 0; i < concurrency; i++) {
            promises.push(request('GET', target, null, token));
        }

        const responses = await Promise.all(promises);
        const batchElapsed = Number(process.hrtime.bigint() - batchStart) / 1e6;

        const times = responses.map(r => r.timeMs);
        const statuses = responses.map(r => r.status);
        const errors = statuses.filter(s => s >= 400).length;
        const min = Math.min(...times);
        const max = Math.max(...times);
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];

        console.log(`\n   ${target} (${concurrency} concurrent)`);
        console.log(`   ├─ Min:  ${min.toFixed(1)}ms`);
        console.log(`   ├─ Avg:  ${avg.toFixed(1)}ms`);
        console.log(`   ├─ P95:  ${p95.toFixed(1)}ms`);
        console.log(`   ├─ Max:  ${max.toFixed(1)}ms`);
        console.log(`   ├─ Total batch: ${batchElapsed.toFixed(1)}ms`);
        console.log(`   ├─ Errors: ${errors}/${concurrency}`);
        console.log(`   └─ Degradation: ${max > avg * 3 ? '⚠️ YES (max > 3× avg)' : '✅ NO'}`);
    }

    console.log('\n' + '─'.repeat(70));
    console.log('🏁 Benchmark complete.\n');
}

main().catch(err => {
    console.error('💥 Benchmark failed:', err.message);
    process.exit(1);
});
