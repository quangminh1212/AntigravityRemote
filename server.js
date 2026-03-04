const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const CDP = require('chrome-remote-interface');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ─── Configuration ────────────────────────────────────────────
function getCdpPortCandidates() {
    // User specified via env → only try that
    if (process.env.CDP_PORT) return [parseInt(process.env.CDP_PORT)];

    const candidates = new Set();

    // Read DevToolsActivePort files
    const dtapPaths = [
        path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort'),
        path.join(process.env.APPDATA || '', 'Windsurf', 'DevToolsActivePort'),
    ];
    for (const dtap of dtapPaths) {
        try {
            const content = fs.readFileSync(dtap, 'utf8').trim();
            const port = parseInt(content.split('\n')[0].trim());
            if (port > 0 && port < 65536) {
                console.log(`[AUTO-DETECT] Read port ${port} from ${path.basename(path.dirname(dtap))}/${path.basename(dtap)}`);
                candidates.add(port);
            }
        } catch (_) { /* file not found */ }
    }

    // Always try common Electron/Chrome CDP ports
    [9222, 9229, 9333].forEach(p => candidates.add(p));

    return [...candidates];
}

async function probeCdpPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    resolve({ port, ok: true, browser: info.Browser || 'unknown' });
                } catch (_) {
                    resolve({ port, ok: false });
                }
            });
        });
        req.on('error', () => resolve({ port, ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ port, ok: false }); });
    });
}

async function detectCdpPort() {
    const candidates = getCdpPortCandidates();
    console.log(`[AUTO-DETECT] Scanning CDP ports: ${candidates.join(', ')}`);

    for (const port of candidates) {
        const result = await probeCdpPort(port);
        if (result.ok) {
            console.log(`[AUTO-DETECT] ✓ CDP found on port ${port} (${result.browser})`);
            return port;
        }
        console.log(`[AUTO-DETECT] ✗ Port ${port} - no CDP response`);
    }

    console.log(`[AUTO-DETECT] No CDP port found, defaulting to ${candidates[0] || 9333}`);
    return candidates[0] || 9333;
}

const CONFIG = {
    port: parseInt(process.env.PORT || '3000'),
    cdpPort: null, // will be set in init
    cdpHost: process.env.CDP_HOST || 'localhost',
    screenshotQuality: parseInt(process.env.QUALITY || '60'),
    maxFPS: parseInt(process.env.MAX_FPS || '15'),
    logFile: path.join(__dirname, 'debug.log'),
};

