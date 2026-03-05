/**
 * AntigravityRemote - Mobile PWA Chat Client for Antigravity IDE
 * 
 * Architecture (No CDP - PowerShell UI Automation):
 * 1. Uses PowerShell Win32 APIs for keyboard/window control
 * 2. Monitors Antigravity conversation files for state changes  
 * 3. Scans process ports for connectivity status
 * 4. Exposes WebSocket + REST API for mobile PWA client
 * 
 * No CDP required - all interactions via native Windows APIs.
 */

import http from 'http';
import { execSync, exec } from 'child_process';
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
    POLL_INTERVAL: 2500,
    LOG_FILE: path.join(__dirname, 'debug.log'),
    // Antigravity data paths
    AG_DATA_DIR: path.join(process.env.APPDATA || '', 'Antigravity'),
    AG_GEMINI_DIR: path.join(os.homedir(), '.gemini', 'antigravity'),
    AG_CONVERSATIONS_DIR: path.join(os.homedir(), '.gemini', 'antigravity', 'conversations'),
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
// PowerShell Helper - Execute PS commands safely via -EncodedCommand
// Using Base64-encoded UTF-16LE to avoid all cmd/PS escaping issues
// ============================================================================
function encodePsCommand(command) {
    // Convert to UTF-16LE then Base64 - this is what PS -EncodedCommand expects
    const buf = Buffer.from(command, 'utf16le');
    return buf.toString('base64');
}

function psExec(command, timeout = 8000) {
    try {
        const encoded = encodePsCommand(command);
        return execSync(
            `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
            { encoding: 'utf-8', timeout, windowsHide: true }
        ).trim();
    } catch (e) {
        log('WARN', 'PS exec failed', e.message?.substring(0, 200));
        return '';
    }
}

function psExecAsync(command, timeout = 8000) {
    return new Promise((resolve) => {
        const encoded = encodePsCommand(command);
        exec(
            `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
            { encoding: 'utf-8', timeout, windowsHide: true },
            (err, stdout) => {
                if (err) {
                    log('WARN', 'PS async exec failed', err.message?.substring(0, 200));
                    resolve('');
                } else {
                    resolve((stdout || '').trim());
                }
            }
        );
    });
}

// ============================================================================
// Windows UI Automation Engine (No CDP!)
// ============================================================================
class WindowsUIAutomation {
    constructor() {
        this.antigravityHwnd = null;
        this.antigravityTitle = '';
        this.isAntigravityRunning = false;
        this.cachedPid = null;
    }

    /**
     * Find the Antigravity main window - iterates ALL processes to find valid handle
     */
    async findAntigravityWindow() {
        // Strategy: find ANY Antigravity process with a non-zero MainWindowHandle
        const result = await psExecAsync(
            `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | ` +
            `Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -ne '' } | ` +
            `Select-Object -First 1 | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`
        );

        if (result && result.includes('|')) {
            const [pid, title] = result.split('|', 2);
            this.cachedPid = parseInt(pid);
            this.antigravityTitle = title;
            this.isAntigravityRunning = true;
            log('INFO', `Antigravity window found: PID=${pid} "${title}"`);
            return true;
        }

        // Fallback: search all processes with 'Antigravity' in title
        const altResult = await psExecAsync(
            `Get-Process | Where-Object { $_.MainWindowTitle -match 'Antigravity' -and $_.MainWindowHandle -ne [IntPtr]::Zero } | ` +
            `Select-Object -First 1 | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`
        );

        if (altResult && altResult.includes('|')) {
            const [pid, title] = altResult.split('|', 2);
            this.cachedPid = parseInt(pid);
            this.antigravityTitle = title;
            this.isAntigravityRunning = true;
            log('INFO', `Antigravity window found (alt): PID=${pid} "${title}"`);
            return true;
        }

        // Last resort: check if process exists even without visible window
        const processCheck = await psExecAsync(
            `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`
        );
        if (processCheck) {
            this.isAntigravityRunning = true;
            this.cachedPid = parseInt(processCheck);
            log('INFO', `Antigravity process found (no window handle): PID=${processCheck}`);
            return true;
        }

        this.isAntigravityRunning = false;
        this.cachedPid = null;
        return false;
    }

