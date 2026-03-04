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

    // Try to read --remote-debugging-port from Antigravity process command line
    try {
        const { execSync } = require('child_process');
        const wmicOut = execSync('wmic process where "name like \'%Antigravity%\'" get CommandLine /value 2>nul', { encoding: 'utf8', timeout: 3000 });
        const match = wmicOut.match(/--remote-debugging-port=(\d+)/);
        if (match) {
            const port = parseInt(match[1]);
            if (port > 0 && port < 65536) {
                console.log(`[AUTO-DETECT] Read port ${port} from Antigravity process args`);
                candidates.add(port);
            }
        }
    } catch (_) { /* wmic not available or failed */ }

    // Read DevToolsActivePort files
    const userDataDirs = [
        path.join(process.env.APPDATA || '', 'Antigravity'),
        path.join(process.env.APPDATA || '', 'Windsurf'),
        path.join(process.env.LOCALAPPDATA || '', 'Antigravity'),
        path.join(process.env.LOCALAPPDATA || '', 'Windsurf'),
    ];
    for (const dir of userDataDirs) {
        const dtap = path.join(dir, 'DevToolsActivePort');
        try {
            const content = fs.readFileSync(dtap, 'utf8').trim();
            const port = parseInt(content.split('\n')[0].trim());
            if (port > 0 && port < 65536) {
                console.log(`[AUTO-DETECT] Read port ${port} from ${path.basename(dir)}/DevToolsActivePort`);
                candidates.add(port);
            }
        } catch (_) { /* file not found */ }
    }

    // Always try common Electron/Chrome CDP ports
    [9222, 9229, 9333, 9000].forEach(p => candidates.add(p));

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

