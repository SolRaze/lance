#!/usr/bin/env node
// lance-relay.js — tiny localhost relay for lance userscript
// Receives POST /obsidian {uri} → opens obsidian:// at OS level
// No tab opened in browser, no focus change.
//
// Usage:
//   node lance-relay.js          (port 27184 default)
//   node lance-relay.js 27184
//
// Auto-start (macOS LaunchAgent): see lance-relay.plist
// Auto-start (Linux systemd):     see lance-relay.service
// WARNING: binds ONLY to 127.0.0.1 — not exposed to network.

'use strict';
const http  = require('http');
const { exec } = require('child_process');
const PORT  = parseInt(process.argv[2]) || 27184;
const HOST  = '127.0.0.1';

// OS-level open command
const OPEN_CMD =
    process.platform === 'darwin'  ? 'open'      :   // macOS
    process.platform === 'win32'   ? 'start ""'  :   // Windows
    'xdg-open';                                       // Linux

function openUri(uri) {
    // Validate: only allow obsidian:// URIs
    if (!/^obsidian:\/\//.test(uri)) throw new Error('Invalid URI scheme');
    // Shell-escape the URI: wrap in single quotes, escape any embedded single quotes
    const safe = "'" + uri.replace(/'/g, "'\\''") + "'";
    exec(`${OPEN_CMD} ${safe}`, err => {
        if (err) console.error('[lance-relay] exec error:', err.message);
    });
}

const server = http.createServer((req, res) => {
    // CORS — allow requests from any browser origin (all localhost)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'POST' && req.url === '/obsidian') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { uri } = JSON.parse(body);
                openUri(uri);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                console.log('[lance-relay] opened:', uri);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
                console.error('[lance-relay] error:', e.message);
            }
        });
        return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '1.0.0' }));
        return;
    }

    res.writeHead(404); res.end();
});

server.listen(PORT, HOST, () => {
    console.log(`[lance-relay] listening on http://${HOST}:${PORT}`);
    console.log('[lance-relay] press Ctrl+C to stop');
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE')
        console.error(`[lance-relay] port ${PORT} already in use — relay may already be running`);
    else
        console.error('[lance-relay] server error:', err.message);
    process.exit(1);
});