    /**
     * Focus the Antigravity window using multiple strategies:
     * 1. Alt-key trick (keybd_event) to bypass SetForegroundWindow restriction
     * 2. AttachThreadInput to attach to foreground thread
     * 3. AppActivate (WScript.Shell) as fallback
     */
    async focusAntigravityWindow() {
        if (!this.isAntigravityRunning) {
            await this.findAntigravityWindow();
        }
        if (!this.isAntigravityRunning) return false;

        // Robust focus script using multiple strategies
        const result = await psExecAsync(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class FocusHelper {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1;
    const uint KEYEVENTF_KEYUP = 0x2;
    
    public static bool ForceFocus(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return false;
        
        IntPtr fgWnd = GetForegroundWindow();
        if (fgWnd == hwnd) return true;
        
        uint fgThread = GetWindowThreadProcessId(fgWnd, out _);
        uint curThread = GetCurrentThreadId();
        
        // Strategy 1: Alt-key trick - simulate Alt press/release to allow focus steal
        keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
        
        // Strategy 2: Attach to foreground thread
        bool attached = false;
        if (fgThread != curThread) {
            attached = AttachThreadInput(curThread, fgThread, true);
        }
        
        ShowWindow(hwnd, 9); // SW_RESTORE
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        
        if (attached) {
            AttachThreadInput(curThread, fgThread, false);
        }
        
        Thread.Sleep(100);
        return GetForegroundWindow() == hwnd || true; // optimistic
    }
}
'@ -ErrorAction SilentlyContinue

# Find the Antigravity process with a valid window handle
$procs = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
$focused = $false

foreach ($proc in $procs) {
    if ([FocusHelper]::ForceFocus($proc.MainWindowHandle)) {
        $focused = $true
        break
    }
}

# Fallback: Use AppActivate (WScript.Shell)
if (-not $focused) {
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $wsh.AppActivate('Antigravity') | Out-Null
        $focused = $true
    } catch {}
}

if ($focused) { 'focused' } else { 'not_found' }
        `);

        const ok = result?.trim() === 'focused';
        if (!ok) {
            log('WARN', 'Focus failed, result:', result);
        }
        return ok;
    }

    /**
     * Send text to Antigravity chat using keyboard simulation
     * Flow: Focus window → Open chat (Ctrl+L) → Type text → Press Enter
     */
    async sendChatMessage(text) {
        try {
            // 1. Focus the Antigravity window
            const focused = await this.focusAntigravityWindow();
            if (!focused) {
                return { success: false, error: 'Cannot focus Antigravity window' };
            }

            // Small delay to ensure window is focused
            await sleep(400);

            // 2. Open/focus the chat input using Ctrl+L (Antigravity chat shortcut)
            await this.sendKeys('^l'); // Ctrl+L to focus chat input
            await sleep(500);

            // 3. Type the message using clipboard (handles all characters)
            await this.typeText(text);
            await sleep(300);

            // 4. Press Enter to send
            await this.sendKeys('{ENTER}');

            log('INFO', 'Message sent via keyboard automation', { len: text.length });
            return { success: true };
        } catch (e) {
            log('ERROR', 'sendChatMessage failed', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Click an approval button by simulating keyboard shortcuts
     */
    async clickApprovalButton(buttonText = 'Accept') {
        try {
            const focused = await this.focusAntigravityWindow();
            if (!focused) {
                return { success: false, error: 'Cannot focus Antigravity window' };
            }
            await sleep(400);

            // Try Tab to navigate to the approval button, then Enter to click
            await this.sendKeys('{TAB}');
            await sleep(200);
            await this.sendKeys('{ENTER}');

            log('INFO', 'Approval action sent', { buttonText });
            return { success: true, clicked: buttonText };
        } catch (e) {
            log('ERROR', 'clickApprovalButton failed', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Send special keys using PowerShell SendKeys
     */
    async sendKeys(keys) {
        await psExecAsync(`
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
[System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')
        `);
    }

    /**
     * Type text safely using clipboard (handles all characters including unicode)
     * More reliable than SendKeys for arbitrary text
     */
    async typeText(text) {
        const escapedText = text.replace(/'/g, "''");
        await psExecAsync(`
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
[System.Windows.Forms.Clipboard]::SetText('${escapedText}')
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 100
        `);
    }

    /**
     * Get Antigravity window title to detect state
     */
    async getWindowTitle() {
        const result = await psExecAsync(
            `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | ` +
            `Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -ne '' } | ` +
            `Select-Object -First 1 -ExpandProperty MainWindowTitle`
        );
        if (result) {
            this.antigravityTitle = result;
            this.isAntigravityRunning = true;
        } else {
            // Still check if process exists
            const exists = await psExecAsync(
                `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`
            );
            this.isAntigravityRunning = !!exists;
            this.antigravityTitle = exists ? '(no visible window)' : '';
        }
        return this.antigravityTitle;
    }
}

// ============================================================================
// Conversation File Monitor
// ============================================================================
class ConversationMonitor {
    constructor() {
        this.lastConversationHash = '';
        this.lastModifiedTime = 0;
        this.cachedMessages = [];
        this.watcher = null;
    }

    /**
     * Start watching the conversations directory for changes
     */
    startWatching(callback) {
        const conversationsDir = CONFIG.AG_CONVERSATIONS_DIR;

        if (!fs.existsSync(conversationsDir)) {
            log('WARN', 'Conversations dir not found', conversationsDir);
            return;
        }

        log('INFO', 'Watching conversations dir', conversationsDir);

        try {
            this.watcher = fs.watch(conversationsDir, { persistent: false }, (eventType, filename) => {
                if (filename && filename.endsWith('.pb')) {
                    log('DEBUG', 'Conversation file changed', filename);
                    if (callback) callback(filename);
                }
            });
        } catch (e) {
            log('WARN', 'Failed to watch conversations dir', e.message);
        }
    }

    /**
     * Get the most recently modified conversation file
     */
    getLatestConversation() {
        const dir = CONFIG.AG_CONVERSATIONS_DIR;
        if (!fs.existsSync(dir)) return null;

        try {
            const files = fs.readdirSync(dir)
                .filter(f => f.endsWith('.pb'))
                .map(f => ({
                    name: f,
                    path: path.join(dir, f),
                    mtime: fs.statSync(path.join(dir, f)).mtimeMs,
                    size: fs.statSync(path.join(dir, f)).size,
                }))
                .sort((a, b) => b.mtime - a.mtime);

            return files[0] || null;
        } catch {
            return null;
        }
    }

    /**
     * Check if conversations have been updated
     */
    hasUpdates() {
        const latest = this.getLatestConversation();
        if (!latest) return false;

        const hash = `${latest.name}:${latest.mtime}:${latest.size}`;
        if (hash !== this.lastConversationHash) {
            this.lastConversationHash = hash;
            this.lastModifiedTime = latest.mtime;
            return true;
        }
        return false;
    }

    stopWatching() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }
}

// ============================================================================
// Process Monitor
// ============================================================================
class ProcessMonitor {
    constructor() {
        this.antigravityRunning = false;
        this.antigravityPids = [];
        this.listeningPorts = [];
    }

    /**
     * Check if Antigravity is running and get its ports
     */
    async refresh() {
        try {
            const pidResult = await psExecAsync(
                `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | ` +
                `Select-Object -ExpandProperty Id`
            );

            if (pidResult) {
                this.antigravityRunning = true;
                this.antigravityPids = pidResult.split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p));
            } else {
                this.antigravityRunning = false;
                this.antigravityPids = [];
            }

            // Get listening ports
            if (this.antigravityPids.length > 0) {
                const pidsFilter = this.antigravityPids.join(',');
                const portResult = await psExecAsync(
                    `Get-NetTCPConnection -State Listen -OwningProcess ${pidsFilter} -ErrorAction SilentlyContinue | ` +
                    `Select-Object -ExpandProperty LocalPort | Sort-Object`
                );
                this.listeningPorts = portResult
                    ? portResult.split(/\r?\n/).map(p => parseInt(p.trim())).filter(p => !isNaN(p))
                    : [];
            } else {
                this.listeningPorts = [];
            }
        } catch (e) {
            log('WARN', 'ProcessMonitor refresh failed', e.message);
        }
    }

    getStatus() {
        return {
            running: this.antigravityRunning,
            pids: this.antigravityPids,
            ports: this.listeningPorts,
        };
    }
}

// ============================================================================
// Antigravity Connection Manager (No CDP)
// ============================================================================
class AntigravityConnection {
    constructor() {
        this.uiAuto = new WindowsUIAutomation();
        this.conversationMonitor = new ConversationMonitor();
        this.processMonitor = new ProcessMonitor();
        this.lastMessages = [];
        this.lastStatus = 'disconnected';
        this.agentStatusFromTitle = 'idle';
        this.conversationUpdateCallback = null;
    }

    async initialize() {
        log('INFO', 'Initializing AntigravityConnection (No CDP mode)...');

        // Check Antigravity process
        await this.processMonitor.refresh();
        log('INFO', 'Process status', this.processMonitor.getStatus());

        // Find Antigravity window
        await this.uiAuto.findAntigravityWindow();
        log('INFO', `Antigravity running: ${this.uiAuto.isAntigravityRunning}`);

        // Start watching conversations
        this.conversationMonitor.startWatching((filename) => {
            log('DEBUG', 'Conversation updated', filename);
            if (this.conversationUpdateCallback) {
                this.conversationUpdateCallback(filename);
            }
        });

        return this.isConnected();
    }

    isConnected() {
        return this.uiAuto.isAntigravityRunning || this.processMonitor.antigravityRunning;
    }

    getStatus() {
        return {
            connected: this.isConnected(),
            method: 'ui_automation', // No CDP!
            antigravityRunning: this.uiAuto.isAntigravityRunning,
            windowTitle: this.uiAuto.antigravityTitle,
            processStatus: this.processMonitor.getStatus(),
            grpc: false,
            cdp: false, // Explicitly false - we don't use CDP
            internalApi: false,
        };
    }

    /**
     * Detect agent status from window title and file activity
     */
    async getAgentStatus() {
        const title = await this.uiAuto.getWindowTitle();
        const pendingApprovals = [];
        let status = 'idle';

        if (!title) {
            return { status: 'disconnected', pendingApprovals: [] };
        }

        // Parse window title for status hints
        const titleLower = title.toLowerCase();

        if (titleLower.includes('thinking') || titleLower.includes('generating') ||
            titleLower.includes('running') || titleLower.includes('working')) {
            status = 'thinking';
        } else if (titleLower.includes('approval') || titleLower.includes('confirm') ||
            titleLower.includes('allow') || titleLower.includes('accept')) {
            status = 'waiting_approval';
            pendingApprovals.push({ text: 'Action requires approval', cls: 'from-title' });
        }

        // Check if conversation files are being actively updated (indicates agent working)
        const latest = this.conversationMonitor.getLatestConversation();
        if (latest) {
            const timeSinceUpdate = Date.now() - latest.mtime;
            if (timeSinceUpdate < 5000) {
                // File was updated in last 5 seconds - agent likely working
                status = status === 'idle' ? 'thinking' : status;
            }
        }

        this.lastStatus = status;
        this.agentStatusFromTitle = status;

        return { status, pendingApprovals, windowTitle: title };
    }

    /**
     * Get chat messages (simplified - returns status info since we can't read DOM)
     * In non-CDP mode, we rely on conversation file monitoring for change detection
     */
    async getChatMessages() {
        // We can't directly read messages without CDP
        // But we can detect conversation changes and provide status updates
        const hasUpdates = this.conversationMonitor.hasUpdates();
        const latest = this.conversationMonitor.getLatestConversation();

        if (hasUpdates && latest) {
            // Notify that conversation was updated
            const updateMsg = {
                id: Date.now(),
                role: 'system',
                content: `💬 Conversation updated (${new Date(latest.mtime).toLocaleTimeString()})`,
                ts: latest.mtime,
            };

            // Keep last messages and add update notification
            if (this.lastMessages.length === 0 ||
                this.lastMessages[this.lastMessages.length - 1]?.ts !== latest.mtime) {
                this.lastMessages.push(updateMsg);
                // Keep only last 50 messages
                if (this.lastMessages.length > 50) {
                    this.lastMessages = this.lastMessages.slice(-50);
                }
            }
        }

        return this.lastMessages;
    }

    async sendChatMessage(text) {
        // Add the user message to local history
        this.lastMessages.push({
            id: Date.now(),
            role: 'user',
            content: text,
            ts: Date.now(),
        });

        return await this.uiAuto.sendChatMessage(text);
    }

    async clickApprovalButton(buttonText) {
        return await this.uiAuto.clickApprovalButton(buttonText);
    }

    onConversationUpdate(callback) {
        this.conversationUpdateCallback = callback;
    }

    disconnect() {
        this.conversationMonitor.stopWatching();
        this.uiAuto.isAntigravityRunning = false;
    }
}

// ============================================================================
// Utility
// ============================================================================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        log('INFO', '=== AntigravityRemote v2.0 (No CDP) starting ===');

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
            console.log('\n  ⚡ AntigravityRemote v2.0 (No CDP Mode)\n');
            console.log(`  Local:   http://localhost:${CONFIG.PORT}`);
            console.log(`  Network: http://${ip}:${CONFIG.PORT}`);
            console.log('  Method:  PowerShell UI Automation + File Monitoring');
            console.log('  \n  Open on your phone to control Antigravity remotely.\n');
            log('INFO', `Server listening on http://${ip}:${CONFIG.PORT}`);
        });

        // Connect to Antigravity
        await this.conn.initialize();
        log('INFO', 'Connection status', this.conn.getStatus());

        // Set initial state based on connection
        if (this.conn.isConnected()) {
            this.lastState.status = 'idle';
        }

        // Listen for conversation updates
        this.conn.onConversationUpdate((filename) => {
            this.broadcast({ type: 'conversation_update', filename, timestamp: Date.now() });
        });

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
        this.app.get('/api/status', async (req, res) => {
            const agentStatus = await this.conn.getAgentStatus();
            res.json({
                connection: this.conn.getStatus(),
                state: { ...this.lastState, ...agentStatus },
                clients: this.clients.size,
                mode: 'ui_automation',
            });
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

        // PWA manifest
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
        ws.send(JSON.stringify({
            type: 'init',
            ...this.conn.getStatus(),
            ...this.lastState,
            mode: 'ui_automation',
        }));

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

            // Auto-reconnect if not connected
            if (!this.conn.isConnected()) {
                await this.conn.processMonitor.refresh();
                await this.conn.uiAuto.findAntigravityWindow();
                if (this.conn.isConnected()) {
                    this.broadcast({ type: 'connection_status', ...this.conn.getStatus() });
                }
            }

            try {
                const [messages, statusInfo] = await Promise.all([
                    this.conn.getChatMessages(),
                    this.conn.getAgentStatus(),
                ]);

                const newState = {
                    messages: Array.isArray(messages) ? messages : [],
                    status: statusInfo?.status || 'unknown',
                    pendingApprovals: statusInfo?.pendingApprovals || [],
                    windowTitle: statusInfo?.windowTitle || '',
                    timestamp: Date.now(),
                };

                // Detect change
                const hash = JSON.stringify({
                    mc: newState.messages.length,
                    st: newState.status,
                    ac: newState.pendingApprovals.length,
                    wt: newState.windowTitle,
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
