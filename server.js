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
    if (process.env.CDP_PORT) return [parseInt(process.env.CDP_PORT)];
    const candidates = new Set();
    try {
        const { execSync } = require('child_process');
        const wmicOut = execSync('wmic process where "name like \'%Antigravity%\'" get CommandLine /value 2>nul', { encoding: 'utf8', timeout: 3000 });
        const match = wmicOut.match(/--remote-debugging-port=(\d+)/);
        if (match) {
            const port = parseInt(match[1]);
            if (port > 0 && port < 65536) {
                log('INFO', `[AUTO-DETECT] Read port ${port} from Antigravity process args`);
                candidates.add(port);
            }
        }
    } catch (_) { }
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
                log('INFO', `[AUTO-DETECT] Read port ${port} from ${path.basename(dir)}/DevToolsActivePort`);
                candidates.add(port);
            }
        } catch (_) { }
    }
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
                } catch (_) { resolve({ port, ok: false }); }
            });
        });
        req.on('error', () => resolve({ port, ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ port, ok: false }); });
    });
}

async function detectCdpPort() {
    const candidates = getCdpPortCandidates();
    log('INFO', `Scanning CDP ports: ${candidates.join(', ')}`);
    for (const port of candidates) {
        const result = await probeCdpPort(port);
        if (result.ok) {
            log('INFO', `✓ CDP found on port ${port} (${result.browser})`);
            return port;
        }
    }
    return candidates[0] || 9333;
}

const CONFIG = {
    port: parseInt(process.env.PORT || '3000'),
    cdpPort: null,
    cdpHost: process.env.CDP_HOST || 'localhost',
    screenshotQuality: parseInt(process.env.QUALITY || '55'),
    logFile: path.join(__dirname, 'debug.log'),
};

