/**
 * Uptime Kuma Integration Service
 * Reads monitor status from the public Status Page API (no auth needed).
 * Requires: UPTIME_KUMA_BASE_URL, UPTIME_KUMA_STATUS_SLUG env vars.
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.UPTIME_KUMA_BASE_URL;
const STATUS_SLUG = process.env.UPTIME_KUMA_STATUS_SLUG;
const CONFIGURED = !!(BASE_URL && STATUS_SLUG);

function makeRequest(urlString) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(url, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON from Uptime Kuma'));
                    }
                } else {
                    reject(new Error(`Uptime Kuma ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Uptime Kuma timeout')); });
    });
}

module.exports = {
    isConfigured: () => CONFIGURED,

    async getStatus() {
        if (!CONFIGURED) {
            return { status: 'not_configured', message: 'UPTIME_KUMA_BASE_URL o UPTIME_KUMA_STATUS_SLUG no configurados' };
        }
        try {
            const [statusPage, heartbeats] = await Promise.all([
                makeRequest(`${BASE_URL}/api/status-page/${STATUS_SLUG}`),
                makeRequest(`${BASE_URL}/api/status-page/heartbeat/${STATUS_SLUG}`)
            ]);

            // Build monitor name map from status page publicGroupList
            const nameMap = {};
            const groups = statusPage.publicGroupList || [];
            for (const group of groups) {
                for (const m of (group.monitorList || [])) {
                    nameMap[m.id] = m.name;
                }
            }

            const monitors = [];
            const uptimeList = heartbeats.uptimeList || {};
            const heartbeatList = heartbeats.heartbeatList || {};

            for (const [monitorId, beats] of Object.entries(heartbeatList)) {
                const latest = beats[beats.length - 1];
                const uptime24h = uptimeList[`${monitorId}_24`];
                const uptime30d = uptimeList[`${monitorId}_720`];
                monitors.push({
                    id: monitorId,
                    name: nameMap[monitorId] || latest?.monitorName || `Monitor ${monitorId}`,
                    status: latest?.status === 1 ? 'up' : 'down',
                    uptime24h: uptime24h != null ? (uptime24h * 100).toFixed(2) : null,
                    uptime30d: uptime30d != null ? (uptime30d * 100).toFixed(2) : null,
                    lastPing: latest?.time,
                    message: latest?.msg
                });
            }

            const incidents = [];
            for (const [monitorId, beats] of Object.entries(heartbeatList)) {
                const downBeats = beats.filter(b => b.status === 0);
                if (downBeats.length > 0) {
                    incidents.push({
                        monitorId,
                        monitorName: nameMap[monitorId] || downBeats[0]?.monitorName || `Monitor ${monitorId}`,
                        downPeriods: downBeats.length,
                        lastDown: downBeats[downBeats.length - 1]?.time
                    });
                }
            }

            return {
                status: 'connected',
                pageTitle: statusPage.config?.title || STATUS_SLUG,
                monitors,
                incidents,
                totalMonitors: monitors.length,
                monitorsUp: monitors.filter(m => m.status === 'up').length,
                monitorsDown: monitors.filter(m => m.status === 'down').length
            };
        } catch (err) {
            return { status: 'error', message: err.message };
        }
    }
};
