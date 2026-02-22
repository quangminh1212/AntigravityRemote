import express, { Router } from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import { discoverInstances, connectCDP } from '../services/cdp';
import { injectFile, injectMessage, captureSnapshot, captureSnapshotDebug, clickElement } from '../services/antigravity';
import { CDPConnection, Snapshot } from '../types';
import { authMiddleware } from '../middleware/auth';
import { securityMiddleware } from '../middleware/security';

// Config defaults (aligned with root server)
const MAX_UPLOAD_SIZE_MB = 50;
const POLL_FAST = 42;       // Realtime: ~24 FPS when content is changing
const POLL_SLOW = 100;      // Smooth idle: ~10 FPS
const POLL_FAST_DURATION = 8000; // Stay fast for 8s after last change
const HTTP_TIMEOUT = 2000;

const TOKEN_FILENAME = '.token';
const CERT_FILENAME = 'cert.pem';
const KEY_FILENAME = 'key.pem';

// =============== SERVER LOGGER ===============
const LOG_FILE = path.join(process.cwd(), 'server.log');
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const serverLog = (level: LogLevel, category: string, message: string, data?: unknown) => {
    const ts = new Date().toISOString();
    const prefix = `[${ts}][${level}][${category}]`;
    const dataStr = data ? ' ' + (typeof data === 'object' ? JSON.stringify(data) : String(data)) : '';
    const line = `${prefix} ${message}${dataStr}`;

    // Console output with level-appropriate method
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);

    // Append to log file (non-blocking)
    fs.appendFile(LOG_FILE, line + '\n', () => { });
};
// ============================================

interface State {
    cdpConnections: CDPConnection[];
    lastSnapshot: Snapshot | null;
    lastSnapshotHash: string | null;
    activePort: number | null;
    activeTargetId: string | null;
    snapshotCache: Map<number, Snapshot>;
    wssRef: WebSocketServer | null;
    pollInterval: NodeJS.Timeout | null;
}

export class AntigravityServer {
    private app: express.Express;
    private server?: http.Server | https.Server;
    private wss?: WebSocketServer;
    private uploadsDir: string;
    private publicDir: string;
    private extensionPath: string;
    private port: number;
    private useHttps: boolean;
    private _localUrl = '';
    private _secureUrl = '';
    private authToken: string;
    private state: State;
    private useAuth: boolean;
    private consecutiveSnapshotFails = 0;
    private lastChangeTime = 0;

    constructor(port: number, extensionPath: string, workspaceRoot?: string, useHttps = true) {
        this.port = port;
        this.useHttps = useHttps;
        this.extensionPath = extensionPath;
        this.app = express();
        // Prefer workspace root uploads/public (matches npm run dev), fall back to extension path
        const rootBase = workspaceRoot || process.cwd();
        const rootUploads = path.join(rootBase, 'uploads');
        const rootPublic = path.join(rootBase, 'public');
        this.uploadsDir = fs.existsSync(rootUploads) ? rootUploads : path.join(extensionPath, 'uploads');
        this.publicDir = fs.existsSync(rootPublic) ? rootPublic : path.join(extensionPath, 'public');
        this.state = {
            cdpConnections: [],
            lastSnapshot: null,
            lastSnapshotHash: null,
            activePort: null,
            activeTargetId: null,
            snapshotCache: new Map(),
            wssRef: null,
            pollInterval: null
        };
        this.useAuth = true;
        this.authToken = this.loadOrCreateToken(extensionPath);

        if (!fs.existsSync(this.uploadsDir)) {
            fs.mkdirSync(this.uploadsDir, { recursive: true });
        }

        this.configureMiddleware();
        this.configureRoutes();
        serverLog('INFO', 'SERVER', `Server instance created`, { port, useHttps, publicDir: this.publicDir });
    }

    public get localUrl() { return this._localUrl; }
    public get secureUrl() { return this._secureUrl; }
    public get token() { return this.authToken; }

