/**
 * AntigravityRemote - Mobile PWA Chat Client for Antigravity IDE
 * 
 * Architecture: 
 * 1. Connects to Language Server gRPC (port 50000-63999) for chat streaming
 * 2. Scans Antigravity process ports for internal APIs
 * 3. Falls back to CDP if available
 * 4. Exposes WebSocket + REST API for mobile PWA client
 * 
 * No auth tokens handled - authentication stays on Antigravity's side.
 */

import http from 'http';
import http2 from 'http2';
import { execSync } from 'child_process';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================
const CONFIG = {
    PORT: parseInt(process.env.PORT || '3000'),
    HOST: '0.0.0.0',
    RECONNECT_INTERVAL: 5000,
    POLL_INTERVAL: 2000,
    LOG_FILE: path.join(__dirname, 'debug.log'),
};

// ============================================================================
// Logger
// ============================================================================
function log(level, msg, data = '') {
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${level}] ${msg} ${data ? JSON.stringify(data) : ''}`;
    console.log(entry);
    try { fs.appendFileSync(CONFIG.LOG_FILE, entry + '\n'); } catch { /* */ }
}

// ============================================================================
// HTTP Helper
// ============================================================================
function httpGet(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function httpPost(url, body, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: 'POST',
            timeout,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(payload);
        req.end();
    });
}

// ============================================================================
// Port Discovery
// ============================================================================
function discoverPorts() {
    const result = { grpcPorts: [], antigravityPorts: [], cdpPort: null };

    try {
        // Find Language Server gRPC ports
        const lsOutput = execSync(
            'powershell -NoProfile -NonInteractive -Command "' +
            'Get-NetTCPConnection -State Listen -OwningProcess (Get-Process language_server_windows_x64 -ErrorAction SilentlyContinue).Id -ErrorAction SilentlyContinue | ' +
            'Select-Object -ExpandProperty LocalPort | Sort-Object"',
            { encoding: 'utf-8', timeout: 10000 }
        ).trim();

        if (lsOutput) {
            result.grpcPorts = lsOutput.split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p));
        }
    } catch (e) { log('WARN', 'Failed to find LS ports', e.message); }

    try {
        // Find Antigravity process ports
        const agOutput = execSync(
            'powershell -NoProfile -NonInteractive -Command "' +
            'Get-NetTCPConnection -State Listen -OwningProcess (Get-Process Antigravity -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -ErrorAction SilentlyContinue | ' +
            'Where-Object { $_.LocalPort -lt 50000 } | Select-Object -ExpandProperty LocalPort | Sort-Object"',
            { encoding: 'utf-8', timeout: 10000 }
        ).trim();

        if (agOutput) {
            result.antigravityPorts = agOutput.split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p));
        }
    } catch (e) { log('WARN', 'Failed to find AG ports', e.message); }

    // CDP from DevToolsActivePort file
    try {
        const dtFile = path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');
        if (fs.existsSync(dtFile)) {
            const port = parseInt(fs.readFileSync(dtFile, 'utf-8').trim().split(/\r?\n/)[0]);
            if (!isNaN(port)) result.cdpPort = port;
        }
    } catch { /* */ }

    return result;
}

// ============================================================================
// Antigravity Connection Manager
// ============================================================================
class AntigravityConnection {
    constructor() {
        this.grpcPort = null;
        this.internalApiPort = null;
        this.cdpPort = null;
        this.cdpWs = null;
        this.cdpConnected = false;
        this.cdpMessageId = 1;
        this.cdpPending = new Map();
        this.executionContextId = null;
        this.internalApiConfig = null;
        this.lastMessages = [];
        this.lastStatus = 'disconnected';
    }

    async initialize() {
        log('INFO', 'Discovering Antigravity connections...');
        const ports = discoverPorts();
        log('INFO', 'Discovered ports', ports);

        // Test gRPC ports
        for (const port of ports.grpcPorts) {
            try {
                const res = await httpGet(`http://127.0.0.1:${port}/`, 2000);
                if (res.status >= 400) { // gRPC returns 4xx for HTTP/1.1
                    this.grpcPort = port;
                    log('INFO', `gRPC port confirmed: ${port}`);
                    break;
                }
            } catch { /* continue */ }
        }

        // Test Antigravity internal API ports
        for (const port of ports.antigravityPorts) {
            try {
                const res = await httpGet(`http://127.0.0.1:${port}/json/list`, 2000);
                if (res.status === 200) {
                    try {
                        const config = JSON.parse(res.data);
                        if (config.clickPatterns || config.enabled !== undefined) {
                            this.internalApiPort = port;
                            this.internalApiConfig = config;
                            log('INFO', `Internal API found on port ${port}`, config);
                            continue;
                        }
                    } catch { /* */ }
                    // Could be CDP
                    try {
                        const targets = JSON.parse(res.data);
                        if (Array.isArray(targets) && targets.some(t => t.webSocketDebuggerUrl)) {
                            this.cdpPort = port;
                            log('INFO', `CDP port found: ${port}`);
                        }
                    } catch { /* */ }
                }
            } catch { /* continue */ }
        }

        // Try CDP from DevToolsActivePort if not found
        if (!this.cdpPort && ports.cdpPort) {
            try {
                await httpGet(`http://127.0.0.1:${ports.cdpPort}/json/list`, 2000);
                this.cdpPort = ports.cdpPort;
            } catch { /* */ }
        }

        // Connect CDP
        if (this.cdpPort) {
            await this.connectCdp();
        }

        return this.isConnected();
    }

    isConnected() {
        return this.cdpConnected || this.grpcPort !== null || this.internalApiPort !== null;
    }

    getStatus() {
        return {
            grpc: this.grpcPort !== null,
            cdp: this.cdpConnected,
            internalApi: this.internalApiPort !== null,
            grpcPort: this.grpcPort,
            cdpPort: this.cdpPort,
            internalApiPort: this.internalApiPort,
        };
    }

    // ---- CDP Connection ----
    async connectCdp() {
        if (!this.cdpPort) return false;
        try {
            const res = await httpGet(`http://127.0.0.1:${this.cdpPort}/json/list`, 3000);
            const targets = JSON.parse(res.data);
            const target = this.findBestCdpTarget(targets);
            if (!target) { log('WARN', 'No CDP target found'); return false; }

            log('INFO', `CDP connecting to: ${target.title}`);

            return new Promise((resolve) => {
                this.cdpWs = new WebSocket(target.webSocketDebuggerUrl);

                this.cdpWs.on('open', async () => {
                    this.cdpConnected = true;
                    log('INFO', 'CDP connected');
                    await this.cdpSend('Runtime.enable');
                    resolve(true);
                });

                this.cdpWs.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id && this.cdpPending.has(msg.id)) {
                            this.cdpPending.get(msg.id)(msg);
                            this.cdpPending.delete(msg.id);
                        }
                        if (msg.method === 'Runtime.executionContextCreated') {
                            const ctx = msg.params?.context;
                            if (ctx && (ctx.origin?.includes('vscode') || ctx.auxData?.isDefault)) {
                                this.executionContextId = ctx.id;
                            }
                        }
                    } catch { /* */ }
                });

                this.cdpWs.on('close', () => { this.cdpConnected = false; log('WARN', 'CDP closed'); });
                this.cdpWs.on('error', (e) => { this.cdpConnected = false; resolve(false); });

                setTimeout(() => { if (!this.cdpConnected) resolve(false); }, 8000);
            });
        } catch (e) {
            log('WARN', 'CDP connect error', e.message);
            return false;
        }
    }

    findBestCdpTarget(targets) {
        if (!Array.isArray(targets)) return null;
        return targets
            .map(t => ({ t, s: this.scoreCdpTarget(t) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s)[0]?.t || null;
    }

    scoreCdpTarget(t) {
        let s = 0;
        const title = (t.title || '').toLowerCase();
        const url = (t.url || '').toLowerCase();
        if (title.includes('workbench') || url.includes('workbench')) s += 100;
        if (title.includes('antigravity')) s += 50;
        if (t.type === 'page') s += 30;
        if (t.webSocketDebuggerUrl) s += 10;
        return s;
    }

    cdpSend(method, params = {}) {
        if (!this.cdpWs || !this.cdpConnected) return Promise.resolve(null);
        const id = this.cdpMessageId++;
        return new Promise((resolve) => {
            this.cdpPending.set(id, resolve);
            this.cdpWs.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.cdpPending.has(id)) { this.cdpPending.delete(id); resolve(null); } }, 10000);
        });
    }

    async cdpEval(expression) {
        const r = await this.cdpSend('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
            ...(this.executionContextId ? { contextId: this.executionContextId } : {}),
        });
        return r?.result?.result?.value;
    }

    // ---- Chat Operations ----
    async getChatMessages() {
        if (!this.cdpConnected) return this.lastMessages;

        const val = await this.cdpEval(`
      (function() {
        const msgs = [];
        const selectors = ['.agentic-chat-turn', '.chat-turn', '.interactive-item', '.monaco-list-row'];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            els.forEach((el, i) => {
              const text = el.innerText?.trim();
              if (text && text.length > 2) {
                const isUser = el.classList.contains('request') || el.querySelector('.codicon-account') !== null || el.closest('.user-turn') !== null;
                msgs.push({ id: i, role: isUser ? 'user' : 'assistant', content: text.substring(0, 8000), ts: Date.now() });
              }
            });
            break;
          }
        }
        if (msgs.length === 0) {
          const panel = document.querySelector('.interactive-session, [class*="chat"]');
          if (panel) {
            const items = panel.querySelectorAll('[class*="turn"], [class*="item"]');
            items.forEach((t, i) => {
              const text = t.innerText?.trim();
              if (text && text.length > 2) msgs.push({ id: i, role: i % 2 === 0 ? 'user' : 'assistant', content: text.substring(0, 8000), ts: Date.now() });
            });
          }
        }
        return JSON.stringify(msgs);
      })()
    `);

        try {
            const msgs = JSON.parse(val || '[]');
            if (msgs.length > 0) this.lastMessages = msgs;
            return msgs;
        } catch { return this.lastMessages; }
    }

    async getAgentStatus() {
        if (!this.cdpConnected) return { status: this.lastStatus, pendingApprovals: [] };

        const val = await this.cdpEval(`
      (function() {
        const spinners = document.querySelectorAll('.codicon-loading, [class*="spinner"], [class*="progress"]');
        const isThinking = Array.from(spinners).some(el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; });
        
        const btns = document.querySelectorAll('button');
        const approvals = [];
        btns.forEach(btn => {
          const t = btn.innerText?.trim();
          if (btn.offsetParent && t && ['Allow', 'Accept', 'Run', 'Approve', 'Continue', 'Always Allow', 'Keep Waiting', 'Retry'].some(p => t.includes(p))) {
            approvals.push({ text: t, cls: btn.className?.substring(0, 60) });
          }
        });
        
        return JSON.stringify({ status: isThinking ? 'thinking' : approvals.length > 0 ? 'waiting_approval' : 'idle', pendingApprovals: approvals });
      })()
    `);

        try {
            const status = JSON.parse(val || '{}');
            this.lastStatus = status.status || 'unknown';
            return status;
        } catch { return { status: 'unknown', pendingApprovals: [] }; }
    }

    async sendChatMessage(text) {
        if (!this.cdpConnected) return { success: false, error: 'CDP not connected' };

        const escapedText = JSON.stringify(text);
        const val = await this.cdpEval(`
      (function() {
        const selectors = [
          '.interactive-input-part .monaco-editor textarea',
          '[class*="chat-input"] textarea',
          '.interactive-input [contenteditable="true"]',
          '[class*="chat"] [contenteditable="true"]',
        ];
        let el = null;
        for (const s of selectors) { el = document.querySelector(s); if (el) break; }
        if (!el) {
          const areas = document.querySelectorAll('.monaco-editor textarea');
          for (const a of areas) { if (a.closest('.interactive-input-part, [class*="chat"]')) { el = a; break; } }
        }
        if (!el) return JSON.stringify({ success: false, error: 'Input not found' });

        el.focus();
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, ${escapedText});
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${escapedText});
        }

        setTimeout(() => {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }, 150);

        return JSON.stringify({ success: true });
      })()
    `);

        try { return JSON.parse(val || '{}'); }
        catch { return { success: false, error: 'Parse error' }; }
    }

    async clickApprovalButton(buttonText = 'Accept') {
        if (!this.cdpConnected) return { success: false, error: 'CDP not connected' };

        const val = await this.cdpEval(`
      (function() {
        const patterns = ['Allow', 'Accept', 'Run', 'Approve', 'Continue', 'Always Allow', 'Keep Waiting', 'Retry', 'Allow Once'];
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const t = btn.innerText?.trim();
          if (btn.offsetParent && t && patterns.some(p => t.includes(p))) {
            btn.click();
            return JSON.stringify({ success: true, clicked: t });
          }
        }
        return JSON.stringify({ success: false, error: 'No approval button found' });
      })()
    `);

        try { return JSON.parse(val || '{}'); }
        catch { return { success: false }; }
    }

    disconnect() {
        if (this.cdpWs) { this.cdpWs.close(); this.cdpWs = null; }
        this.cdpConnected = false;
    }
}