// ─── Logging ──────────────────────────────────────────────────
function log(level, msg, ...args) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg} ${args.length ? JSON.stringify(args) : ''}`;
    console.log(line);
    try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) { /* noop */ }
}

// ─── Express + HTTP Server ────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);

// ─── CDP Connection Manager ──────────────────────────────────
let cdpClient = null;
let cdpPage = null;
let cdpInput = null;
let cdpRuntime = null;
let isConnected = false;
let lastScreenshot = null;
let screenshotInProgress = false;

// ─── Chat History ────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, 'chat-history.json');
let chatHistory = [];

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch (_) { chatHistory = []; }
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    } catch (_) { /* noop */ }
}

function addToHistory(role, text) {
    const entry = { role, text, ts: Date.now() };
    chatHistory.push(entry);
    // Keep last 200 messages
    if (chatHistory.length > 200) chatHistory = chatHistory.slice(-200);
    saveHistory();
    return entry;
}

loadHistory();

// ─── Antigravity Launcher ─────────────────────────────────────
let antigravityProcess = null;

async function findAntigravityPath() {
    const possiblePaths = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Windsurf', 'Windsurf.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

async function launchAntigravity() {
    const exePath = await findAntigravityPath();
    if (!exePath) {
        log('WARN', 'Antigravity executable not found');
        return false;
    }

    log('INFO', `Launching Antigravity from: ${exePath}`);
    try {
        antigravityProcess = execFile(exePath, [
            `--remote-debugging-port=${CONFIG.cdpPort}`,
        ], { detached: true, stdio: 'ignore' });
        antigravityProcess.unref();

        // Wait for CDP to become available
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
                log('INFO', 'Antigravity CDP is ready');
                return true;
            } catch (_) {
                log('INFO', `Waiting for CDP... (${i + 1}/30)`);
            }
        }
        log('WARN', 'Timeout waiting for Antigravity CDP');
        return false;
    } catch (err) {
        log('ERROR', 'Failed to launch Antigravity:', err.message);
        return false;
    }
}

async function findWorkbenchTarget(preferAgent = false) {
    try {
        const targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
        log('INFO', `Found ${targets.length} CDP targets`);

        // Priority scoring for targets
        let best = null;
        let bestScore = -1;
        const serverUrl = `localhost:${CONFIG.port}`;

        for (const t of targets) {
            log('INFO', `  Target: ${t.type} - ${t.title} - ${t.url}`);
            if (t.type !== 'page') continue;

            let score = 0;

            // Skip our own web server pages
            if (t.url && t.url.includes(serverUrl)) {
                log('INFO', `    ↳ Skipped (own server)`);
                continue;
            }

            // Highest priority: jetski-agent (the agent panel itself)
            if (t.url && t.url.includes('jetski-agent')) {
                score = preferAgent ? 120 : 90;
            }
            // High priority: workbench pages (VS Code / Antigravity main UI)
            else if (t.url && (t.url.includes('workbench.html') || t.url.includes('workbench.desktop'))) {
                score = 100;
            }
            // Medium priority: vscode-file protocol
            else if (t.url && t.url.includes('vscode-file://')) {
                score = 80;
            }
            // Medium: any page with cascade/antigravity in title
            else if (t.title && /antigravity|cascade|agent/i.test(t.title)) {
                score = 70;
            }
            // chrome:// pages - low priority
            else if (t.url && t.url.startsWith('chrome://')) {
                if (t.url.includes('footer')) continue;
                score = 5;
            }
            // Any other page
            else {
                score = 10;
            }

            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }

        if (best) {
            log('INFO', `  → Selected target (score=${bestScore}): ${best.title || best.url}`);
        }
        return best;
    } catch (err) {
        log('ERROR', 'Failed to list CDP targets:', err.message);
        return null;
    }
}

async function connectCDP() {
    if (isConnected) return true;

    // Disconnect old client if any
    if (cdpClient) {
        try { await cdpClient.close(); } catch (_) { }
        cdpClient = null;
    }

    try {
        const target = await findWorkbenchTarget();
        if (!target) {
            log('WARN', 'No suitable CDP target found');
            return false;
        }

        log('INFO', `Connecting to CDP target: ${target.title || target.url}`);
        cdpClient = await CDP({ host: CONFIG.cdpHost, port: CONFIG.cdpPort, target });

        cdpPage = cdpClient.Page;
        cdpInput = cdpClient.Input;
        cdpRuntime = cdpClient.Runtime;

        await cdpPage.enable();

        isConnected = true;
        log('INFO', 'CDP connected successfully');

        cdpClient.on('disconnect', () => {
            log('WARN', 'CDP disconnected');
            isConnected = false;
            cdpClient = null;
            // Auto-reconnect after 2 seconds
            setTimeout(() => connectCDP(), 2000);
        });

        return true;
    } catch (err) {
        log('ERROR', 'CDP connect failed:', err.message);
        isConnected = false;
        return false;
    }
}

async function captureScreenshot() {
    if (!isConnected || screenshotInProgress) return lastScreenshot;
    screenshotInProgress = true;

    try {
        const result = await cdpPage.captureScreenshot({
            format: 'jpeg',
            quality: CONFIG.screenshotQuality,
            fromSurface: true,
        });
        lastScreenshot = result.data;
        return lastScreenshot;
    } catch (err) {
        log('ERROR', 'Screenshot failed:', err.message);
        if (err.message.includes('not attached') || err.message.includes('closed')) {
            isConnected = false;
        }
        return lastScreenshot;
    } finally {
        screenshotInProgress = false;
    }
}

async function sendMouseEvent(type, x, y, button = 'left', clickCount = 1) {
    if (!isConnected) return false;
    try {
        await cdpInput.dispatchMouseEvent({
            type,
            x: Math.round(x),
            y: Math.round(y),
            button,
            clickCount,
        });
        return true;
    } catch (err) {
        log('ERROR', 'Mouse event failed:', err.message);
        return false;
    }
}

async function sendKeyEvent(type, key, code, modifiers = 0) {
    if (!isConnected) return false;
    try {
        const params = { type, modifiers };

        if (type === 'char') {
            params.text = key;
        } else {
            params.key = key;
            params.code = code || '';
            if (key.length === 1) {
                params.text = type === 'keyDown' ? key : '';
            }
        }

        await cdpInput.dispatchKeyEvent(params);
        return true;
    } catch (err) {
        log('ERROR', 'Key event failed:', err.message);
        return false;
    }
}

async function sendScrollEvent(x, y, deltaX, deltaY) {
    if (!isConnected) return false;
    try {
        await cdpInput.dispatchMouseEvent({
            type: 'mouseWheel',
            x: Math.round(x),
            y: Math.round(y),
            deltaX: Math.round(deltaX),
            deltaY: Math.round(deltaY),
        });
        return true;
    } catch (err) {
        log('ERROR', 'Scroll event failed:', err.message);
        return false;
    }
}

// ─── Get viewport dimensions ─────────────────────────────────
async function getViewportSize() {
    if (!isConnected) return { width: 1280, height: 800 };
    try {
        const { result } = await cdpRuntime.evaluate({
            expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })',
            returnByValue: true,
        });
        return JSON.parse(result.value);
    } catch (err) {
        return { width: 1280, height: 800 };
    }
}

// ─── WebSocket Server ─────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws) => {
    log('INFO', 'Mobile client connected');

    let streamInterval = null;
    let isStreaming = false;

    // Try connecting to CDP
    const connected = await connectCDP();
    const viewport = await getViewportSize();

    ws.send(JSON.stringify({
        type: 'status',
        connected,
        viewport,
    }));

    // Send initial screenshot
    if (connected) {
        const screenshot = await captureScreenshot();
        if (screenshot) {
            ws.send(JSON.stringify({ type: 'frame', data: screenshot }));
        }
    }

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            switch (msg.type) {
                case 'connect':
                    const ok = await connectCDP();
                    const vp = await getViewportSize();
                    ws.send(JSON.stringify({ type: 'status', connected: ok, viewport: vp }));
                    if (ok) {
                        const ss = await captureScreenshot();
                        if (ss) ws.send(JSON.stringify({ type: 'frame', data: ss }));
                    }
                    break;

                case 'click':
                    await sendMouseEvent('mousePressed', msg.x, msg.y, 'left', 1);
                    await sendMouseEvent('mouseReleased', msg.x, msg.y, 'left', 1);
                    // Capture screenshot after interaction
                    setTimeout(async () => {
                        const ss = await captureScreenshot();
                        if (ss && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'frame', data: ss }));
                        }
                    }, 150);
                    break;

                case 'mousemove':
                    await sendMouseEvent('mouseMoved', msg.x, msg.y);
                    break;

                case 'mousedown':
                    await sendMouseEvent('mousePressed', msg.x, msg.y, 'left', 1);
                    break;

                case 'mouseup':
                    await sendMouseEvent('mouseReleased', msg.x, msg.y, 'left', 1);
                    setTimeout(async () => {
                        const ss = await captureScreenshot();
                        if (ss && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'frame', data: ss }));
                        }
                    }, 150);
                    break;

                case 'scroll':
                    await sendScrollEvent(msg.x, msg.y, msg.deltaX || 0, msg.deltaY || 0);
                    setTimeout(async () => {
                        const ss = await captureScreenshot();
                        if (ss && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'frame', data: ss }));
                        }
                    }, 100);
                    break;

                case 'key':
                    if (msg.text) {
                        // Type text character by character
                        for (const char of msg.text) {
                            await sendKeyEvent('char', char);
                        }
                    } else {
                        await sendKeyEvent('keyDown', msg.key, msg.code, msg.modifiers || 0);
                        await sendKeyEvent('keyUp', msg.key, msg.code, msg.modifiers || 0);
                    }
                    setTimeout(async () => {
                        const ss = await captureScreenshot();
                        if (ss && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'frame', data: ss }));
                        }
                    }, 200);
                    break;

                case 'stream-start':
                    if (!isStreaming) {
                        isStreaming = true;
                        const interval = Math.max(1000 / CONFIG.maxFPS, 66); // Min ~15fps
                        streamInterval = setInterval(async () => {
                            if (ws.readyState !== 1) {
                                clearInterval(streamInterval);
                                isStreaming = false;
                                return;
                            }
                            const ss = await captureScreenshot();
                            if (ss) {
                                ws.send(JSON.stringify({ type: 'frame', data: ss }));
                            }
                        }, interval);
                    }
                    break;

                case 'stream-stop':
                    if (streamInterval) {
                        clearInterval(streamInterval);
                        streamInterval = null;
                        isStreaming = false;
                    }
                    break;

                case 'refresh':
                    const freshSS = await captureScreenshot();
                    if (freshSS) {
                        ws.send(JSON.stringify({ type: 'frame', data: freshSS }));
                    }
                    break;

                case 'chat':
                    if (!isConnected || !cdpClient) {
                        ws.send(JSON.stringify({ type: 'chat-error', error: 'CDP chưa kết nối. Hãy kết nối Antigravity trước.' }));
                        break;
                    }
                    try {
                        const chatText = msg.text || '';
                        log('INFO', `Chat message: ${chatText.substring(0, 50)}...`);
                        addToHistory('user', chatText);

                        ws.send(JSON.stringify({ type: 'chat-status', text: 'Đang tìm Agent chat input...', status: 'info' }));

                        // Deep Shadow DOM search expression
                        const deepSearchExpr = `
                            (function() {
                                function deepQuery(root, selectors) {
                                    for (const sel of selectors) {
                                        const el = root.querySelector(sel);
                                        if (el && (el.offsetParent !== null || el.offsetHeight > 0 || getComputedStyle(el).display !== 'none')) {
                                            return { element: el, selector: sel, depth: 0 };
                                        }
                                    }
                                    const allElements = root.querySelectorAll('*');
                                    for (const el of allElements) {
                                        if (el.shadowRoot) {
                                            const result = deepQuery(el.shadowRoot, selectors);
                                            if (result) { result.depth++; return result; }
                                        }
                                    }
                                    const iframes = root.querySelectorAll('iframe, webview');
                                    for (const iframe of iframes) {
                                        try {
                                            const doc = iframe.contentDocument || iframe.contentWindow?.document;
                                            if (doc) {
                                                const result = deepQuery(doc, selectors);
                                                if (result) { result.depth++; return result; }
                                            }
                                        } catch(e) {}
                                    }
                                    return null;
                                }
                                const selectors = [
                                    'textarea[class*="inputarea"]',
                                    'textarea[class*="input-area"]',
                                    'textarea[class*="chat-input"]',
                                    'textarea[aria-label*="chat"]',
                                    'textarea[aria-label*="Chat"]',
                                    'textarea[aria-label*="agent"]',
                                    'textarea[aria-label*="Agent"]',
                                    'textarea[placeholder*="message"]',
                                    'textarea[placeholder*="Message"]',
                                    'textarea[placeholder*="Ask"]',
                                    'textarea[placeholder*="ask"]',
                                    'div[class*="agent"] textarea',
                                    'div[class*="chat"] textarea',
                                    'div[class*="cascade"] textarea',
                                    '.monaco-inputbox textarea',
                                    'textarea.inputarea',
                                    'textarea',
                                ];
                                const result = deepQuery(document, selectors);
                                if (result) {
                                    result.element.focus();
                                    result.element.click();
                                    return { found: true, selector: result.selector, depth: result.depth, tag: result.element.tagName };
                                }
                                return { found: false, searched: selectors.length };
                            })()
                        `;

                        // Strategy: try multiple CDP targets to find the one with the agent textarea
                        // Priority order: jetski-agent (Launchpad) > workbench > other pages
                        let targets = [];
                        try {
                            targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
                        } catch (_) { }

                        // Sort targets: jetski-agent first, then workbench, then others
                        const pageTargets = targets.filter(t => t.type === 'page' && !t.url?.includes(`localhost:${CONFIG.port}`));
                        pageTargets.sort((a, b) => {
                            const aScore = a.url?.includes('jetski-agent') ? 3 : a.url?.includes('workbench.html') ? 2 : 1;
                            const bScore = b.url?.includes('jetski-agent') ? 3 : b.url?.includes('workbench.html') ? 2 : 1;
                            return bScore - aScore;
                        });

                        let chatSent = false;

                        // First try with the current main CDP connection
                        const mainResult = await cdpClient.Runtime.evaluate({ expression: deepSearchExpr, returnByValue: true });
                        const mainValue = mainResult.result && mainResult.result.value;

                        if (mainValue && mainValue.found) {
                            log('INFO', `Found textarea on main target: ${mainValue.selector} (depth=${mainValue.depth})`);
                            ws.send(JSON.stringify({ type: 'chat-status', text: `Input found on main target (${mainValue.selector})`, status: 'success' }));
                            await cdpClient.Input.insertText({ text: chatText });
                            await new Promise(r => setTimeout(r, 150));
                            await sendKeyEvent('keyDown', 'Enter', 'Enter', 0);
                            await sendKeyEvent('keyUp', 'Enter', 'Enter', 0);
                            chatSent = true;
                        }

                        // If not found on main target, try other targets
                        if (!chatSent) {
                            for (const target of pageTargets) {
                                if (chatSent) break;
                                log('INFO', `Trying target: ${target.title} (${target.url?.substring(0, 80)})`);
                                ws.send(JSON.stringify({ type: 'chat-status', text: `Thử target: ${target.title || 'unknown'}...`, status: 'info' }));

                                let tempClient = null;
                                try {
                                    tempClient = await CDP({ host: CONFIG.cdpHost, port: CONFIG.cdpPort, target });
                                    await tempClient.Page.enable();
                                    await tempClient.Runtime.enable();

                                    const result = await tempClient.Runtime.evaluate({ expression: deepSearchExpr, returnByValue: true });
                                    const val = result.result && result.result.value;

                                    if (val && val.found) {
                                        log('INFO', `Found textarea on target "${target.title}": ${val.selector} (depth=${val.depth})`);
                                        ws.send(JSON.stringify({ type: 'chat-status', text: `Input found: ${target.title} (${val.selector})`, status: 'success' }));

                                        // Focus and insert text on this target
                                        await tempClient.Input.insertText({ text: chatText });
                                        await new Promise(r => setTimeout(r, 150));

                                        // Send Enter key via this target's Input domain
                                        await tempClient.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                                        await tempClient.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                                        chatSent = true;
                                    }
                                } catch (err) {
                                    log('WARN', `Failed to check target "${target.title}": ${err.message}`);
                                } finally {
                                    if (tempClient && !chatSent) {
                                        try { await tempClient.close(); } catch (_) { }
                                    } else if (tempClient && chatSent) {
                                        // Keep connection briefly for response, then close
                                        setTimeout(async () => {
                                            try { await tempClient.close(); } catch (_) { }
                                        }, 5000);
                                    }
                                }
                            }
                        }

                        if (chatSent) {
                            // Wait then try to capture response
                            await new Promise(r => setTimeout(r, 2000));
                            try {
                                const responseResult = await cdpClient.Runtime.evaluate({
                                    expression: `
                                        (function() {
                                            function deepQueryAll(root, selectors) {
                                                let results = [];
                                                for (const sel of selectors) { results.push(...root.querySelectorAll(sel)); }
                                                const allEls = root.querySelectorAll('*');
                                                for (const el of allEls) {
                                                    if (el.shadowRoot) { results.push(...deepQueryAll(el.shadowRoot, selectors)); }
                                                }
                                                return results;
                                            }
                                            const msgs = deepQueryAll(document, ['[class*="assistant"]','[class*="response"]','[class*="markdown"]','[class*="message-body"]']);
                                            if (msgs.length) {
                                                return { text: msgs[msgs.length - 1].textContent?.substring(0, 2000) || '', found: true };
                                            }
                                            return { text: '', found: false };
                                        })()
                                    `,
                                    returnByValue: true,
                                });
                                const respValue = responseResult.result && responseResult.result.value;
                                if (respValue && respValue.found && respValue.text) {
                                    addToHistory('assistant', respValue.text);
                                    ws.send(JSON.stringify({ type: 'chat-response', text: respValue.text }));
                                } else {
                                    const fallbackText = `✅ Đã gửi tin nhắn đến Antigravity Agent: "${chatText.substring(0, 100)}"\n\nAgent đang xử lý... Kiểm tra Antigravity để xem kết quả.`;
                                    addToHistory('assistant', fallbackText);
                                    ws.send(JSON.stringify({ type: 'chat-response', text: fallbackText }));
                                }
                            } catch (_) {
                                const fallbackText = `✅ Đã gửi tin nhắn: "${chatText.substring(0, 100)}"`;
                                addToHistory('assistant', fallbackText);
                                ws.send(JSON.stringify({ type: 'chat-response', text: fallbackText }));
                            }
                        } else {
                            log('WARN', `Chat input not found in any of ${pageTargets.length} targets`);
                            ws.send(JSON.stringify({
                                type: 'chat-response',
                                text: `Không tìm thấy chat input trong ${pageTargets.length} CDP targets.\n\n🔧 Hãy đảm bảo:\n1. Agent panel đang mở (Ctrl+Shift+I)\n2. Antigravity đã được khởi chạy với --remote-debugging-port\n3. Thử Reconnect CDP`
                            }));
                        }
                    } catch (chatErr) {
                        log('ERROR', 'Chat error:', chatErr.message);
                        ws.send(JSON.stringify({ type: 'chat-error', error: chatErr.message }));
                    }
                    break;

                case 'list-targets':
                    try {
                        const targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
                        ws.send(JSON.stringify({
                            type: 'targets-list',
                            targets: targets.map(t => ({
                                id: t.id,
                                type: t.type,
                                title: t.title,
                                url: t.url,
                            }))
                        }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'chat-error',
                            error: `Không thể lấy CDP targets: ${err.message}`
                        }));
                    }
                    break;

                case 'get-history':
                    ws.send(JSON.stringify({
                        type: 'history',
                        messages: chatHistory.slice(-100)
                    }));
                    break;
            }
        } catch (err) {
            log('ERROR', 'WS message error:', err.message);
        }
    });

    ws.on('close', () => {
        log('INFO', 'Mobile client disconnected');
        if (streamInterval) {
            clearInterval(streamInterval);
        }
    });
});

// ─── REST API ─────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
    res.json({
        connected: isConnected,
        cdpPort: CONFIG.cdpPort,
        cdpHost: CONFIG.cdpHost,
    });
});

app.get('/api/qr', async (req, res) => {
    try {
        const ip = getLocalIP();
        const url = `http://${ip}:${CONFIG.port}`;
        const qr = await QRCode.toDataURL(url, { width: 256, margin: 2 });
        res.json({ url, qr });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/launch', async (req, res) => {
    try {
        const launched = await launchAntigravity();
        if (launched) {
            const connected = await connectCDP();
            res.json({ success: true, connected });
        } else {
            res.json({ success: false, error: 'Failed to launch Antigravity' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/targets', async (req, res) => {
    try {
        const targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
        res.json(targets.map(t => ({
            id: t.id,
            type: t.type,
            title: t.title,
            url: t.url,
        })));
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        cdpPort: CONFIG.cdpPort,
        connected: isConnected,
        ip: getLocalIP(),
        port: CONFIG.port,
    });
});

// ─── Chat History API ─────────────────────────────────────────
app.get('/api/history', (req, res) => {
    res.json(chatHistory.slice(-100));
});

app.post('/api/history/clear', (req, res) => {
    chatHistory = [];
    saveHistory();
    res.json({ success: true });
});

// ─── Utility ──────────────────────────────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// ─── Start Server ─────────────────────────────────────────
function startServer(port) {
    server.listen(port, '0.0.0.0', async () => {
        CONFIG.port = port; // update in case it changed

        // Auto-detect CDP port
        CONFIG.cdpPort = await detectCdpPort();

        const ip = getLocalIP();
        log('INFO', '═══════════════════════════════════════════');
        log('INFO', '  AntigravityHub Remote Access Server');
        log('INFO', '═══════════════════════════════════════════');
        log('INFO', `  Local:   http://localhost:${port}`);
        log('INFO', `  Mobile:  http://${ip}:${port}`);
        log('INFO', `  CDP:     ${CONFIG.cdpHost}:${CONFIG.cdpPort}`);
        log('INFO', '═══════════════════════════════════════════');

        // Try initial CDP connection
        const connected = await connectCDP();
        if (connected) {
            log('INFO', '✓ CDP connected - ready for mobile access');
        } else {
            log('WARN', '✗ CDP not available - start Antigravity with --remote-debugging-port=' + CONFIG.cdpPort);
        }

        // Periodic CDP reconnect attempt (re-scan all ports)
        setInterval(async () => {
            if (!isConnected) {
                // Re-detect in case ports changed
                const newPort = await detectCdpPort();
                if (newPort !== CONFIG.cdpPort) {
                    log('INFO', `CDP port changed: ${CONFIG.cdpPort} → ${newPort}`);
                    CONFIG.cdpPort = newPort;
                }
                const ok = await connectCDP();
                if (ok) log('INFO', '✓ CDP reconnected');
            }
        }, 10000);

        // Generate QR code in terminal
        try {
            const url = `http://${ip}:${port}`;
            const qrText = await QRCode.toString(url, { type: 'terminal', small: true });
            console.log('\n  Scan QR code with your phone:\n');
            console.log(qrText);
        } catch (_) { /* noop */ }
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log('WARN', `Port ${CONFIG.port} in use, trying ${CONFIG.port + 1}...`);
        startServer(CONFIG.port + 1);
    } else {
        log('ERROR', 'Server error:', err.message);
        process.exit(1);
    }
});

startServer(CONFIG.port);