    private loadOrCreateToken(basePath: string): string {
        const tokenPath = path.join(basePath, TOKEN_FILENAME);
        if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
        if (fs.existsSync(tokenPath)) {
            return fs.readFileSync(tokenPath, 'utf8').trim();
        }
        const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        fs.writeFileSync(tokenPath, token);
        return token;
    }


    private configureMiddleware() {
        this.app.use(express.json({ limit: `${MAX_UPLOAD_SIZE_MB}mb` }));
        this.app.use(express.urlencoded({ limit: `${MAX_UPLOAD_SIZE_MB}mb`, extended: true }));
        this.app.use(express.static(this.publicDir, {
            etag: false,
            maxAge: 0,
            setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); }
        }));
        if (this.useAuth) {
            this.app.use(authMiddleware(this.authToken));
        }
        this.app.use(securityMiddleware);
    }

    // CDP helpers
    private scoreTarget(target: { title?: string; url?: string }): number {
        const title = (target.title || '').toLowerCase();
        const url = (target.url || '').toLowerCase();
        let score = 0;
        if (url.includes('workbench') || url.includes('jetski')) score += 6;
        if (title.includes('antigravity-link')) score += 6;
        if (title.includes('launchpad')) score += 2; // lower priority than chat
        if (title.includes('antigravity')) score += 2;
        if (title.includes('auth.ts')) score -= 6;
        if (title.includes('qr')) score -= 6;
        if (url.includes('devtools') || title.includes('visual studio code')) score -= 8;
        if (title.includes('vscode-webview')) score -= 8;
        return score;
    }

    private isWorkbenchTarget(target: { title?: string; url?: string }): boolean {
        const title = (target.title || '').toLowerCase();
        const url = (target.url || '').toLowerCase();
        return url.includes('workbench') ||
            url.includes('jetski') ||
            title.includes('antigravity') ||
            title.includes('launchpad');
    }

    // Prefer chat targets (exclude QR/devtools/extension webviews)
    private isChatTarget(target: { title?: string; url?: string }): boolean {
        const title = (target.title || '').toLowerCase();
        const url = (target.url || '').toLowerCase();
        if (title.includes('qr')) return false;
        if (title.includes('devtools') || url.includes('devtools')) return false;
        if (title.includes('vscode-webview')) return false;
        if (title.includes('auth.ts')) return false;
        return this.isWorkbenchTarget(target);
    }

    private async initCDP(targetId?: string): Promise<void> {
        const instances = await discoverInstances();

        // Select target by id if provided, else best-scoring chat target, else best overall
        let chosen = targetId ? instances.find(i => i.id === targetId) : null;
        if (!chosen) {
            const chatTargets = instances.filter(i => this.isChatTarget(i));
            const prioritizedChat = [...chatTargets].sort((a, b) => this.scoreTarget(b) - this.scoreTarget(a));
            chosen = prioritizedChat[0] || [...instances].sort((a, b) => this.scoreTarget(b) - this.scoreTarget(a))[0];
        }

        // Close existing
        this.state.cdpConnections.forEach(c => { try { c.ws.close(); } catch { } });
        this.state.cdpConnections = [];
        this.state.activeTargetId = null;
        this.state.activePort = null;

        if (!chosen) return;

        const prioritized = [...instances].sort((a, b) => this.scoreTarget(b) - this.scoreTarget(a));
        // Try chosen first, then fall back to others if connect fails
        const candidates = [chosen, ...prioritized.filter(t => t.id !== chosen!.id)];

        for (const candidate of candidates) {
            try {
                const conn = await connectCDP(candidate.url, candidate.id, candidate.title);
                this.state.cdpConnections.push(conn);
                this.state.activePort = candidate.port;
                this.state.activeTargetId = candidate.id;
                serverLog('INFO', 'CDP', `Connected to: ${candidate.title}`, { id: candidate.id, port: candidate.port });
                break;
            } catch { }
        }

        await this.updateSnapshot();
    }

    private async updateSnapshot(): Promise<boolean> {
        if (this.state.cdpConnections.length === 0) {
            // Auto-reconnect if no CDP connections
            this.consecutiveSnapshotFails++;
            if (this.consecutiveSnapshotFails >= 5) {
                this.consecutiveSnapshotFails = 0;
                serverLog('WARN', 'CDP', `Auto-reconnecting after ${this.consecutiveSnapshotFails} consecutive failures`);
                try { await this.initCDP(); } catch { }
            }
            return false;
        }

        // Only capture from active target (first/only connection)
        const cdp = this.state.activeTargetId
            ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
            : this.state.cdpConnections[0];
        if (!cdp) return false;
        try {
            const snapshot = await captureSnapshot(cdp);
            if (snapshot && !snapshot.error) {
                this.consecutiveSnapshotFails = 0; // Reset on success
                const hash = this.hashString(snapshot.html);
                if (hash !== this.state.lastSnapshotHash) {
                    this.state.lastSnapshot = snapshot;
                    this.state.lastSnapshotHash = hash;
                    if (this.state.activePort) this.state.snapshotCache.set(this.state.activePort, snapshot);
                    this.broadcastSnapshot(snapshot);
                    this.lastChangeTime = Date.now();
                    return true;
                }
                return false;
            } else if (snapshot && snapshot.error) {
                serverLog('WARN', 'SNAPSHOT', `Capture error (${cdp.title}): ${snapshot.error}`);
                this.consecutiveSnapshotFails++;
            }
        } catch (err) {
            serverLog('ERROR', 'SNAPSHOT', `Snapshot exception: ${(err as Error).message}`);
            this.consecutiveSnapshotFails++;
        }

        // Auto-reconnect after 5 consecutive failures
        if (this.consecutiveSnapshotFails >= 5) {
            this.consecutiveSnapshotFails = 0;
            serverLog('WARN', 'CDP', 'Auto-reconnecting after consecutive snapshot errors');
            try { await this.initCDP(); } catch { }
        }

        return false;
    }

    private broadcastSnapshot(snapshot: Snapshot): void {
        if (!this.wss) return;
        const message = JSON.stringify({
            type: 'snapshot',
            data: snapshot,
            timestamp: new Date().toISOString()
        });
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    private hashString(input: string): string {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const chr = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash.toString();
    }

    private configureRoutes() {
        const router = Router();

        router.get('/ping', (_req, res) => res.send('pong'));

        router.get('/sys', (_req, res) => {
            res.json({
                interfaces: os.networkInterfaces(),
                platform: os.platform(),
                arch: os.arch(),
                uptime: os.uptime()
            });
        });

        router.get('/snapshot', (_req, res) => {
            if (!this.state.lastSnapshot) return res.status(503).json({ error: 'No snapshot available yet' });
            res.json(this.state.lastSnapshot);
        });

        router.get('/instances', async (_req, res) => {
            try {
                const instances = await discoverInstances();
                res.json({
                    activeTargetId: this.state.activeTargetId,
                    activePort: this.state.activePort,
                    instances: instances.map(i => ({ id: i.id, port: i.port, url: i.url, title: i.title }))
                });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/instance', async (req, res) => {
            const { targetId } = req.body as { targetId: string };
            if (!targetId) return res.status(400).json({ error: 'targetId required' });
            try {
                if (this.state.activeTargetId !== targetId) {
                    await this.initCDP(targetId);
                } else if (this.state.lastSnapshot) {
                    this.broadcastSnapshot(this.state.lastSnapshot);
                }
                res.json({ success: true, activeTargetId: this.state.activeTargetId, activePort: this.state.activePort });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/reconnect', async (_req, res) => {
            try {
                serverLog('INFO', 'API', 'POST /reconnect - manual CDP reconnection requested');
                this.consecutiveSnapshotFails = 0;
                await this.initCDP();
                res.json({
                    success: true,
                    activeTargetId: this.state.activeTargetId,
                    activePort: this.state.activePort,
                    connections: this.state.cdpConnections.length
                });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/send', async (req, res) => {
            const { message } = req.body as { message?: string };
            if (!message) return res.status(400).json({ error: 'Message required' });
            serverLog('INFO', 'API', `POST /send - message: "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`);
            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });
            const activeCdp = cdp;
            try {
                const result = await injectMessage(activeCdp, message);
                if (result.ok) {
                    serverLog('INFO', 'API', `Message injected via ${result.method} to ${activeCdp.title}`);
                    return res.json({ success: true, method: result.method, target: activeCdp.title });
                }
                serverLog('WARN', 'API', `Message injection failed: ${result.reason}`);
                res.status(500).json({ success: false, reason: result.reason });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/click', async (req, res) => {
            const { text, tag, x, y, selector } = req.body as { text?: string, tag?: string, x?: number, y?: number, selector?: string };
            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });
            const activeCdp = cdp;

            try {
                const result = await clickElement(activeCdp, text, tag, x, y, selector);
                if (result.success) {
                    setTimeout(() => this.updateSnapshot(), 50);
                    return res.json({ success: true, target: activeCdp.title });
                }
                res.status(404).json({ error: 'Could not find element to click in active target' });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/upload', async (req, res) => {
            const { name, content, targetSelector } = req.body as { name: string, content: string, targetSelector?: string };
            if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
            serverLog('INFO', 'API', `POST /upload - file: ${name}, selector: ${targetSelector || 'auto'}`);

            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });

            try {
                const activeCdp = cdp;
                const base64Data = content.replace(/^data:.*,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const maxBytes = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
                if (buffer.length > maxBytes) {
                    return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_SIZE_MB}MB.` });
                }
                if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
                const safeName = `${Date.now()}-${path.basename(name)}`;
                const targetPath = path.join(this.uploadsDir, safeName);
                fs.writeFileSync(targetPath, buffer);

                const injectionResult = await injectFile(activeCdp, targetPath, targetSelector);
                if (injectionResult.ok) {
                    serverLog('INFO', 'API', `File injected successfully: ${safeName}`);
                    res.json({ success: true, path: targetPath, injected: true });
                } else {
                    serverLog('WARN', 'API', `File saved but injection failed: ${injectionResult.reason || 'unknown'}`);
                    res.json({ success: true, path: targetPath, injected: false, reason: injectionResult.reason || 'injection_failed' });
                }
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        this.app.use('/', router);

        // Debug: list targets and active binding
        router.get('/debug/targets', async (_req, res) => {
            try {
                const instances = await discoverInstances();
                res.json({
                    activeTargetId: this.state.activeTargetId,
                    activePort: this.state.activePort,
                    connected: this.state.cdpConnections.map(c => ({ title: c.title, url: c.url, contexts: c.contexts.length })),
                    instances: instances.map(i => ({ id: i.id, port: i.port, title: i.title, url: i.url }))
                });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        // Debug: probe file inputs
        router.get('/debug/upload-probe', async (_req, res) => {
            const script = `(() => {
                const results = { inputs: [], buttons: [], contextHtml: '' };
                function isVisible(el) {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
                }
                function getDocs() {
                    const docs = [document];
                    const iframes = Array.from(document.querySelectorAll('iframe'));
                    for (const frame of iframes) {
                        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (e) {}
                    }
                    return docs;
                }
                function collect(doc) {
                    doc.querySelectorAll('input[type="file"]').forEach(i => {
                        results.inputs.push({ id: i.id, className: i.className, visible: isVisible(i) });
                    });
                    doc.querySelectorAll('button, [role="button"]').forEach(b => {
                        const txt = (b.textContent || '').trim();
                        const aria = b.getAttribute('aria-label') || '';
                        if (txt.length > 0 || aria.length > 0) {
                            results.buttons.push({ text: txt, aria, visible: isVisible(b) });
                        }
                    });
                    // Capture open overlays in this doc
                    const overlays = Array.from(doc.querySelectorAll('.fixed, .absolute, [role="menu"], [role="dialog"], [role="listbox"]'))
                        .filter(el => isVisible(el))
                        .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height));
                    if (overlays.length > 0 && !results.contextHtml) {
                        const top = overlays[0];
                        results.contextHtml = top.outerHTML.slice(0, 50000); // cap to avoid huge payload
                    }
                }
                getDocs().forEach(collect);
                return results;
            })()`;

            try {
                if (this.state.cdpConnections.length === 0) return res.status(503).json({ error: 'CDP not connected' });

                const allResults: any[] = [];
                for (const cdp of this.state.cdpConnections) {
                    const targetResults: any[] = [];
                    for (const ctx of cdp.contexts) {
                        try {
                            const probeResult = await cdp.call("Runtime.evaluate", {
                                expression: script,
                                returnByValue: true,
                                contextId: ctx.id
                            });
                            if (probeResult.result?.value) {
                                targetResults.push({ contextId: ctx.id, name: ctx.name, origin: ctx.origin, data: probeResult.result.value });
                            }
                        } catch (e) {
                            targetResults.push({ contextId: ctx.id, error: (e as Error).message });
                        }
                    }
                    allResults.push({ target: cdp.title, url: cdp.url, contexts: targetResults });
                }
                res.json({ success: true, targets: allResults });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        // Debug: snapshot capture diagnostics
        router.get('/debug/capture', async (_req, res) => {
            if (this.state.cdpConnections.length === 0) return res.status(503).json({ error: 'CDP not connected' });

            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });

            try {
                const result = await captureSnapshotDebug(cdp);
                res.json({
                    debugVersion: 'capture-v7',
                    target: cdp.title,
                    url: cdp.url,
                    contextCount: cdp.contexts.length,
                    errors: result.errors,
                    contexts: result.contexts,
                    snapshotOk: !!result.snapshot
                });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });
    }

    public async start(): Promise<{ localUrl: string; secureUrl: string; token: string }> {
        return new Promise(async (resolve, reject) => {
            try {
                if (this.useHttps) {
                    const certPath = path.join(this.extensionPath, CERT_FILENAME);
                    const keyPath = path.join(this.extensionPath, KEY_FILENAME);
                    let cert: string | Buffer;
                    let key: string | Buffer;
                    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
                        cert = fs.readFileSync(certPath);
                        key = fs.readFileSync(keyPath);
                    } else {
                        const attrs = [{ name: 'commonName', value: 'Antigravity Hub Extension' }];
                        // @ts-ignore
                        const pems = await selfsigned.generate(attrs, { days: 365 });
                        cert = pems.cert;
                        key = pems.private;
                        fs.writeFileSync(certPath, cert);
                        fs.writeFileSync(keyPath, key);
                    }
                    this.server = https.createServer({ key, cert }, this.app);
                } else {
                    this.server = http.createServer(this.app);
                }

                this.wss = new WebSocketServer({ server: this.server });
                this.state.wssRef = this.wss;

                this.wss.on('connection', (ws, req) => {
                    if (this.useAuth) {
                        const url = new URL(req.url || '', `http://${req.headers.host}`);
                        const token = url.searchParams.get('token');
                        const headerToken = (req.headers.authorization || '').replace('Bearer ', '');
                        if (token !== this.authToken && headerToken !== this.authToken) {
                            serverLog('WARN', 'WS', 'Unauthorized WebSocket connection attempt');
                            ws.close(1008, 'Unauthorized');
                            return;
                        }
                    }
                    serverLog('INFO', 'WS', `Client connected from ${req.socket.remoteAddress}`);
                    if (this.state.lastSnapshot) {
                        ws.send(JSON.stringify({ type: 'snapshot', data: this.state.lastSnapshot, timestamp: new Date().toISOString() }));
                    }
                    ws.on('message', async (data) => {
                        try {
                            const msg = JSON.parse(data.toString());
                            if (msg.type === 'request_snapshot' && this.state.lastSnapshot) {
                                ws.send(JSON.stringify({ type: 'snapshot', data: this.state.lastSnapshot, timestamp: new Date().toISOString() }));
                            }
                            // Forward scroll events to Antigravity via CDP
                            if (msg.type === 'scroll' && typeof msg.deltaY === 'number') {
                                const activeCdp = this.state.activeTargetId
                                    ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                                    : this.state.cdpConnections[0];
                                if (activeCdp) {
                                    try {
                                        await activeCdp.call("Runtime.evaluate", {
                                            expression: `(() => {
                                                const scrollContainers = document.querySelectorAll('[class*="overflow-y-auto"], [class*="overflow-y-scroll"], [style*="overflow"]');
                                                for (const el of scrollContainers) {
                                                    if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
                                                        el.scrollBy({ top: ${msg.deltaY}, behavior: 'auto' });
                                                        return true;
                                                    }
                                                }
                                                window.scrollBy({ top: ${msg.deltaY}, behavior: 'auto' });
                                                return false;
                                            })()`,
                                            returnByValue: true,
                                            contextId: activeCdp.contexts[0]?.id
                                        });
                                        // Trigger immediate snapshot after scroll
                                        this.lastChangeTime = Date.now();
                                        setTimeout(() => this.updateSnapshot(), 50);
                                    } catch (e) {
                                        serverLog('WARN', 'SCROLL', `Scroll forward failed: ${(e as Error).message}`);
                                    }
                                }
                            }
                        } catch { }
                    });
                });

                this.server.on('error', (e) => reject(e));

                this.server.listen(this.port, async () => {
                    const interfaces = os.networkInterfaces();
                    let localIp = 'localhost';
                    const candidates: { name: string; addr: string }[] = [];
                    for (const name of Object.keys(interfaces)) {
                        for (const iface of interfaces[name] || []) {
                            if (!iface.internal && iface.family === 'IPv4') {
                                candidates.push({ name, addr: iface.address });
                            }
                        }
                    }
                    const priorityMatch = candidates.find(c =>
                        /wi-fi|ethernet|wireless|en[0-9]|eth[0-9]/i.test(c.name)
                    );
                    const cleanIp = priorityMatch || candidates.find(c =>
                        !/virtual|vbox|wsl|vpn|tailscale/i.test(c.name)
                    ) || candidates[0];
                    if (cleanIp) localIp = cleanIp.addr;

                    const protocol = this.useHttps ? 'https' : 'http';
                    const authQuery = this.useAuth ? `?token=${this.authToken}` : '';

                    this._localUrl = `${protocol}://${localIp}:${this.port}/${authQuery}`;
                    this._secureUrl = this.useHttps ? this._localUrl : '';

                    serverLog('INFO', 'SERVER', `Server listening on ${this._localUrl}`);

                    try {
                        await this.initCDP();
                    } catch (err) {
                        serverLog('WARN', 'CDP', `Initial CDP connection failed, will keep polling: ${(err as Error).message}`);
                    }

                    // Adaptive polling: fast when content changes, slow when idle
                    const adaptivePoll = async () => {
                        await this.updateSnapshot();
                        const timeSinceChange = Date.now() - this.lastChangeTime;
                        const interval = timeSinceChange < POLL_FAST_DURATION ? POLL_FAST : POLL_SLOW;
                        this.state.pollInterval = setTimeout(() => adaptivePoll(), interval);
                    };
                    adaptivePoll();
                    serverLog('INFO', 'SERVER', `Adaptive snapshot polling started (fast: ${POLL_FAST}ms, slow: ${POLL_SLOW}ms)`);

                    resolve({
                        localUrl: this._localUrl,
                        secureUrl: this._secureUrl,
                        token: this.authToken
                    });
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    public stop() {
        serverLog('INFO', 'SERVER', 'Shutting down server...');
        if (this.state.pollInterval) clearTimeout(this.state.pollInterval);
        this.wss?.close();
        this.server?.close();
        this.state.cdpConnections.forEach(c => c.ws.close());
        serverLog('INFO', 'SERVER', 'Server stopped');
    }
}
