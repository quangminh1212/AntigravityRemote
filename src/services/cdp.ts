import http from 'http';
import { WebSocket } from 'ws';
import {
    CDPConnection,
    CDPResult,
    CDPContext,
    CDPInfo,
    CDPTarget
} from '../types';

// Constants for Discovery (mirror standalone dev server)
const PORTS = [
    9000, 9001, 9002, 9003, 9004, 9005,
    9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230,
    5858
];
// Allow slower hosts to respond and contexts to initialize
const HTTP_TIMEOUT = 2000;
const CDP_CONTEXT_WAIT = 1000;

// Helper: HTTP GET JSON with timeout
function getJson<T>(url: string, timeout = HTTP_TIMEOUT): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data) as T); } catch (e) {
                    // Silent fail for JSON parse errors on non-debug pages
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(timeout, () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeout}ms`));
        });
    });
}

// Try to get Electron BrowserWindow webContents debugger URLs (works inside Antigravity without --remote-debugging-port)
function discoverElectronTargets(): CDPInfo[] {
    const results: CDPInfo[] = [];
    try {
        // Extension runs inside Electron, so we can access the electron module
        const electron = require('electron');
        const remote = electron.remote || (electron as any);
        const BrowserWindow = remote?.BrowserWindow;
        if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                try {
                    const wc = win.webContents;
                    if (!wc) continue;
                    const title = wc.getTitle() || '';
                    const url = wc.getURL() || '';
                    // Enable debugger if not already
                    if (!wc.debugger.isAttached()) {
                        wc.debugger.attach('1.3');
                    }
                    const debuggerUrl = `ws://127.0.0.1:0/devtools/page/${wc.id}`;
                    results.push({
                        id: `electron-${wc.id}`,
                        port: 0,
                        url: debuggerUrl,
                        title: title || `Electron Window ${wc.id}`
                    });
                } catch { }
            }
        }
    } catch {
        // Electron API not available (running outside Electron)
    }
    return results;
}

// Find all Antigravity CDP endpoints (with logging to aid target selection)
export async function discoverInstances(): Promise<CDPInfo[]> {
    const allInstances: CDPInfo[] = [];
    const seen = new Set<string>();

    // 1. Standard CDP port scanning
    for (const port of PORTS) {
        try {
            const list = await getJson<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);

            for (const t of list) {
                const title = t.title || '';
                const url = t.url || '';
                const type = (t as any).type || '';
                const lowerTitle = title.toLowerCase();
                const lowerUrl = url.toLowerCase();

                // Skip non-page targets
                const isServiceWorker = type === 'service_worker';
                const isChrome = lowerUrl.startsWith('chrome://') || lowerUrl.startsWith('chrome-extension://');
                const isDevtools = lowerTitle.includes('devtools') || lowerUrl.includes('devtools');
                const isBlank = title.trim().length === 0;
                // Skip our own Remote page (self-reference causes mirror effect)
                const isSelfRemote = lowerTitle === 'antigravity remote' || lowerUrl.includes(':3000');
                if (isServiceWorker || isChrome || isDevtools || isBlank || isSelfRemote) continue;

                if (!t.webSocketDebuggerUrl) continue;

                const dedupeKey = (t.webSocketDebuggerUrl || `${port}-${t.id || title}`).toLowerCase();
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);

                allInstances.push({
                    id: t.id || t.webSocketDebuggerUrl || `${port}-${title}`,
                    port,
                    url: t.webSocketDebuggerUrl,
                    title: title || `Instance :${port}`
                });
            }
        } catch (err) {
            // ignore ports that aren't serving CDP
        }
    }

    // 2. Dynamic port discovery: scan Antigravity process ports
    if (allInstances.length === 0) {
        try {
            const { execSync } = require('child_process');
            const netstat = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 });
            const antigravityPids = new Set<string>();

            // Find Antigravity PIDs
            const tasklist = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
            for (const line of tasklist.split('\n')) {
                const match = line.match(/"Antigravity\.exe","(\d+)"/);
                if (match) antigravityPids.add(match[1]);
            }

            // Find listening ports owned by Antigravity
            const dynamicPorts: number[] = [];
            for (const line of netstat.split('\n')) {
                if (!line.includes('LISTENING')) continue;
                const match = line.match(/127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/);
                if (match && antigravityPids.has(match[2])) {
                    const port = parseInt(match[1]);
                    if (!PORTS.includes(port) && port > 1024) {
                        dynamicPorts.push(port);
                    }
                }
            }

            // Try CDP on dynamic ports
            for (const port of dynamicPorts) {
                try {
                    const list = await getJson<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`, 1000);
                    for (const t of list) {
                        if (!t.webSocketDebuggerUrl) continue;
                        const title = t.title || '';
                        const url = t.url || '';
                        const type = (t as any).type || '';
                        if (type === 'service_worker') continue;
                        if (url.startsWith('chrome://')) continue;

                        const dedupeKey = t.webSocketDebuggerUrl.toLowerCase();
                        if (seen.has(dedupeKey)) continue;
                        seen.add(dedupeKey);

                        allInstances.push({
                            id: t.id || `${port}-${title}`,
                            port,
                            url: t.webSocketDebuggerUrl,
                            title: title || `Dynamic :${port}`
                        });
                    }
                } catch { }
            }
        } catch { }
    }

    return allInstances;
}

// Connect to CDP
export async function connectCDP(url: string, id: string, title?: string): Promise<CDPConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg: Buffer | string) => {
            const data = JSON.parse(msg.toString()) as { id?: number; error?: { message: string }; result?: any };
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);

        const payload: any = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;

        ws.send(JSON.stringify(payload));
    });

    const contexts: CDPContext[] = [];
    ws.on('message', (msg: Buffer | string) => {
        try {
            const data = JSON.parse(msg.toString()) as { method?: string; params?: any };
            if (data.method === 'Runtime.executionContextCreated') {
                const ctx = data.params.context;
                contexts.push(ctx);
            }
        } catch { }
    });

    await call("Runtime.enable", {});

    // Wait briefly for contexts
    await new Promise(r => setTimeout(r, CDP_CONTEXT_WAIT));

    return { id, ws, call, contexts, title, url };
}
