/**
 * AntigravityHub v2 - Remote Chat Viewer
 * Scan QR → view & control Antigravity chat on your phone
 * 
 * Pure Node.js - no TypeScript, no build step
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const qrcode = require('qrcode');

// ========== CONFIG ==========
const PORT = 3000;
const TOKEN_FILE = path.join(__dirname, '.token');
const LOG_FILE = path.join(__dirname, 'server.log');
const CDP_PORTS = [9222, 9333, 9229]; // Common CDP debug ports
const POLL_FAST = 50;       // ~20 FPS when content changes
const POLL_SLOW = 150;      // ~7 FPS idle
const POLL_FAST_DURATION = 6000;

// ========== LOGGER ==========
const log = (level, cat, msg) => {
    const ts = new Date().toISOString();
    const line = `[${ts}][${level}][${cat}] ${msg}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    fs.appendFile(LOG_FILE, line + '\n', () => { });
};

// ========== TOKEN ==========
function loadOrCreateToken() {
    if (fs.existsSync(TOKEN_FILE)) {
        return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    }
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    fs.writeFileSync(TOKEN_FILE, token);
    return token;
}
const AUTH_TOKEN = loadOrCreateToken();

// ========== CDP (Chrome DevTools Protocol) ==========
// Discover Antigravity debug targets
async function discoverTargets() {
    const targets = [];
    for (const port of CDP_PORTS) {
        try {
            const data = await httpGet(`http://127.0.0.1:${port}/json`);
            const list = JSON.parse(data);
            for (const t of list) {
                if (t.webSocketDebuggerUrl) {
                    targets.push({
                        id: t.id,
                        port,
                        title: t.title || '',
                        url: t.url || '',
                        wsUrl: t.webSocketDebuggerUrl
                    });
                }
            }
        } catch (e) { /* port not available */ }
    }
    return targets;
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// Score targets - prefer chat/workbench, avoid devtools/QR webviews
function scoreTarget(t) {
    const title = (t.title || '').toLowerCase();
    const url = (t.url || '').toLowerCase();
    let score = 0;
    if (url.includes('workbench') || url.includes('jetski')) score += 6;
    if (title.includes('antigravity')) score += 3;
    if (title.includes('launchpad')) score += 2;
    if (title.includes('qr') || title.includes('auth.ts')) score -= 6;
    if (url.includes('devtools') || title.includes('visual studio code')) score -= 8;
    if (title.includes('vscode-webview')) score -= 8;
    return score;
}

// CDP WebSocket connection
class CDPClient {
    constructor(wsUrl, id, title) {
        this.wsUrl = wsUrl;
        this.id = id;
        this.title = title;
        this.ws = null;
        this.msgId = 1;
        this.pending = new Map();
        this.contexts = [];
        this.connected = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const WS = require('ws');
            this.ws = new WS(this.wsUrl, { handshakeTimeout: 3000 });
            const timeout = setTimeout(() => {
                this.ws.terminate();
                reject(new Error('CDP connect timeout'));
            }, 5000);

            this.ws.on('open', async () => {
                clearTimeout(timeout);
                this.connected = true;
                try {
                    // Enable Runtime for script evaluation
                    await this.call('Runtime.enable');
                    // Get execution contexts
                    await this.refreshContexts();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id && this.pending.has(msg.id)) {
                        const { resolve, reject } = this.pending.get(msg.id);
                        this.pending.delete(msg.id);
                        if (msg.error) reject(new Error(msg.error.message));
                        else resolve(msg.result);
                    }
                    // Track execution contexts
                    if (msg.method === 'Runtime.executionContextCreated') {
                        const ctx = msg.params.context;
                        if (!this.contexts.find(c => c.id === ctx.id)) {
                            this.contexts.push({ id: ctx.id, name: ctx.name || '', origin: ctx.origin || '' });
                        }
                    }
                    if (msg.method === 'Runtime.executionContextDestroyed') {
                        this.contexts = this.contexts.filter(c => c.id !== msg.params.executionContextId);
                    }
                } catch (e) { }
            });

            this.ws.on('close', () => {
                this.connected = false;
                // Reject all pending
                for (const [, { reject }] of this.pending) {
                    reject(new Error('CDP connection closed'));
                }
                this.pending.clear();
            });