// ============================================================================
// Main Server
// ============================================================================
class AntigravityRemote {
    constructor() {
        this.app = express();
        this.server = null;
        this.wss = null;
        this.conn = new AntigravityConnection();
        this.clients = new Set();
        this.pollingTimer = null;
        this.lastStateHash = '';
        this.lastState = { messages: [], status: 'disconnected', pendingApprovals: [] };
    }

    async start() {
        log('INFO', '=== AntigravityRemote v1.0 starting ===');

        // Express setup
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));
        this.setupRoutes();

        // HTTP + WebSocket server
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });
        this.wss.on('connection', (ws) => this.onWsConnect(ws));

        // Start listening
        this.server.listen(CONFIG.PORT, CONFIG.HOST, () => {
            const ip = this.getLocalIp();
            console.log('\n  ⚡ AntigravityRemote v1.0\n');
            console.log(`  Local:   http://localhost:${CONFIG.PORT}`);
            console.log(`  Network: http://${ip}:${CONFIG.PORT}`);
            console.log('  \n  Open on your phone to control Antigravity remotely.\n');
            log('INFO', `Server listening on http://${ip}:${CONFIG.PORT}`);
        });

        // Connect to Antigravity
        await this.conn.initialize();
        log('INFO', 'Connection status', this.conn.getStatus());

        // Start polling
        this.startPolling();
    }

    setupRoutes() {
        // Send message
        this.app.post('/api/send', async (req, res) => {
            const { message } = req.body;
            if (!message) return res.status(400).json({ error: 'message required' });
            log('INFO', 'Send message', { len: message.length });
            const result = await this.conn.sendChatMessage(message);
            res.json(result);
        });

        // Approve action
        this.app.post('/api/approve', async (req, res) => {
            log('INFO', 'Approve action');
            const result = await this.conn.clickApprovalButton(req.body?.text);
            res.json(result);
        });

        // Get status
        this.app.get('/api/status', (req, res) => {
            res.json({ connection: this.conn.getStatus(), state: this.lastState, clients: this.clients.size });
        });

        // Get messages
        this.app.get('/api/messages', async (req, res) => {
            const msgs = await this.conn.getChatMessages();
            res.json(msgs);
        });

        // Reconnect
        this.app.post('/api/reconnect', async (req, res) => {
            log('INFO', 'Manual reconnect');
            this.conn.disconnect();
            await this.conn.initialize();
            res.json(this.conn.getStatus());
        });

        // PWA manifest (inlined for simplicity)
        this.app.get('/manifest.json', (req, res) => {
            res.json({
                name: 'AntigravityRemote',
                short_name: 'AGRemote',
                description: 'Mobile chat client for Antigravity IDE',
                start_url: '/',
                display: 'standalone',
                background_color: '#0a0a0f',
                theme_color: '#6366f1',
                orientation: 'any',
                icons: [
                    { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
                    { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
                ],
            });
        });
    }

    // ---- WebSocket ----
    onWsConnect(ws) {
        this.clients.add(ws);
        log('INFO', `WS client connected (${this.clients.size} total)`);

        // Send current state
        ws.send(JSON.stringify({ type: 'init', ...this.conn.getStatus(), ...this.lastState }));

        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'send_message' && msg.message) {
                    const r = await this.conn.sendChatMessage(msg.message);
                    ws.send(JSON.stringify({ type: 'send_result', ...r }));
                } else if (msg.type === 'approve') {
                    const r = await this.conn.clickApprovalButton(msg.text);
                    ws.send(JSON.stringify({ type: 'approve_result', ...r }));
                } else if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }));
                }
            } catch { /* */ }
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            log('INFO', `WS client disconnected (${this.clients.size} total)`);
        });
    }

    broadcast(data) {
        const payload = JSON.stringify(data);
        for (const ws of this.clients) {
            try { if (ws.readyState === 1) ws.send(payload); } catch { /* */ }
        }
    }

    // ---- Polling ----
    startPolling() {
        this.pollingTimer = setInterval(async () => {
            if (this.clients.size === 0) return;

            // Auto-reconnect
            if (!this.conn.isConnected()) {
                await this.conn.initialize();
                this.broadcast({ type: 'connection_status', ...this.conn.getStatus() });
            }

            if (!this.conn.cdpConnected) return;

            try {
                const [messages, statusInfo] = await Promise.all([
                    this.conn.getChatMessages(),
                    this.conn.getAgentStatus(),
                ]);

                const newState = {
                    messages: Array.isArray(messages) ? messages : [],
                    status: statusInfo?.status || 'unknown',
                    pendingApprovals: statusInfo?.pendingApprovals || [],
                    timestamp: Date.now(),
                };

                // Detect change
                const hash = JSON.stringify({
                    mc: newState.messages.length,
                    st: newState.status,
                    ac: newState.pendingApprovals.length,
                    lm: newState.messages[newState.messages.length - 1]?.content?.substring(0, 80),
                });

                if (hash !== this.lastStateHash) {
                    this.lastStateHash = hash;
                    this.lastState = newState;
                    this.broadcast({ type: 'state_update', ...newState });
                }
            } catch (e) {
                log('ERROR', 'Poll error', e.message);
            }
        }, CONFIG.POLL_INTERVAL);
    }

    getLocalIp() {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) return net.address;
            }
        }
        return '127.0.0.1';
    }
}

// ============================================================================
// Start
// ============================================================================
const app = new AntigravityRemote();
app.start().catch((err) => {
    log('ERROR', 'Fatal', err.message);
    process.exit(1);
});
