/**
 * AntigravityHub v2 - Remote Chat Viewer
 * Pixel-perfect mirror of Antigravity chat on your phone
 * Uses CDP Screencast (same as ZaloRemote) for real-time screen streaming
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
const CDP_PORTS = [9000, 9222, 9333, 9229];
const SCREENSHOT_INTERVAL = 80;      // ~12 FPS screenshot capture 
const SCREENSHOT_QUALITY = 70;        // JPEG quality (balance speed vs clarity)
const RECONNECT_COOLDOWN = 10000;     // 10s between reconnect attempts

// ========== LOGGER ==========
const log = (level, cat, msg) => {
    const ts = new Date().toISOString();
    const line = `[${ts}][${level}][${cat}] ${msg}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
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

// ========== HTTP GET HELPER ==========
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

// ========== CDP (Chrome DevTools Protocol) ==========
async function discoverTargets() {
    const targets = [];
    for (const port of CDP_PORTS) {
        try {
            const data = await httpGet(`http://127.0.0.1:${port}/json`);
            const list = JSON.parse(data);
            for (const t of list) {
                if (t.webSocketDebuggerUrl) {
                    targets.push({
                        id: t.id, port, type: t.type || 'page',
                        title: t.title || '', url: t.url || '',
                        wsUrl: t.webSocketDebuggerUrl
                    });
                }
            }
        } catch (e) { }
    }
    return targets;
}

function scoreTarget(t) {
    const title = (t.title || '').toLowerCase();
    const url = (t.url || '').toLowerCase();
    let score = 0;
    // Highest priority: workbench-jetski-agent = Antigravity chat panel
    if (url.includes('jetski-agent') || url.includes('workbench-jetski')) score += 10;
    if (url.includes('workbench.html') && !url.includes('jetski')) score += 7;
    if (title.includes('launchpad')) score += 5;
    if (title.includes('antigravity') && !url.includes('localhost:3000')) score += 3;
    // Exclude our own remote viewer page
    if (url.includes('localhost:3000') || url.includes('127.0.0.1:3000')) score -= 20;
    // Exclude browser internals
    if (url.includes('chrome://') || url.includes('chrome-extension://')) score -= 10;
    if (t.type === 'service_worker' || t.type === 'worker') score -= 10;
    if (url.includes('devtools') || title.includes('visual studio code')) score -= 8;
    if (title.includes('vscode-webview')) score -= 8;
    return score;
}

// ========== CDP CLIENT ==========
class CDPClient {
    constructor(wsUrl, id, title) {
        this.wsUrl = wsUrl;
        this.id = id;
        this.title = title;
        this.ws = null;
        this.msgId = 1;
        this.pending = new Map();
        this.connected = false;
        this.screencastActive = false;
        this.onFrame = null; // callback for screencast frames
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
                    await this.call('Runtime.enable');
                    await this.call('Page.enable');
                    resolve();
                } catch (e) { reject(e); }
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    // Handle pending responses
                    if (msg.id && this.pending.has(msg.id)) {
                        const { resolve, reject } = this.pending.get(msg.id);
                        this.pending.delete(msg.id);
                        if (msg.error) reject(new Error(msg.error.message));
                        else resolve(msg.result);
                    }
                    // Handle screencast frames (like ZaloHub)
                    if (msg.method === 'Page.screencastFrame') {
                        // ACK the frame immediately
                        this.call('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => { });
                        if (this.onFrame) {
                            this.onFrame(msg.params.data); // base64 JPEG data
                        }
                    }
                } catch (e) { }
            });

            this.ws.on('close', () => {
                this.connected = false;
                this.screencastActive = false;
                for (const [, { reject }] of this.pending) {
                    reject(new Error('CDP connection closed'));
                }
                this.pending.clear();
            });

            this.ws.on('error', () => {
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
            }, 8000);
            this.pending.set(id, {
                resolve: (r) => { clearTimeout(timeout); resolve(r); },
                reject: (e) => { clearTimeout(timeout); reject(e); }
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    // Start screencast - stream frames via CDP (same as ZaloHub)
    async startScreencast(width, height) {
        if (this.screencastActive) return;
        try {
            await this.call('Page.startScreencast', {
                format: 'jpeg',
                quality: SCREENSHOT_QUALITY,
                maxWidth: width || 1280,
                maxHeight: height || 800,
                everyNthFrame: 1
            });
            this.screencastActive = true;
            log('INFO', 'CDP', 'Screencast started');
        } catch (e) {
            log('WARN', 'CDP', `Screencast failed, falling back to screenshot: ${e.message}`);
        }
    }

    async stopScreencast() {
        if (!this.screencastActive) return;
        try {
            await this.call('Page.stopScreencast');
        } catch (e) { }
        this.screencastActive = false;
    }

    // Fallback: capture single screenshot
    async captureScreenshot() {
        try {
            const result = await this.call('Page.captureScreenshot', {
                format: 'jpeg',
                quality: SCREENSHOT_QUALITY
            });
            return result?.data || null;
        } catch (e) {
            return null;
        }
    }

    // Execute JS on the page (for click, type, scroll)
    async evaluate(expression) {
        return this.call('Runtime.evaluate', {
            expression,
            returnByValue: true
        });
    }

    // Dispatch mouse events via CDP Input domain (pixel-perfect like ZaloHub)
    async mouseClick(x, y, button = 'left', clickCount = 1) {
        try {
            await this.call('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button, clickCount
            });
            await this.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button, clickCount
            });
        } catch (e) {
            log('WARN', 'INPUT', `Click failed: ${e.message}`);
        }
    }

    // Dispatch scroll via CDP Input domain
    async mouseScroll(x, y, deltaX, deltaY) {
        try {
            await this.call('Input.dispatchMouseEvent', {
                type: 'mouseWheel', x, y, deltaX: deltaX || 0, deltaY: deltaY || 0
            });
        } catch (e) {
            log('WARN', 'INPUT', `Scroll failed: ${e.message}`);
        }
    }

    // Type text via CDP Input.insertText (proper Unicode/Vietnamese support)
    async insertText(text) {
        try {
            await this.call('Input.insertText', { text });
        } catch (e) {
            log('WARN', 'INPUT', `InsertText failed: ${e.message}`);
        }
    }

    // Press key via CDP Input.dispatchKeyEvent
    async pressKey(key) {
        try {
            const keyMap = {
                'Enter': { keyCode: 13, code: 'Enter', key: 'Enter' },
                'Backspace': { keyCode: 8, code: 'Backspace', key: 'Backspace' },
                'Delete': { keyCode: 46, code: 'Delete', key: 'Delete' },
                'Tab': { keyCode: 9, code: 'Tab', key: 'Tab' },
                'Escape': { keyCode: 27, code: 'Escape', key: 'Escape' },
                'ArrowUp': { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
                'ArrowDown': { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
                'ArrowLeft': { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
                'ArrowRight': { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
                'Space': { keyCode: 32, code: 'Space', key: ' ' },
                'Home': { keyCode: 36, code: 'Home', key: 'Home' },
                'End': { keyCode: 35, code: 'End', key: 'End' },
            };
            // Handle modifier combos like "Control+a"
            const parts = key.split('+');
            const modifiers = [];
            let baseKey = key;
            if (parts.length > 1) {
                baseKey = parts.pop();
                for (const mod of parts) {
                    if (mod === 'Control') modifiers.push('control');
                    if (mod === 'Alt') modifiers.push('alt');
                    if (mod === 'Shift') modifiers.push('shift');
                    if (mod === 'Meta') modifiers.push('meta');
                }
            }

            const mapped = keyMap[baseKey];
            const modFlag = modifiers.reduce((acc, m) => acc | ({ control: 1, alt: 2, shift: 4, meta: 8 }[m] || 0), 0);

            if (mapped) {
                await this.call('Input.dispatchKeyEvent', {
                    type: 'keyDown', key: mapped.key, code: mapped.code,
                    windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
                    modifiers: modFlag
                });
                await this.call('Input.dispatchKeyEvent', {
                    type: 'keyUp', key: mapped.key, code: mapped.code,
                    windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
                    modifiers: modFlag
                });
            } else if (baseKey.length === 1) {
                // Single character key with modifiers
                const charCode = baseKey.charCodeAt(0);
                await this.call('Input.dispatchKeyEvent', {
                    type: 'keyDown', key: baseKey, code: `Key${baseKey.toUpperCase()}`,
                    windowsVirtualKeyCode: charCode, nativeVirtualKeyCode: charCode,
                    modifiers: modFlag
                });
                await this.call('Input.dispatchKeyEvent', {
                    type: 'keyUp', key: baseKey, code: `Key${baseKey.toUpperCase()}`,
                    windowsVirtualKeyCode: charCode, nativeVirtualKeyCode: charCode,
                    modifiers: modFlag
                });
            }
        } catch (e) {
            log('WARN', 'INPUT', `Key press failed: ${e.message}`);
        }
    }

    close() {
        this.screencastActive = false;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
            this.connected = false;
        }
    }
}

// ========== MAIN STATE ==========
let cdpClient = null;
let lastFrameData = null;  // base64 JPEG frame
let lastReconnectTime = 0;
let consecutiveFails = 0;
let screenshotInterval = null;

// ========== CDP CONNECTION ==========
async function connectCDP(targetId) {
    if (cdpClient) {
        cdpClient.close();
        cdpClient = null;
    }

    const targets = await discoverTargets();
    if (targets.length === 0) {
        log('WARN', 'CDP', 'No targets found');
        return false;
    }

    const sorted = [...targets].sort((a, b) => scoreTarget(b) - scoreTarget(a));
    log('INFO', 'CDP', `Found ${targets.length} targets:`);
    for (const t of sorted) {
        log('INFO', 'CDP', `  [score=${scoreTarget(t)}] "${t.title}" (port ${t.port}, ${t.type}) ${t.url.substring(0, 80)}`);
    }
    let chosen = targetId ? sorted.find(t => t.id === targetId) : null;
    if (!chosen) chosen = sorted[0];

    const client = new CDPClient(chosen.wsUrl, chosen.id, chosen.title);
    try {
        await client.connect();
        cdpClient = client;
        log('INFO', 'CDP', `Connected to: ${chosen.title} (port ${chosen.port})`);

        // Setup screencast frame handler
        client.onFrame = (base64Data) => {
            lastFrameData = base64Data;
            broadcastFrame(base64Data);
        };

        // Try screencast first (real-time, like ZaloHub)
        try {
            await client.startScreencast(1280, 800);
        } catch (e) {
            log('WARN', 'CDP', 'Screencast not available, using screenshot fallback');
        }

        // Always start screenshot polling as fallback/supplement
        startScreenshotPolling();

        return true;
    } catch (e) {
        log('ERROR', 'CDP', `Connect failed: ${e.message}`);
        return false;
    }
}

// Screenshot polling (fallback, also catches changes screencast misses)
function startScreenshotPolling() {
    if (screenshotInterval) clearInterval(screenshotInterval);
    screenshotInterval = setInterval(async () => {
        if (!cdpClient || !cdpClient.connected) return;
        // Only poll if no active clients, skip if screencast is working
        if (wss.clients.size === 0) return;

        try {
            const frame = await cdpClient.captureScreenshot();
            if (frame && frame !== lastFrameData) {
                lastFrameData = frame;
                broadcastFrame(frame);
            }
        } catch (e) { }
    }, 2000); // Every 2s as supplement
}

function stopScreenshotPolling() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }
}

// ========== SERVER ==========
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '50mb' }));

// Auth middleware
app.use((req, res, next) => {
    if (req.path.match(/\.(css|js|png|jpg|svg|ico|woff|woff2)$/)) return next();
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    if (token === AUTH_TOKEN) return next();
    res.status(401).json({ error: 'Unauthorized' });
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false, maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}));

// API Routes
app.get('/ping', (_, res) => res.send('pong'));

app.get('/status', (_, res) => {
    res.json({
        connected: !!(cdpClient && cdpClient.connected),
        target: cdpClient?.title || null,
        screencast: cdpClient?.screencastActive || false,
        hasFrame: !!lastFrameData,
        clients: wss.clients.size,
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/connect', async (req, res) => {
    try {
        const ok = await connectCDP(req.body.targetId);
        res.json({ success: ok, target: cdpClient?.title || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token !== AUTH_TOKEN) {
        ws.close(1008, 'Unauthorized');
        return;
    }

    log('INFO', 'WS', `Client connected from ${req.socket.remoteAddress}`);

    // Send current frame immediately
    if (lastFrameData) {
        ws.send(JSON.stringify({ type: 'frame', data: lastFrameData }));
    }

    // Send viewport info
    ws.send(JSON.stringify({
        type: 'viewport',
        width: 1280,
        height: 800
    }));

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (!cdpClient || !cdpClient.connected) return;

            switch (msg.type) {
                case 'click':
                    await cdpClient.mouseClick(msg.x, msg.y, msg.button || 'left', msg.clickCount || 1);
                    break;
                case 'dblclick':
                    await cdpClient.mouseClick(msg.x, msg.y, 'left', 2);
                    break;
                case 'scroll':
                    await cdpClient.mouseScroll(msg.x || 0, msg.y || 0, msg.deltaX || 0, msg.deltaY || 0);
                    break;
                case 'type':
                    if (msg.text) await cdpClient.insertText(msg.text);
                    break;
                case 'keydown':
                    if (msg.key) await cdpClient.pressKey(msg.key);
                    break;
                case 'request_frame':
                    if (lastFrameData) {
                        ws.send(JSON.stringify({ type: 'frame', data: lastFrameData }));
                    }
                    break;
                case 'resize':
                    if (msg.width && msg.height && cdpClient) {
                        try {
                            await cdpClient.stopScreencast();
                            await cdpClient.startScreencast(msg.width, msg.height);
                            ws.send(JSON.stringify({ type: 'viewport', width: msg.width, height: msg.height }));
                        } catch (e) { }
                    }
                    break;
                case 'ping':
                    break;
            }
        } catch (e) { }
    });
});

// Broadcast frame to all WS clients
function broadcastFrame(base64Data) {
    const msg = JSON.stringify({ type: 'frame', data: base64Data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// ========== AUTO RECONNECT ==========
setInterval(async () => {
    if (cdpClient && cdpClient.connected) return;
    const now = Date.now();
    if (now - lastReconnectTime < RECONNECT_COOLDOWN) return;
    lastReconnectTime = now;
    log('INFO', 'CDP', 'Auto-reconnecting...');
    try { await connectCDP(); } catch (e) { }
}, 1000);

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
    if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

    const localIP = await getLocalIP();
    const url = `http://${localIP}:${PORT}/?token=${AUTH_TOKEN}`;

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  📱 AntigravityHub - Remote Chat Viewer  ║');
    console.log('╚══════════════════════════════════════════╝\n');

    try {
        const qr = await qrcode.toString(url, { type: 'terminal', small: true });
        console.log(qr);
    } catch (e) { }

    console.log(`\n🔗 URL: ${url}`);
    console.log(`🔑 Token: ${AUTH_TOKEN}\n`);

    server.listen(PORT, async () => {
        log('INFO', 'SERVER', `Listening on http://0.0.0.0:${PORT}`);

        log('INFO', 'CDP', 'Discovering Antigravity targets...');
        const connected = await connectCDP();
        if (connected) {
            log('INFO', 'CDP', 'Connected! Streaming screen to mobile...');
        } else {
            log('WARN', 'CDP', 'No targets found. Will auto-reconnect every 10s.');
        }

        console.log('✅ Ready! Scan QR code with your phone.\n');
        console.log('Press Ctrl+C to stop.\n');
    });

    process.on('SIGINT', () => {
        log('INFO', 'SERVER', 'Shutting down...');
        stopScreenshotPolling();
        if (cdpClient) cdpClient.close();
        server.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