// ─── Logging ──────────────────────────────────────────────────
function log(level, msg, ...args) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg} ${args.length ? JSON.stringify(args) : ''}`;
    console.log(line);
    try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) { }
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
let cdpDOM = null;
let isConnected = false;
let lastScreenshot = null;
let screenshotInProgress = false;

// ─── Chat Sync State ─────────────────────────────────────────
let lastKnownMessages = [];
let chatPollInterval = null;
let observerInjected = false;

// ─── Find the best CDP target ─────────────────────────────────
async function findWorkbenchTarget() {
    try {
        const targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
        log('INFO', `Found ${targets.length} CDP targets`);
        let best = null;
        let bestScore = -1;
        const serverUrl = `localhost:${CONFIG.port}`;
        for (const t of targets) {
            log('INFO', `  Target: ${t.type} - ${t.title} - ${t.url}`);
            if (t.type !== 'page') continue;
            if (t.url && t.url.includes(serverUrl)) continue;
            let score = 0;
            if (t.url && t.url.includes('jetski-agent')) score = 120;
            else if (t.url && (t.url.includes('workbench.html') || t.url.includes('workbench.desktop'))) score = 100;
            else if (t.url && t.url.includes('vscode-file://')) score = 80;
            else if (t.title && /antigravity|cascade|agent/i.test(t.title)) score = 70;
            else if (t.url && t.url.startsWith('chrome://')) {
                if (t.url.includes('footer')) continue;
                score = 5;
            } else score = 10;
            if (score > bestScore) { bestScore = score; best = t; }
        }
        if (best) log('INFO', `→ Selected target (score=${bestScore}): ${best.title || best.url}`);
        return best;
    } catch (err) {
        log('ERROR', 'Failed to list CDP targets:', err.message);
        return null;
    }
}

let connectingPromise = null;

async function connectCDP() {
    if (isConnected) return true;
    // Prevent concurrent connection attempts
    if (connectingPromise) return connectingPromise;

    connectingPromise = (async () => {
        if (cdpClient) {
            try { await cdpClient.close(); } catch (_) { }
            cdpClient = null;
        }
        try {
            const target = await findWorkbenchTarget();
            if (!target) { log('WARN', 'No suitable CDP target found'); return false; }
            log('INFO', `Connecting to CDP target: ${target.title || target.url}`);
            cdpClient = await CDP({ host: CONFIG.cdpHost, port: CONFIG.cdpPort, target });
            cdpPage = cdpClient.Page;
            cdpInput = cdpClient.Input;
            cdpRuntime = cdpClient.Runtime;
            cdpDOM = cdpClient.DOM;
            await cdpPage.enable();
            await cdpRuntime.enable();
            isConnected = true;
            log('INFO', 'CDP connected successfully');

            // Listen for DOM changes from injected observer
            cdpRuntime.on('consoleAPICalled', (params) => {
                if (params.type === 'log' && params.args && params.args[0]) {
                    const val = params.args[0].value;
                    if (typeof val === 'string' && val.startsWith('__AGHUB_CHAT_UPDATE__')) {
                        pollChatMessages();
                    }
                }
            });

            cdpClient.on('disconnect', () => {
                log('WARN', 'CDP disconnected');
                isConnected = false;
                cdpClient = null;
                observerInjected = false;
                stopChatPolling();
                setTimeout(() => connectCDP(), 3000);
            });

            startChatPolling();
            await injectChatObserver();
            return true;
        } catch (err) {
            log('ERROR', 'CDP connect failed:', err.message);
            isConnected = false;
            return false;
        }
    })();

    try {
        return await connectingPromise;
    } finally {
        connectingPromise = null;
    }
}

// ─── Chat DOM Interaction ─────────────────────────────────────

// Read all chat messages from the Agent panel DOM
async function readChatMessages() {
    if (!isConnected) return null;
    try {
        const { result } = await cdpRuntime.evaluate({
            expression: `
            (function() {
                // Try multiple selectors for the chat messages container
                const selectors = [
                    // Antigravity/Windsurf agent panel selectors
                    '.chat-messages-container',
                    '.conversation-messages',
                    '.message-list',
                    '[class*="chat"] [class*="message"]',
                    '[class*="conversation"]',
                    '.aichat-messages',
                    '.ai-chat-messages',
                    // Generic chat area selectors
                    '[role="log"]',
                    '[aria-label*="chat"]',
                    '[aria-label*="conversation"]',
                ];
                
                let container = null;
                for (const sel of selectors) {
                    container = document.querySelector(sel);
                    if (container) break;
                }
                
                if (!container) {
                    // Broader search: find largest scrollable container with text
                    const allElements = document.querySelectorAll('div[class]');
                    let bestEl = null;
                    let bestHeight = 0;
                    for (const el of allElements) {
                        if (el.scrollHeight > 300 && el.children.length > 1) {
                            const cls = el.className.toLowerCase();
                            if (cls.includes('message') || cls.includes('chat') || cls.includes('conversation') || cls.includes('scroll')) {
                                if (el.scrollHeight > bestHeight) {
                                    bestHeight = el.scrollHeight;
                                    bestEl = el;
                                }
                            }
                        }
                    }
                    container = bestEl;
                }
                
                if (!container) return JSON.stringify({ found: false, messages: [], debug: 'No chat container found' });
                
                // Extract messages from child elements
                const messages = [];
                const children = container.children;
                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    const text = child.innerText?.trim();
                    if (!text || text.length < 1) continue;
                    
                    const cls = (child.className || '').toLowerCase();
                    const dataset = child.dataset || {};
                    
                    // Determine role
                    let role = 'unknown';
                    if (cls.includes('user') || cls.includes('human') || dataset.role === 'user')
                        role = 'user';
                    else if (cls.includes('assistant') || cls.includes('ai') || cls.includes('bot') || cls.includes('agent') || dataset.role === 'assistant')
                        role = 'assistant';
                    else if (cls.includes('system') || cls.includes('info'))
                        role = 'system';
                    
                    // Check for thinking/loading state
                    const isThinking = cls.includes('thinking') || cls.includes('loading') || 
                                       cls.includes('streaming') || child.querySelector('.thinking, .loading, [class*="spinner"]') != null;
                    
                    messages.push({
                        role,
                        text: text.substring(0, 5000), // Limit text length
                        isThinking,
                        index: i,
                    });
                }
                
                return JSON.stringify({ found: true, messages, containerClass: container.className });
            })()`,
            returnByValue: true,
        });
        return JSON.parse(result.value);
    } catch (err) {
        log('ERROR', 'readChatMessages failed:', err.message);
        return null;
    }
}

// Helper: get all execution context IDs from all frames
async function getAllContextIds() {
    if (!isConnected) return [];
    const contextIds = [];
    try {
        // Get the frame tree to find all frames
        const { frameTree } = await cdpPage.getFrameTree();
        const frames = [];
        function collectFrames(node) {
            frames.push(node.frame);
            if (node.childFrames) node.childFrames.forEach(collectFrames);
        }
        collectFrames(frameTree);

        // Get execution contexts
        // We need to create isolated worlds or find existing contexts for each frame
        for (const frame of frames) {
            try {
                const { executionContextId } = await cdpPage.createIsolatedWorld({
                    frameId: frame.id,
                    worldName: 'aghub_finder',
                    grantUniveralAccess: true,
                });
                contextIds.push({ contextId: executionContextId, frameId: frame.id, url: frame.url });
            } catch (_) { }
        }
    } catch (err) {
        log('WARN', 'getAllContextIds failed:', err.message);
    }
    return contextIds;
}

// Find chat input across all frames
const FIND_INPUT_SCRIPT = `
(function() {
    const inputSelectors = [
        '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[role="textbox"]',
        '[data-placeholder]',
        'textarea[class*="chat"]',
        'textarea[class*="input"]',
    ];
    let input = null;
    for (const sel of inputSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 10) {
                if (!input || rect.top > input.getBoundingClientRect().top) {
                    input = el;
                }
            }
        }
    }
    if (!input) return JSON.stringify({ found: false });
    input.focus();
    input.click();
    return JSON.stringify({
        found: true,
        tag: input.tagName,
        isContentEditable: input.isContentEditable,
        rect: input.getBoundingClientRect().toJSON(),
    });
})()`;

// Helper: get viewport size of the connected page
async function getViewportSize() {
    try {
        const { result } = await cdpRuntime.evaluate({
            expression: `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`,
            returnByValue: true,
        });
        return JSON.parse(result.value);
    } catch (_) {
        return { width: 1280, height: 800 }; // reasonable default
    }
}

// Search for the chat input element and send a message
async function sendChatMessage(text) {
    if (!isConnected || !text) return { success: false, error: 'Not connected or empty message' };
    try {
        // Strategy 1: Try finding input in each frame context
        let inputInfo = null;
        let foundContextId = null;

        // First try top-level
        try {
            const { result } = await cdpRuntime.evaluate({
                expression: FIND_INPUT_SCRIPT,
                returnByValue: true,
            });
            const info = JSON.parse(result.value);
            if (info.found) {
                inputInfo = info;
                log('INFO', 'Chat input found in top-level frame');
            }
        } catch (_) { }

        // If not found, search child frames
        if (!inputInfo) {
            const contexts = await getAllContextIds();
            log('INFO', `Searching ${contexts.length} frame contexts for chat input`);
            for (const ctx of contexts) {
                try {
                    const { result } = await cdpRuntime.evaluate({
                        expression: FIND_INPUT_SCRIPT,
                        contextId: ctx.contextId,
                        returnByValue: true,
                    });
                    const info = JSON.parse(result.value);
                    if (info.found) {
                        inputInfo = info;
                        foundContextId = ctx.contextId;
                        log('INFO', `Chat input found in frame: ${ctx.url?.substring(0, 80)}`);
                        break;
                    }
                } catch (_) { }
            }
        }

        if (!inputInfo) {
            log('WARN', 'Chat input not found in any frame, using mouse click fallback');
            // Strategy 2: Fallback - click at a known position (bottom of viewport)
            // and type directly
            const viewport = await getViewportSize();
            // Click near bottom center where chat input usually is
            const clickX = Math.round(viewport.width / 2);
            const clickY = viewport.height - 60;
            await cdpInput.dispatchMouseEvent({ type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await cdpInput.dispatchMouseEvent({ type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 200));
            // Select all existing text and replace
            await cdpInput.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }); // Ctrl+A
            await cdpInput.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
            await cdpInput.insertText({ text });
            await new Promise(r => setTimeout(r, 100));
            await cdpInput.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await cdpInput.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            log('INFO', `Message sent via mouse fallback: "${text.substring(0, 50)}"`);
            return { success: true, method: 'mouse-fallback' };
        }

        log('INFO', 'Chat input info:', JSON.stringify(inputInfo));

        // Step 2: Type the message
        if (inputInfo.isContentEditable) {
            // Focus + select all in the correct context
            const evalOpts = foundContextId ? { contextId: foundContextId } : {};
            await cdpRuntime.evaluate({
                expression: `
                (function() {
                    const inputs = document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
                    let input = null;
                    for (const el of inputs) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 50 && rect.height > 10) {
                            if (!input || rect.top > input.getBoundingClientRect().top) input = el;
                        }
                    }
                    if (input) {
                        input.focus();
                        const range = document.createRange();
                        range.selectNodeContents(input);
                        window.getSelection().removeAllRanges();
                        window.getSelection().addRange(range);
                    }
                })()`,
                ...evalOpts,
            });
            // Also click the element by coordinates to ensure focus
            if (inputInfo.rect) {
                const cx = Math.round(inputInfo.rect.x + inputInfo.rect.width / 2);
                const cy = Math.round(inputInfo.rect.y + inputInfo.rect.height / 2);
                await cdpInput.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                await cdpInput.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 100));
                // Select all and delete
                await cdpInput.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
                await cdpInput.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
                await cdpInput.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
                await cdpInput.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            }
            await cdpInput.insertText({ text });
        } else {
            // For textarea/input - click + type
            if (inputInfo.rect) {
                const cx = Math.round(inputInfo.rect.x + inputInfo.rect.width / 2);
                const cy = Math.round(inputInfo.rect.y + inputInfo.rect.height / 2);
                await cdpInput.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 3 }); // Triple click = select all
                await cdpInput.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 3 });
                await new Promise(r => setTimeout(r, 100));
            }
            await cdpInput.insertText({ text });
        }

        // Step 3: Simulate Enter key to send
        await new Promise(r => setTimeout(r, 100));
        await cdpInput.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await cdpInput.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

        log('INFO', `Message sent: "${text.substring(0, 50)}"`);
        return { success: true, method: foundContextId ? 'frame-context' : 'top-level' };
    } catch (err) {
        log('ERROR', 'sendChatMessage failed:', err.message);
        return { success: false, error: err.message };
    }
}

// Inject MutationObserver to detect chat changes
async function injectChatObserver() {
    if (!isConnected || observerInjected) return;
    try {
        await cdpRuntime.evaluate({
            expression: `
            (function() {
                if (window.__agHubObserver) return;
                // Observe the entire body for subtree changes
                window.__agHubObserver = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        if (m.addedNodes.length > 0 || m.type === 'characterData') {
                            console.log('__AGHUB_CHAT_UPDATE__');
                            break;
                        }
                    }
                });
                window.__agHubObserver.observe(document.body, {
                    childList: true, subtree: true, characterData: true
                });
            })()`,
        });
        observerInjected = true;
        log('INFO', 'Chat MutationObserver injected');
    } catch (err) {
        log('WARN', 'Failed to inject observer:', err.message);
    }
}

// Poll chat messages and broadcast changes
async function pollChatMessages() {
    const data = await readChatMessages();
    if (!data) return;

    // Compare with last known state
    const currentJSON = JSON.stringify(data.messages);
    const lastJSON = JSON.stringify(lastKnownMessages);
    if (currentJSON !== lastJSON) {
        lastKnownMessages = data.messages;
        broadcastToClients({
            type: 'chat-update',
            messages: data.messages,
            containerFound: data.found,
        });
    }
}

function startChatPolling() {
    if (chatPollInterval) return;
    chatPollInterval = setInterval(() => {
        if (isConnected) pollChatMessages();
    }, 1500); // Poll every 1.5s
    // Also do an immediate poll
    pollChatMessages();
}

function stopChatPolling() {
    if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
    }
}

// ─── Screenshot (for stream view) ─────────────────────────────
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
        if (err.message.includes('not attached') || err.message.includes('closed')) isConnected = false;
        return lastScreenshot;
    } finally {
        screenshotInProgress = false;
    }
}

// ─── Input forwarding ─────────────────────────────────────────
async function sendMouseEvent(type, x, y, button = 'left', clickCount = 1) {
    if (!isConnected) return false;
    try {
        await cdpInput.dispatchMouseEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount });
        return true;
    } catch (err) { log('ERROR', 'Mouse event failed:', err.message); return false; }
}

async function sendKeyEvent(type, key, code, modifiers = 0) {
    if (!isConnected) return false;
    try {
        const params = { type, modifiers };
        if (type === 'char') { params.text = key; }
        else { params.key = key; params.code = code || ''; if (key.length === 1) params.text = type === 'keyDown' ? key : ''; }
        await cdpInput.dispatchKeyEvent(params);
        return true;
    } catch (err) { log('ERROR', 'Key event failed:', err.message); return false; }
}

async function sendScrollEvent(x, y, deltaX, deltaY) {
    if (!isConnected) return false;
    try {
        await cdpInput.dispatchMouseEvent({ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) });
        return true;
    } catch (err) { log('ERROR', 'Scroll event failed:', err.message); return false; }
}

async function getViewportSize() {
    if (!isConnected) return { width: 1280, height: 800 };
    try {
        const { result } = await cdpRuntime.evaluate({ expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })', returnByValue: true });
        return JSON.parse(result.value);
    } catch (err) { return { width: 1280, height: 800 }; }
}

// ─── WebSocket Server ─────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

// Handle upgrade manually so WSS doesn't conflict with server errors
server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

function broadcastToClients(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(data);
    }
}

wss.on('connection', async (ws) => {
    log('INFO', 'Client connected');
    wsClients.add(ws);

    let streamInterval = null;
    let isStreaming = false;

    const connected = await connectCDP();
    const viewport = await getViewportSize();

    ws.send(JSON.stringify({ type: 'status', connected, viewport }));

    // Send current chat state immediately
    if (connected && lastKnownMessages.length > 0) {
        ws.send(JSON.stringify({ type: 'chat-update', messages: lastKnownMessages, containerFound: true }));
    } else if (connected) {
        await pollChatMessages();
    }

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            switch (msg.type) {
                case 'connect':
                    const ok = await connectCDP();
                    const vp = await getViewportSize();
                    ws.send(JSON.stringify({ type: 'status', connected: ok, viewport: vp }));
                    break;

                case 'send-chat': {
                    // Send a chat message to the Antigravity agent
                    const result = await sendChatMessage(msg.text);
                    ws.send(JSON.stringify({ type: 'chat-sent', ...result }));
                    // Poll for response after a short delay
                    setTimeout(() => pollChatMessages(), 500);
                    setTimeout(() => pollChatMessages(), 2000);
                    setTimeout(() => pollChatMessages(), 5000);
                    break;
                }

                case 'get-chat': {
                    // Force read current chat state
                    await pollChatMessages();
                    ws.send(JSON.stringify({ type: 'chat-update', messages: lastKnownMessages, containerFound: true }));
                    break;
                }

                case 'click':
                    await sendMouseEvent('mousePressed', msg.x, msg.y, 'left', 1);
                    await sendMouseEvent('mouseReleased', msg.x, msg.y, 'left', 1);
                    setTimeout(async () => {
                        const ss = await captureScreenshot();
                        if (ss && ws.readyState === 1) ws.send(JSON.stringify({ type: 'frame', data: ss }));
                    }, 150);
                    break;

                case 'mousemove':
                    await sendMouseEvent('mouseMoved', msg.x, msg.y);
                    break;

                case 'scroll':
                    await sendScrollEvent(msg.x, msg.y, msg.deltaX || 0, msg.deltaY || 0);
                    setTimeout(async () => {
                        const ss = await captureScreenshot();
                        if (ss && ws.readyState === 1) ws.send(JSON.stringify({ type: 'frame', data: ss }));
                    }, 100);
                    break;

                case 'key':
                    if (msg.text) {
                        for (const char of msg.text) await sendKeyEvent('char', char);
                    } else {
                        await sendKeyEvent('keyDown', msg.key, msg.code, msg.modifiers || 0);
                        await sendKeyEvent('keyUp', msg.key, msg.code, msg.modifiers || 0);
                    }
                    break;

                case 'stream-start':
                    if (!isStreaming) {
                        isStreaming = true;
                        streamInterval = setInterval(async () => {
                            if (ws.readyState !== 1) { clearInterval(streamInterval); isStreaming = false; return; }
                            const ss = await captureScreenshot();
                            if (ss) ws.send(JSON.stringify({ type: 'frame', data: ss }));
                        }, 100);
                    }
                    break;

                case 'stream-stop':
                    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; isStreaming = false; }
                    break;

                case 'refresh':
                    const freshSS = await captureScreenshot();
                    if (freshSS) ws.send(JSON.stringify({ type: 'frame', data: freshSS }));
                    break;

                case 'list-targets':
                    try {
                        const tgts = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
                        ws.send(JSON.stringify({
                            type: 'targets-list',
                            targets: tgts.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url }))
                        }));
                    } catch (err) { log('WARN', 'List targets error:', err.message); }
                    break;

                case 'screenshot-once': {
                    const ss = await captureScreenshot();
                    if (ss) ws.send(JSON.stringify({ type: 'frame', data: ss }));
                    break;
                }
            }
        } catch (err) {
            log('ERROR', 'WS message error:', err.message);
        }
    });

    ws.on('close', () => {
        log('INFO', 'Client disconnected');
        wsClients.delete(ws);
        if (streamInterval) clearInterval(streamInterval);
    });
});

// ─── REST API ─────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
    res.json({ connected: isConnected, cdpPort: CONFIG.cdpPort, cdpHost: CONFIG.cdpHost });
});

app.get('/api/qr', async (req, res) => {
    try {
        const ip = getLocalIP();
        const url = `http://${ip}:${CONFIG.port}`;
        const qr = await QRCode.toDataURL(url, { width: 256, margin: 2 });
        res.json({ url, qr });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/targets', async (req, res) => {
    try {
        const targets = await CDP.List({ host: CONFIG.cdpHost, port: CONFIG.cdpPort });
        res.json(targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })));
    } catch (err) { res.json([]); }
});

