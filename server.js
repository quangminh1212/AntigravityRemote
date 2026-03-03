const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const CDP = require('chrome-remote-interface');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ─── Configuration ────────────────────────────────────────────
const CONFIG = {
    port: parseInt(process.env.PORT || '3000'),
    cdpPort: parseInt(process.env.CDP_PORT || '9222'),
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

async function findWorkbenchTarget() {
    try {
        const targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
        log('INFO', `Found ${targets.length} CDP targets`);

        // Priority: find target with 'workbench' or main page
        let best = null;
        for (const t of targets) {
            log('INFO', `  Target: ${t.type} - ${t.title} - ${t.url}`);
            if (t.type === 'page') {
                if (t.url && t.url.includes('workbench')) {
                    return t;
                }
                if (!best) best = t;
            }
        }
        return best || targets[0];
    } catch (err) {
        log('ERROR', 'Failed to list CDP targets:', err.message);
        return null;
    }
}

async function connectCDP() {
    if (isConnected) return true;

    try {
        const target = await findWorkbenchTarget();
        if (!target) {
            log('WARN', 'No CDP target found');
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

// ─── Start Server ─────────────────────────────────────────────
server.listen(CONFIG.port, '0.0.0.0', async () => {
    const ip = getLocalIP();
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', '  AntigravityHub Remote Access Server');
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', `  Local:   http://localhost:${CONFIG.port}`);
    log('INFO', `  Mobile:  http://${ip}:${CONFIG.port}`);
    log('INFO', `  CDP:     ${CONFIG.cdpHost}:${CONFIG.cdpPort}`);
    log('INFO', '═══════════════════════════════════════════');

    // Try initial CDP connection
    const connected = await connectCDP();
    if (connected) {
        log('INFO', '✓ CDP connected - ready for mobile access');
    } else {
        log('WARN', '✗ CDP not available - start Antigravity with --remote-debugging-port=' + CONFIG.cdpPort);
    }

    // Generate QR code in terminal
    try {
        const url = `http://${ip}:${CONFIG.port}`;
        const qrText = await QRCode.toString(url, { type: 'terminal', small: true });
        console.log('\n  Scan QR code with your phone:\n');
        console.log(qrText);
    } catch (_) { /* noop */ }
});
