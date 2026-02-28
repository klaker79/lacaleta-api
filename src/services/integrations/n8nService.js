/**
 * n8n Integration Service
 * Reads workflow/execution data from n8n REST API.
 * Requires: N8N_BASE_URL, N8N_API_KEY env vars.
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.N8N_BASE_URL;
const API_KEY = process.env.N8N_API_KEY;
const CONFIGURED = !!(BASE_URL && API_KEY);

function makeRequest(path) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${BASE_URL}/api/v1${path}`);
        const client = url.protocol === 'https:' ? https : http;
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: {
                'X-N8N-API-KEY': API_KEY,
                'Accept': 'application/json'
            },
            timeout: 10000
        };
        const req = client.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON from n8n'));
                    }
                } else {
                    reject(new Error(`n8n API ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('n8n API timeout')); });
    });
}

module.exports = {
    isConfigured: () => CONFIGURED,

    async getStatus() {
        if (!CONFIGURED) {
            return { status: 'not_configured', message: 'N8N_BASE_URL o N8N_API_KEY no configurados' };
        }
        try {
            const [workflows, executions] = await Promise.all([
                makeRequest('/workflows?limit=100'),
                makeRequest('/executions?limit=20&status=error')
            ]);

            const workflowList = workflows.data || [];
            const executionList = executions.data || [];

            return {
                status: 'connected',
                workflows: {
                    total: workflowList.length,
                    active: workflowList.filter(w => w.active).length,
                    inactive: workflowList.filter(w => !w.active).length
                },
                recentFailures: executionList.map(e => ({
                    id: e.id,
                    workflowName: e.workflowData?.name || 'Unknown',
                    status: e.status || (e.finished ? 'success' : 'error'),
                    startedAt: e.startedAt,
                    stoppedAt: e.stoppedAt,
                    error: e.data?.resultData?.error?.message
                })),
                totalFailures: executionList.length
            };
        } catch (err) {
            return { status: 'error', message: err.message };
        }
    }
};