// ─── Utility ──────────────────────────────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

// ─── Start Server ─────────────────────────────────────────────
function startServer(port) {
    server.listen(port, '0.0.0.0', async () => {
        CONFIG.port = port;
        CONFIG.cdpPort = await detectCdpPort();
        const ip = getLocalIP();
        log('INFO', '═══════════════════════════════════════════');
        log('INFO', '  AntigravityHub - Agent Chat Mirror');
        log('INFO', '═══════════════════════════════════════════');
        log('INFO', `  Local:   http://localhost:${port}`);
        log('INFO', `  Mobile:  http://${ip}:${port}`);
        log('INFO', `  CDP:     ${CONFIG.cdpHost}:${CONFIG.cdpPort}`);
        log('INFO', '═══════════════════════════════════════════');
        const connected = await connectCDP();
        if (connected) log('INFO', '✓ CDP connected - ready');
        else log('WARN', '✗ CDP not available - start Antigravity with --remote-debugging-port=' + CONFIG.cdpPort);

        // Periodic reconnect
        setInterval(async () => {
            if (!isConnected) {
                const newPort = await detectCdpPort();
                if (newPort !== CONFIG.cdpPort) { log('INFO', `CDP port changed: ${CONFIG.cdpPort} → ${newPort}`); CONFIG.cdpPort = newPort; }
                const ok = await connectCDP();
                if (ok) log('INFO', '✓ CDP reconnected');
            }
        }, 10000);

        try {
            const url = `http://${ip}:${port}`;
            const qrText = await QRCode.toString(url, { type: 'terminal', small: true });
            console.log('\n  Scan QR code with your phone:\n');
            console.log(qrText);
        } catch (_) { }
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log('WARN', `Port ${CONFIG.port} in use, trying ${CONFIG.port + 1}...`);
        startServer(CONFIG.port + 1);
    } else { log('ERROR', 'Server error:', err.message); process.exit(1); }
});

startServer(CONFIG.port);
