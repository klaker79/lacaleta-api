/**
 * Sentry Integration Service
 * Reads error data from Sentry REST API for the admin dashboard.
 * Requires: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT env vars.
 */

const https = require('https');

const CONFIGURED = !!(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);
// Support EU region: if SENTRY_REGION=de or DSN contains .de.sentry.io, use de.sentry.io
const SENTRY_HOST = process.env.SENTRY_REGION === 'de' ? 'de.sentry.io' : (process.env.SENTRY_REGION || 'sentry.io');

function makeRequest(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: SENTRY_HOST,
            path: `/api/0/projects/${process.env.SENTRY_ORG}/${process.env.SENTRY_PROJECT}${path}`,
            headers: {
                'Authorization': `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        };
        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON from Sentry'));
                    }
                } else {
                    reject(new Error(`Sentry API ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Sentry API timeout')); });
    });
}

module.exports = {
    isConfigured: () => CONFIGURED,

    async getStatus() {
        if (!CONFIGURED) {
            return { status: 'not_configured', message: 'SENTRY_AUTH_TOKEN, SENTRY_ORG o SENTRY_PROJECT no configurados' };
        }
        try {
            const issues = await makeRequest('/issues/?query=is:unresolved&sort=date&limit=10');
            return {
                status: 'connected',
                issues: issues.map(i => ({
                    id: i.id,
                    title: i.title,
                    culprit: i.culprit,
                    count: parseInt(i.count) || 0,
                    firstSeen: i.firstSeen,
                    lastSeen: i.lastSeen,
                    level: i.level,
                    permalink: i.permalink
                })),
                totalUnresolved: issues.length
            };
        } catch (err) {
            return { status: 'error', message: err.message };
        }
    }
};
