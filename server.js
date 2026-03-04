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

async function findWorkbenchTarget() {
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

            // High priority: workbench pages (VS Code / Antigravity main UI)
            if (t.url && (t.url.includes('workbench.html') || t.url.includes('workbench.desktop'))) {
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
            // chrome:// pages - low priority but still usable as fallback
            else if (t.url && t.url.startsWith('chrome://')) {
                // Skip footers but allow main newtab
                if (t.url.includes('footer')) continue;
                score = 5;
            }
            // Any other page (external website etc.)
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

                        // Use CDP to type into Antigravity's agent chat input
                        // First, find and focus the chat input
                        const focusResult = await cdpClient.Runtime.evaluate({
                            expression: `
                                (function() {
                                    // Try to find the agent chat input in Antigravity
                                    const selectors = [
                                        'textarea[class*="input"]',
                                        'textarea[placeholder*="message"]',
                                        'textarea[placeholder*="Ask"]',
                                        '.chat-input textarea',
                                        '.agent-input textarea',
                                        'div[class*="chat"] textarea',
                                        'div[class*="agent"] textarea',
                                        'textarea',
                                    ];
                                    for (const sel of selectors) {
                                        const el = document.querySelector(sel);
                                        if (el && el.offsetParent !== null) {
                                            el.focus();
                                            el.value = '';
                                            return { found: true, selector: sel };
                                        }
                                    }
                                    return { found: false };
                                })()
                            `,
                            returnByValue: true,
                        });

                        if (focusResult.result && focusResult.result.value && focusResult.result.value.found) {
                            // Type the message character by character
                            for (const char of chatText) {
                                await sendKeyEvent('char', char);
                            }
                            // Press Enter to submit
                            await new Promise(r => setTimeout(r, 100));
                            await sendKeyEvent('keyDown', 'Enter', 'Enter', 0);
                            await sendKeyEvent('keyUp', 'Enter', 'Enter', 0);

                            // Wait for response and send it back
                            ws.send(JSON.stringify({
                                type: 'chat-response',
                                text: `Đã gửi tin nhắn đến Antigravity Agent: "${chatText.substring(0, 100)}"`
                            }));
                        } else {
                            // Fallback: just execute the text as a notification
                            ws.send(JSON.stringify({
                                type: 'chat-response',
                                text: `Không tìm thấy chat input trong Antigravity. Tin nhắn: "${chatText}"\n\nHãy đảm bảo agent panel đang mở trong Antigravity.`
                            }));
                        }
                    } catch (chatErr) {
                        log('ERROR', 'Chat error:', chatErr.message);
                        ws.send(JSON.stringify({ type: 'chat-error', error: chatErr.message }));
                    }
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