async function launchAntigravity(killExisting = false) {
    const exePath = await findAntigravityPath();
    if (!exePath) {
        log('WARN', 'Antigravity executable not found');
        return false;
    }

    // Kill existing Antigravity processes if requested
    if (killExisting) {
        try {
            const { execSync } = require('child_process');
            execSync('taskkill /f /im Antigravity.exe 2>nul', { encoding: 'utf8', timeout: 5000 });
            log('INFO', 'Killed existing Antigravity processes');
            await new Promise(r => setTimeout(r, 2000)); // Wait for cleanup
        } catch (_) { /* no processes to kill */ }
    }

    log('INFO', `Launching Antigravity from: ${exePath} with --remote-debugging-port=${CONFIG.cdpPort}`);
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

            // Highest priority: jetski-agent (the agent panel - chat target)
            if (t.url && t.url.includes('jetski-agent')) {
                score = 120; // Always highest - this is the chat panel
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

                        // ───────────────────────────────────────────────────────
                        // Atomic expression: Find → Focus → Clear → Insert text
                        // Uses execCommand('insertText') which properly triggers
                        // React/framework state updates (textContent does NOT work)
                        // ───────────────────────────────────────────────────────
                        const buildChatExpr = (text) => `
                            (function() {
                                function findChatInput() {
                                    // Strategy 1: contenteditable with known Antigravity classes
                                    const ceEls = document.querySelectorAll('[contenteditable="true"]');
                                    for (const el of ceEls) {
                                        const rect = el.getBoundingClientRect();
                                        if (rect.width < 50 || rect.height < 10) continue;
                                        const cls = el.className || '';
                                        if (cls.includes('cursor-text') || cls.includes('overflow-y-auto') || cls.includes('outline-none')) {
                                            return { el, type: 'contenteditable', cls: cls.substring(0,80) };
                                        }
                                    }
                                    // Strategy 2: Any visible contenteditable
                                    for (const el of ceEls) {
                                        const rect = el.getBoundingClientRect();
                                        if (rect.width > 50 && rect.height > 10) {
                                            return { el, type: 'contenteditable-generic', cls: (el.className||'').substring(0,80) };
                                        }
                                    }
                                    // Strategy 3: textarea fallback
                                    const tas = document.querySelectorAll('textarea');
                                    for (const ta of tas) {
                                        const rect = ta.getBoundingClientRect();
                                        if (rect.width > 50 && rect.height > 10) {
                                            return { el: ta, type: 'textarea', cls: (ta.className||'').substring(0,80) };
                                        }
                                    }
                                    return null;
                                }

                                const found = findChatInput();
                                if (!found) return { ok: false, error: 'no chat input found' };

                                const { el, type, cls } = found;
                                const text = ${JSON.stringify(text)};

                                // Focus the element
                                el.focus();
                                el.click();

                                if (type === 'textarea') {
                                    // Textarea: set value + native input setter for React
                                    const nativeSetter = Object.getOwnPropertyDescriptor(
                                        window.HTMLTextAreaElement.prototype, 'value'
                                    ).set;
                                    nativeSetter.call(el, text);
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    return { ok: true, type, cls };
                                }

                                // Contenteditable: use Selection + execCommand
                                // Step 1: Select ALL existing content to replace it
                                const sel = window.getSelection();
                                const range = document.createRange();
                                range.selectNodeContents(el);
                                sel.removeAllRanges();
                                sel.addRange(range);

                                // Step 2: Delete existing content
                                document.execCommand('delete', false, null);

                                // Step 3: Insert new text via execCommand (framework-compatible!)
                                document.execCommand('insertText', false, text);

                                return { ok: true, type, cls, textLength: text.length };
                            })()
                        `;

                        // Build list of candidate targets (workbench first)
                        let targets = [];
                        try {
                            targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
                        } catch (_) { }

                        const candidateTargets = targets.filter(t =>
                            (t.type === 'page' || t.type === 'iframe') &&
                            !t.url?.includes(`localhost:${CONFIG.port}`)
                        );
                        candidateTargets.sort((a, b) => {
                            const score = (t) => {
                                if (t.url?.includes('workbench.html') || t.url?.includes('workbench.desktop')) return 10;
                                if (t.url?.includes('jetski-agent')) return 8;
                                if (t.url?.includes('vscode-file://')) return 6;
                                if (t.type === 'iframe' && t.url?.includes('vscode-webview')) return 3;
                                return 1;
                            };
                            return score(b) - score(a);
                        });

                        let chatSent = false;
                        let chatTargetClient = null; // Keep reference for Enter key

                        for (const target of candidateTargets) {
                            if (chatSent) break;
                            log('INFO', `Trying target: ${target.title} (${target.url?.substring(0, 80)})`);
                            ws.send(JSON.stringify({ type: 'chat-status', text: `Thử target: ${target.title || 'unknown'}...`, status: 'info' }));

                            let tempClient = null;
                            try {
                                tempClient = await CDP({ host: CONFIG.cdpHost, port: CONFIG.cdpPort, target });
                                await tempClient.Runtime.enable();

                                // Atomic: find + focus + clear + insert text
                                const result = await tempClient.Runtime.evaluate({
                                    expression: buildChatExpr(chatText),
                                    returnByValue: true,
                                    awaitPromise: false,
                                });

                                const val = result.result && result.result.value;
                                if (val && val.ok) {
                                    log('INFO', `✓ Text inserted via ${val.type} on "${target.title}" (class: ${val.cls})`);
                                    ws.send(JSON.stringify({ type: 'chat-status', text: `✅ Text inserted: ${target.title} (${val.type})`, status: 'success' }));

                                    // Wait for framework to process the input
                                    await new Promise(r => setTimeout(r, 300));

                                    // Verify text was actually inserted
                                    const verifyResult = await tempClient.Runtime.evaluate({
                                        expression: `
                                            (function() {
                                                const el = document.querySelector('[contenteditable="true"]');
                                                if (el) return { text: (el.textContent || '').substring(0, 100), len: (el.textContent || '').length };
                                                const ta = document.querySelector('textarea');
                                                if (ta) return { text: (ta.value || '').substring(0, 100), len: (ta.value || '').length };
                                                return { text: '', len: 0 };
                                            })()
                                        `,
                                        returnByValue: true,
                                    });
                                    const verifyVal = verifyResult.result && verifyResult.result.value;
                                    log('INFO', `Verify input content: "${verifyVal?.text}" (len=${verifyVal?.len})`);

                                    if (verifyVal && verifyVal.len > 0) {
                                        // Text is confirmed in the input - now press Enter
                                        await tempClient.Input.dispatchKeyEvent({
                                            type: 'rawKeyDown',
                                            key: 'Enter',
                                            code: 'Enter',
                                            windowsVirtualKeyCode: 13,
                                            nativeVirtualKeyCode: 13,
                                        });
                                        await new Promise(r => setTimeout(r, 50));
                                        await tempClient.Input.dispatchKeyEvent({
                                            type: 'char',
                                            key: 'Enter',
                                            code: 'Enter',
                                            text: '\r',
                                            windowsVirtualKeyCode: 13,
                                            nativeVirtualKeyCode: 13,
                                        });
                                        await new Promise(r => setTimeout(r, 50));
                                        await tempClient.Input.dispatchKeyEvent({
                                            type: 'keyUp',
                                            key: 'Enter',
                                            code: 'Enter',
                                            windowsVirtualKeyCode: 13,
                                            nativeVirtualKeyCode: 13,
                                        });

                                        chatSent = true;
                                        chatTargetClient = tempClient;
                                        tempClient = null; // Don't close immediately
                                        log('INFO', 'Chat message sent successfully!');
                                        ws.send(JSON.stringify({ type: 'chat-status', text: '✅ Tin nhắn đã gửi! Đang chờ phản hồi...', status: 'success' }));
                                    } else {
                                        log('WARN', `Text insertion verified but content is empty — framework may have rejected it`);
                                        // Fallback: try typing char by char via Input.dispatchKeyEvent
                                        ws.send(JSON.stringify({ type: 'chat-status', text: '⚠️ execCommand failed, thử gõ từng ký tự...', status: 'info' }));

                                        // Focus the input element first
                                        await tempClient.Runtime.evaluate({
                                            expression: `(function(){
                                                const el = document.querySelector('[contenteditable="true"]');
                                                if (el) { el.focus(); el.click(); }
                                            })()`,
                                        });
                                        await new Promise(r => setTimeout(r, 100));

                                        // Type each character
                                        for (const char of chatText) {
                                            await tempClient.Input.dispatchKeyEvent({
                                                type: 'keyDown',
                                                key: char,
                                                text: char,
                                                unmodifiedText: char,
                                            });
                                            await tempClient.Input.dispatchKeyEvent({
                                                type: 'char',
                                                key: char,
                                                text: char,
                                                unmodifiedText: char,
                                            });
                                            await tempClient.Input.dispatchKeyEvent({
                                                type: 'keyUp',
                                                key: char,
                                            });
                                            await new Promise(r => setTimeout(r, 20));
                                        }

                                        await new Promise(r => setTimeout(r, 300));

                                        // Press Enter
                                        await tempClient.Input.dispatchKeyEvent({
                                            type: 'rawKeyDown', key: 'Enter', code: 'Enter',
                                            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                                        });
                                        await tempClient.Input.dispatchKeyEvent({
                                            type: 'char', key: 'Enter', code: 'Enter', text: '\r',
                                            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                                        });
                                        await tempClient.Input.dispatchKeyEvent({
                                            type: 'keyUp', key: 'Enter', code: 'Enter',
                                            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                                        });

                                        chatSent = true;
                                        chatTargetClient = tempClient;
                                        tempClient = null;
                                        log('INFO', 'Chat sent via char-by-char fallback');
                                    }
                                } else {
                                    log('WARN', `No chat input found on "${target.title}": ${val?.error || 'not found'}`);
                                }
                            } catch (err) {
                                log('WARN', `Failed target "${target.title}": ${err.message}`);
                            } finally {
                                // Only close if not kept for Enter key
                                if (tempClient) {
                                    try { await tempClient.close(); } catch (_) { }
                                }
                            }
                        }

                        if (chatSent) {
                            // ─── Live sync: stream screenshots of Antigravity agent panel ───
                            // Instead of fragile DOM reading, show the user what's happening
                            // via live screenshots from the workbench
                            ws.send(JSON.stringify({ type: 'chat-response', text: '✅ Tin nhắn đã gửi thành công! Đang stream trạng thái agent...' }));

                            // Stream screenshots for ~20s so user can SEE the agent working  
                            const streamClient = chatTargetClient || cdpClient;
                            try { await streamClient.Page.enable(); } catch (_) { }
                            let lastScreenData = null;
                            for (let i = 0; i < 10; i++) {
                                await new Promise(r => setTimeout(r, 2000));
                                try {
                                    if (ws.readyState !== 1) break;
                                    // Capture screenshot from workbench target
                                    const ssResult = await streamClient.Page.captureScreenshot({
                                        format: 'jpeg',
                                        quality: 50,
                                        fromSurface: true,
                                    });
                                    if (ssResult && ssResult.data && ssResult.data !== lastScreenData) {
                                        lastScreenData = ssResult.data;
                                        ws.send(JSON.stringify({ type: 'agent-sync', data: ssResult.data, frame: i + 1 }));
                                    }
                                } catch (ssErr) {
                                    log('WARN', `Sync screenshot ${i + 1} failed: ${ssErr.message}`);
                                    break;
                                }
                            }

                            // Clean up chatTargetClient
                            if (chatTargetClient) {
                                setTimeout(async () => { try { await chatTargetClient.close(); } catch (_) { } }, 2000);
                            }
                        } else {
                            log('WARN', `Chat input not found in any of ${candidateTargets.length} targets`);
                            ws.send(JSON.stringify({
                                type: 'chat-response',
                                text: `Không tìm thấy chat input trong ${candidateTargets.length} CDP targets.\n\n🔧 Hãy đảm bảo:\n1. Agent panel đang mở trong Antigravity\n2. Antigravity đã khởi chạy với --remote-debugging-port\n3. Thử nhấn Reconnect CDP`
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
        const killExisting = req.body?.restart === true;
        const launched = await launchAntigravity(killExisting);
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