            this.ws.on('error', (e) => {
                clearTimeout(timeout);
                this.connected = false;
            });
        });
    }

    call(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('CDP not connected'));
            }
            const id = this.msgId++;
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP call ${method} timeout`));
            }, 5000);
            this.pending.set(id, {
                resolve: (r) => { clearTimeout(timeout); resolve(r); },
                reject: (e) => { clearTimeout(timeout); reject(e); }
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async refreshContexts() {
        this.contexts = [];
        try {
            await this.call('Runtime.enable');
            // Wait a bit for contexts to arrive
            await new Promise(r => setTimeout(r, 200));
        } catch (e) { }
    }

    async evaluate(expression, contextId) {
        const params = { expression, returnByValue: true };
        if (contextId) params.contextId = contextId;
        return this.call('Runtime.evaluate', params);
    }

    close() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
            this.connected = false;
        }
    }
}

// ========== SNAPSHOT CAPTURE ==========
const CAPTURE_SCRIPT = `(() => {
    try {
        const sections = [];
        
        // Convert blob/vscode images to base64
        document.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src') || '';
            if (src && (src.startsWith('blob:') || src.startsWith('vscode-') || src.startsWith('https://file'))) {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (ctx && img.naturalWidth > 0 && img.naturalHeight > 0) {
                        canvas.width = img.naturalWidth;
                        canvas.height = img.naturalHeight;
                        ctx.drawImage(img, 0, 0);
                        const dataUrl = canvas.toDataURL('image/png');
                        if (dataUrl && dataUrl.length > 100) img.setAttribute('src', dataUrl);
                    }
                } catch(e) {}
            }
        });

        // Get toolbar
        const tbSels = ['.titlebar.cascade-panel-open', '.cascade-bar', '[id="workbench.parts.titlebar"]'];
        for (const sel of tbSels) {
            const el = document.querySelector(sel);
            if (el) { sections.push(el.outerHTML); break; }
        }
        
        // Get chat panel
        const chatSels = ['#cascade', '#chat', '#react-app', '.react-app-container'];
        for (const sel of chatSels) {
            const el = document.querySelector(sel);
            if (el && el.innerHTML.length > 100) { sections.push(el.outerHTML); break; }
        }
        
        const html = sections.length > 0 ? sections.join('\\n') : document.body.outerHTML;
        
        // Capture CSS
        let css = '';
        for (const sheet of document.styleSheets) {
            try { for (const rule of sheet.cssRules) css += rule.cssText + '\\n'; } catch(e) {}
        }
        
        // CSS variables
        let cssVars = '';
        try {
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        if (rule instanceof CSSStyleRule && /^(:root|:host|html|body)$/.test(rule.selectorText)) {
                            for (let i = 0; i < rule.style.length; i++) {
                                const p = rule.style[i];
                                if (p.startsWith('--')) cssVars += p + ':' + rule.style.getPropertyValue(p).trim() + ';';
                            }
                        }
                    }
                } catch(e) {}
            }
            const inline = document.documentElement.getAttribute('style') || '';
            if (inline.includes('--')) cssVars += inline;
        } catch(e) {}
        
        const bodyStyles = window.getComputedStyle(document.body);
        return {
            html, css, cssVars,
            backgroundColor: bodyStyles.backgroundColor,
            color: bodyStyles.color,
            fontSize: bodyStyles.fontSize,
            fontFamily: bodyStyles.fontFamily,
            title: document.title,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
        };
    } catch(e) {
        return { error: e.message, html: '', css: '' };
    }
})()`;

// Message injection script
function makeInjectScript(message) {
    const escaped = message.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
    return `(() => {
        // Try multiple strategies to inject message
        // Strategy 1: Find textarea/input and set value + dispatch events
        const inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
        for (const input of inputs) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 100 && rect.height > 20) {
                if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value'
                    )?.set;
                    if (nativeSetter) nativeSetter.call(input, '${escaped}');
                    else input.value = '${escaped}';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    input.textContent = '${escaped}';
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '${escaped}' }));
                }
                // Try to find and click send button
                setTimeout(() => {
                    const btns = document.querySelectorAll('button');
                    for (const btn of btns) {
                        const txt = (btn.textContent || '').toLowerCase();
                        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if (txt.includes('send') || txt.includes('submit') || aria.includes('send') || aria.includes('submit') || btn.querySelector('svg[class*="send"]')) {
                            btn.click();
                            return 'sent_via_button';
                        }
                    }
                    // Enter key fallback
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                }, 100);
                return { ok: true, method: 'input_set' };
            }
        }
        return { ok: false, reason: 'no_input_found' };
    })()`;
}

// Click element script
function makeClickScript(text, tag, x, y, selector) {
    if (selector) {
        return `(() => {
            const el = document.querySelector('${selector}');
            if (el) { el.click(); return { success: true }; }
            return { success: false };
        })()`;
    }
    if (typeof x === 'number' && typeof y === 'number') {
        return `(() => {
            const el = document.elementFromPoint(${x}, ${y});
            if (el) { el.click(); return { success: true, tag: el.tagName }; }
            return { success: false };
        })()`;
    }
    const escapedText = (text || '').replace(/'/g, "\\'");
    const tagFilter = tag ? `.filter(el => el.tagName === '${tag.toUpperCase()}')` : '';
    return `(() => {
        const all = Array.from(document.querySelectorAll('button, a, [role="button"], [onclick], input[type="submit"]'))${tagFilter};
        for (const el of all) {
            const txt = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (txt.includes('${escapedText}') || aria.includes('${escapedText}')) {
                el.click();
                return { success: true, text: txt };
            }
        }
        return { success: false };
    })()`;
}

// Scroll script
function makeScrollScript(deltaY) {
    return `(() => {
        const containers = document.querySelectorAll('[class*="overflow-y-auto"], [class*="overflow-y-scroll"], [style*="overflow"]');
        for (const el of containers) {
            if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
                el.scrollBy({ top: ${deltaY}, behavior: 'auto' });
                return true;
            }
        }
        window.scrollBy({ top: ${deltaY}, behavior: 'auto' });
        return false;
    })()`;
}

// SVG icon conversion (codicon → unicode text, for mobile rendering)
function convertIcons(html) {
    if (!html) return html;
    // Replace common codicon classes with unicode equivalents
    const iconMap = {
        'codicon-close': '✕',
        'codicon-add': '+',
        'codicon-trash': '🗑',
        'codicon-edit': '✏',
        'codicon-copy': '📋',
        'codicon-check': '✓',
        'codicon-chevron-down': '▼',
        'codicon-chevron-right': '▶',
        'codicon-chevron-up': '▲',
        'codicon-search': '🔍',
        'codicon-settings': '⚙',
        'codicon-refresh': '↻',
        'codicon-send': '➤',
        'codicon-stop': '⏹',
        'codicon-play': '▶',
        'codicon-file': '📄',
        'codicon-folder': '📁',
        'codicon-terminal': '⬛',
        'codicon-info': 'ℹ',
        'codicon-warning': '⚠',
        'codicon-error': '❌'
    };
    for (const [cls, icon] of Object.entries(iconMap)) {
        const regex = new RegExp(`<span[^>]*class="[^"]*${cls}[^"]*"[^>]*>[^<]*</span>`, 'g');
        html = html.replace(regex, `<span>${icon}</span>`);
    }
    return html;
}

// ========== MAIN STATE ==========
let cdpClient = null;
let lastSnapshot = null;
let lastSnapshotHash = null;
let lastChangeTime = 0;
let consecutiveFails = 0;
let lastReconnectTime = 0;
const RECONNECT_COOLDOWN = 10000; // 10s between reconnect attempts

function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
    }
    return h.toString();
}

async function connectCDP(targetId) {
    // Disconnect existing
    if (cdpClient) {
        cdpClient.close();
        cdpClient = null;
    }

    const targets = await discoverTargets();
    if (targets.length === 0) {
        log('WARN', 'CDP', 'No targets found');
        return false;
    }

    // Sort by score, prefer chat targets
    const sorted = [...targets].sort((a, b) => scoreTarget(b) - scoreTarget(a));
    let chosen = targetId ? sorted.find(t => t.id === targetId) : null;
    if (!chosen) chosen = sorted[0];

    const client = new CDPClient(chosen.wsUrl, chosen.id, chosen.title);
    try {
        await client.connect();
        cdpClient = client;
        log('INFO', 'CDP', `Connected to: ${chosen.title} (port ${chosen.port})`);
        return true;
    } catch (e) {
        log('ERROR', 'CDP', `Connect failed: ${e.message}`);
        return false;
    }
}

async function captureSnapshot() {
    if (!cdpClient || !cdpClient.connected) {
        consecutiveFails++;
        const now = Date.now();
        if (consecutiveFails >= 5 && (now - lastReconnectTime) > RECONNECT_COOLDOWN) {
            consecutiveFails = 0;
            lastReconnectTime = now;
            log('INFO', 'CDP', 'Auto-reconnecting...');
            try { await connectCDP(); } catch (e) { }
        }
        return null;
    }

    // Try each execution context
    const contexts = cdpClient.contexts.length > 0 ? cdpClient.contexts : [null];
    for (const ctx of contexts) {
        try {
            const result = await cdpClient.evaluate(CAPTURE_SCRIPT, ctx?.id);
            if (result?.result?.value && !result.result.value.error) {
                consecutiveFails = 0;
                const snapshot = result.result.value;
                snapshot.html = convertIcons(snapshot.html);
                const hash = hashString(snapshot.html);
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;
                    lastChangeTime = Date.now();
                    return snapshot;
                }
                return null; // No change
            }
        } catch (e) { }
    }

    consecutiveFails++;
    const now = Date.now();
    if (consecutiveFails >= 5 && (now - lastReconnectTime) > RECONNECT_COOLDOWN) {
        consecutiveFails = 0;
        lastReconnectTime = now;
        log('INFO', 'CDP', 'Reconnecting after failures...');
        try { await connectCDP(); } catch (e) { }
    }
    return null;
}

// ========== SERVER ==========
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Auth check (skip for static assets & QR page)
app.use((req, res, next) => {
    // Allow static assets without token
    if (req.path.match(/\.(css|js|png|jpg|svg|ico|woff|woff2)$/)) return next();
    // Check token
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    if (token === AUTH_TOKEN) return next();
    // Allow QR page (it's just the QR display, no data)
    if (req.path === '/qr') return next();
    res.status(401).json({ error: 'Unauthorized. Add ?token=YOUR_TOKEN to URL.' });
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false, maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}));

// API Routes
app.get('/ping', (_, res) => res.send('pong'));

app.get('/snapshot', (_, res) => {
    if (!lastSnapshot) return res.status(503).json({ error: 'No snapshot yet. Waiting for Antigravity connection...' });
    res.json(lastSnapshot);
});

app.get('/status', (_, res) => {
    res.json({
        connected: !!(cdpClient && cdpClient.connected),
        target: cdpClient?.title || null,
        hasSnapshot: !!lastSnapshot,
        uptime: process.uptime()
    });
});

app.get('/targets', async (_, res) => {
    try {
        const targets = await discoverTargets();
        res.json({
            activeId: cdpClient?.id || null,
            targets: targets.map(t => ({ id: t.id, title: t.title, port: t.port, score: scoreTarget(t) }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/connect', async (req, res) => {
    try {
        const ok = await connectCDP(req.body.targetId);
        res.json({ success: ok, target: cdpClient?.title || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/send', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!cdpClient || !cdpClient.connected) return res.status(503).json({ error: 'Not connected to Antigravity' });

    try {
        const contexts = cdpClient.contexts.length > 0 ? cdpClient.contexts : [null];
        for (const ctx of contexts) {
            try {
                const result = await cdpClient.evaluate(makeInjectScript(message), ctx?.id);
                if (result?.result?.value?.ok) {
                    log('INFO', 'API', `Message sent: "${message.slice(0, 50)}"`);
                    return res.json({ success: true });
                }
            } catch (e) { }
        }
        res.status(500).json({ error: 'Could not inject message' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/click', async (req, res) => {
    const { text, tag, x, y, selector } = req.body;
    if (!cdpClient || !cdpClient.connected) return res.status(503).json({ error: 'Not connected' });

    try {
        const contexts = cdpClient.contexts.length > 0 ? cdpClient.contexts : [null];
        for (const ctx of contexts) {
            try {
                const result = await cdpClient.evaluate(makeClickScript(text, tag, x, y, selector), ctx?.id);
                if (result?.result?.value?.success) {
                    lastChangeTime = Date.now();
                    return res.json({ success: true });
                }
            } catch (e) { }
        }
        res.status(404).json({ error: 'Element not found' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// WebSocket handling
wss.on('connection', (ws, req) => {
    // Auth check
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token !== AUTH_TOKEN) {
        ws.close(1008, 'Unauthorized');
        return;
    }

    log('INFO', 'WS', `Client connected from ${req.socket.remoteAddress}`);

    // Send current snapshot immediately
    if (lastSnapshot) {
        ws.send(JSON.stringify({ type: 'snapshot', data: lastSnapshot, ts: Date.now() }));
    }

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'request_snapshot' && lastSnapshot) {
                ws.send(JSON.stringify({ type: 'snapshot', data: lastSnapshot, ts: Date.now() }));
            }

            // Scroll forward
            if (msg.type === 'scroll' && typeof msg.deltaY === 'number') {
                if (cdpClient && cdpClient.connected) {
                    const contexts = cdpClient.contexts.length > 0 ? cdpClient.contexts : [null];
                    for (const ctx of contexts) {
                        try {
                            await cdpClient.evaluate(makeScrollScript(msg.deltaY), ctx?.id);
                            lastChangeTime = Date.now();
                            break;
                        } catch (e) { }
                    }
                }
            }
        } catch (e) { }
    });
});

// Broadcast snapshot to all WS clients
function broadcastSnapshot(snapshot) {
    const msg = JSON.stringify({ type: 'snapshot', data: snapshot, ts: Date.now() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// ========== STARTUP ==========
async function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (!iface.internal && iface.family === 'IPv4') {
                candidates.push({ name, addr: iface.address });
            }
        }
    }
    const priority = candidates.find(c => /wi-fi|ethernet|wireless|en[0-9]|eth[0-9]/i.test(c.name));
    const clean = priority || candidates.find(c => !/virtual|vbox|wsl|vpn|tailscale/i.test(c.name)) || candidates[0];
    return clean ? clean.addr : 'localhost';
}

async function main() {
    // Clear old log
    if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

    const localIP = await getLocalIP();
    const url = `http://${localIP}:${PORT}/?token=${AUTH_TOKEN}`;

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  📱 AntigravityHub - Remote Chat Viewer  ║');
    console.log('╚══════════════════════════════════════════╝\n');

    // Generate QR code for terminal
    try {
        const qr = await qrcode.toString(url, { type: 'terminal', small: true });
        console.log(qr);
    } catch (e) { }

    console.log(`\n🔗 URL: ${url}`);
    console.log(`🔑 Token: ${AUTH_TOKEN}\n`);

    // Start HTTP server
    server.listen(PORT, async () => {
        log('INFO', 'SERVER', `Listening on http://0.0.0.0:${PORT}`);

        // Connect to Antigravity CDP
        log('INFO', 'CDP', 'Discovering Antigravity targets...');
        const connected = await connectCDP();
        if (connected) {
            log('INFO', 'CDP', `Connected to Antigravity chat`);
        } else {
            log('WARN', 'CDP', 'No Antigravity targets found. Will keep retrying...');
        }

        // Adaptive snapshot polling
        const poll = async () => {
            const snapshot = await captureSnapshot();
            if (snapshot) broadcastSnapshot(snapshot);
            const elapsed = Date.now() - lastChangeTime;
            const interval = elapsed < POLL_FAST_DURATION ? POLL_FAST : POLL_SLOW;
            setTimeout(poll, interval);
        };
        poll();

        console.log('✅ Ready! Scan QR code with your phone to connect.\n');
        console.log('Press Ctrl+C to stop.\n');
    });

    process.on('SIGINT', () => {
        log('INFO', 'SERVER', 'Shutting down...');
        if (cdpClient) cdpClient.close();
        server.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
