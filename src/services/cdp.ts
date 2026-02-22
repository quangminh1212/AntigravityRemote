import http from 'http';
import { WebSocket } from 'ws';
import {
    CDPConnection,
    CDPResult,
    CDPContext,
    CDPInfo,
    CDPTarget
} from '../types';

// Track destroyed context IDs to avoid using stale ones
const destroyedContextIds = new Set<number>();

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

// Find all Antigravity CDP endpoints (with logging to aid target selection)
export async function discoverInstances(): Promise<CDPInfo[]> {
    const allInstances: CDPInfo[] = [];
    const seen = new Set<string>();

    for (const port of PORTS) {
        try {
            const list = await getJson<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);

            for (const t of list) {
                const title = t.title || '';
                const url = t.url || '';
                const type = (t as any).type || '';
                const lowerTitle = title.toLowerCase();
                const lowerUrl = url.toLowerCase();

                const isSelf = title === 'Antigravity Hub' || title === 'Antigravity Link' || title === 'Antigravity-Link';
                const isDevtools = lowerTitle.includes('devtools') || lowerUrl.includes('devtools');
                const isWebview = lowerTitle.includes('vscode-webview') || lowerUrl.includes('vscode-webview');
                const isServiceWorker = type === 'service_worker';
                const isLaunchpad = lowerTitle.includes('launchpad');
                const isBlank = title.trim().length === 0 || lowerTitle.startsWith('instance :');
                const looksChat = lowerTitle.includes('antigravity') || lowerUrl.includes('workbench') || lowerUrl.includes('jetski');

                // Keep Antigravity chat/auth/QR pages; skip launchpad/webview/devtools/no-name
                if (isSelf || isDevtools || isWebview || isServiceWorker || isLaunchpad || isBlank || !looksChat) continue;

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
                // Avoid duplicates
                if (!contexts.find(c => c.id === ctx.id)) {
                    contexts.push(ctx);
                }
                // Remove from destroyed set if re-created
                destroyedContextIds.delete(ctx.id);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const destroyedId = data.params?.executionContextId;
                if (typeof destroyedId === 'number') {
                    destroyedContextIds.add(destroyedId);
                    const idx = contexts.findIndex(c => c.id === destroyedId);
                    if (idx >= 0) contexts.splice(idx, 1);
                }
            } else if (data.method === 'Runtime.executionContextsCleared') {
                // All contexts destroyed (e.g., page navigation)
                contexts.length = 0;
            }
        } catch { }
    });

    await call("Runtime.enable", {});

    // Wait briefly for contexts to arrive
    await new Promise(r => setTimeout(r, CDP_CONTEXT_WAIT));

    return { id, ws, call, contexts, title, url };
}

// Refresh contexts by re-enabling Runtime (re-emits all current contexts)
export async function refreshContexts(cdp: CDPConnection): Promise<void> {
    // Clear existing contexts
    cdp.contexts.length = 0;
    // Re-enable Runtime - this triggers executionContextCreated for all current contexts
    try {
        await cdp.call("Runtime.disable", {});
    } catch { }
    await cdp.call("Runtime.enable", {});
    // Wait for context events to arrive
    await new Promise(r => setTimeout(r, CDP_CONTEXT_WAIT));
}
