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
    try { console.log(entry); } catch { /* EPIPE - stdout pipe broken, ignore */ }
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
// Sử dụng PostMessage/SendMessage để gửi keystroke KHÔNG cần steal focus
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
     * Send text to Antigravity chat using clipboard + brief focus steal + auto-restore
     * Flow: Save current window → Focus Antigravity → Ctrl+L → Paste → Enter → Restore
     * Total disruption time: ~500ms (user barely notices)
     */
    async sendChatMessage(text) {
        try {
            if (!this.isAntigravityRunning) {
                await this.findAntigravityWindow();
            }
            if (!this.isAntigravityRunning) {
                return { success: false, error: 'Antigravity is not running' };
            }

            const escapedText = text.replace(/'/g, "''");

            // ALL-IN-ONE PowerShell script:
            // 1. Save current foreground window
            // 2. Put text in clipboard
            // 3. Briefly focus Antigravity
            // 4. Send Ctrl+L, Ctrl+V, Enter
            // 5. Restore previous window
            const result = await psExecAsync(`
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class RemoteSend {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const byte VK_MENU = 0x12;

    public static IntPtr SaveAndFocus(IntPtr target) {
        IntPtr saved = GetForegroundWindow();
        if (saved == target) return saved;

        // Alt trick to allow focus change
        keybd_event(VK_MENU, 0, 0x1, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, 0x3, UIntPtr.Zero);

        uint fgThread = GetWindowThreadProcessId(saved, out _);
        uint curThread = GetCurrentThreadId();
        bool attached = (fgThread != curThread) && AttachThreadInput(curThread, fgThread, true);

        ShowWindow(target, 9);
        SetForegroundWindow(target);
        BringWindowToTop(target);

        if (attached) AttachThreadInput(curThread, fgThread, false);
        return saved;
    }

    public static void RestoreFocus(IntPtr saved) {
        if (saved == IntPtr.Zero) return;
        keybd_event(VK_MENU, 0, 0x1, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, 0x3, UIntPtr.Zero);
        SetForegroundWindow(saved);
    }
}
'@ -ErrorAction SilentlyContinue

# Find Antigravity window with valid handle
$proc = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) {
    'error:no_window'
    return
}

# 1. Save current foreground window
$savedWnd = [RemoteSend]::SaveAndFocus($proc.MainWindowHandle)

# 2. Wait for focus to settle
Start-Sleep -Milliseconds 200

# 3. Put text in clipboard
[System.Windows.Forms.Clipboard]::SetText('${escapedText}')

# 4. Send Ctrl+L to focus chat input
[System.Windows.Forms.SendKeys]::SendWait('^l')
Start-Sleep -Milliseconds 300

# 5. Paste text
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 200

# 6. Press Enter to send
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 100

# 7. RESTORE previous foreground window immediately
[RemoteSend]::RestoreFocus($savedWnd)

'ok'
            `, 15000);

            if (result?.trim() === 'ok') {
                log('INFO', 'Message sent + window restored', { len: text.length });
                return { success: true };
            } else {
                log('WARN', 'Send result:', result);
                return { success: false, error: result || 'Send failed' };
            }
        } catch (e) {
            log('ERROR', 'sendChatMessage failed', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Click approval button: brief focus → Tab → Enter → restore
     */
    async clickApprovalButton(buttonText = 'Accept') {
        try {
            if (!this.isAntigravityRunning) {
                await this.findAntigravityWindow();
            }
            if (!this.isAntigravityRunning) {
                return { success: false, error: 'Antigravity is not running' };
            }

            const result = await psExecAsync(`
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ApproveHelper {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    const byte VK_MENU = 0x12;
    public static IntPtr SaveAndFocus(IntPtr target) {
        IntPtr saved = GetForegroundWindow();
        keybd_event(VK_MENU, 0, 0x1, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, 0x3, UIntPtr.Zero);
        ShowWindow(target, 9);
        SetForegroundWindow(target);
        return saved;
    }
    public static void Restore(IntPtr saved) {
        if (saved == IntPtr.Zero) return;
        keybd_event(VK_MENU, 0, 0x1, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, 0x3, UIntPtr.Zero);
        SetForegroundWindow(saved);
    }
}
'@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $proc) { 'error:no_window'; return }

$saved = [ApproveHelper]::SaveAndFocus($proc.MainWindowHandle)
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('{TAB}')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 100
[ApproveHelper]::Restore($saved)
'ok'
            `, 10000);

            if (result?.trim() === 'ok') {
                log('INFO', 'Approval sent + window restored', { buttonText });
                return { success: true, clicked: buttonText };
            }
            return { success: false, error: result || 'Approve failed' };
        } catch (e) {
            log('ERROR', 'clickApprovalButton failed', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Get Antigravity window title to detect state
     * SAFE: Only reads process info, NO focus stealing
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
     * Uses debounce to avoid firing hundreds of events per second
     */
    startWatching(callback) {
        const conversationsDir = CONFIG.AG_CONVERSATIONS_DIR;

        if (!fs.existsSync(conversationsDir)) {
            log('WARN', 'Conversations dir not found', conversationsDir);
            return;
        }

        log('INFO', 'Watching conversations dir', conversationsDir);

        let debounceTimer = null;
        let lastFilename = '';

        try {
            this.watcher = fs.watch(conversationsDir, { persistent: false }, (eventType, filename) => {
                if (filename && filename.endsWith('.pb')) {
                    // Debounce: only fire callback once per 2s per filename
                    if (debounceTimer) clearTimeout(debounceTimer);
                    lastFilename = filename;
                    debounceTimer = setTimeout(() => {
                        log('DEBUG', 'Conversation file changed (debounced)', lastFilename);
                        if (callback) callback(lastFilename);
                        debounceTimer = null;
                    }, 2000);
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
// Clipboard Chat Reader
// Reads chat content from Antigravity by: focus → select → copy → read clipboard
// Only triggered on conversation update (not continuous polling)
// ============================================================================
class ClipboardChatReader {
    constructor() {
        this.connected = false;
        this.lastMessages = [];
        this.lastRawText = '';
        this.lastReadTime = 0;
        this.minReadInterval = 5000; // 5s debounce for clipboard reads
        this.readCount = 0;
    }

    async tryConnect() {
        this.connected = true;
        return true;
    }

    /**
     * Read chat using Windows UI Automation API (no focus/clipboard needed)
     * Falls back to window title text extraction if UIA fails
     */
    async readChatMessages() {
        const now = Date.now();
        if (now - this.lastReadTime < this.minReadInterval) {
            return this.lastMessages.length > 0 ? this.lastMessages : null;
        }
        this.lastReadTime = now;
        this.readCount++;
        log('INFO', `UI Automation read #${this.readCount} starting...`);

        try {
            // Build PS command as regular string to avoid backtick conflicts
            const psCmd = [
                'Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue',
                'Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue',
                '',
                '$proc = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1',
                'if (-not $proc) { "ERROR:no_window"; return }',
                '',
                'try {',
                '    $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)',
                '    $textCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true)',
                '    $allElements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)',
                '    $texts = @()',
                '    foreach ($el in $allElements) {',
                '        try {',
                '            $name = $el.Current.Name',
                '            if ($name -and $name.Length -gt 3 -and $name.Length -lt 10000) {',
                '                $controlType = $el.Current.ControlType.ProgrammaticName',
                '                if ($controlType -match "Text|Edit|Document|Group|Custom|Pane") {',
                '                    $texts += $name',
                '                }',
                '            }',
                '        } catch { }',
                '    }',
                '    if ($texts.Count -eq 0) { "ERROR:no_text_found"; return }',
                '    $sep = [char]10 + "===MSGSEP===" + [char]10',
                '    $joined = $texts -join $sep',
                '    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)',
                '    [Convert]::ToBase64String($bytes)',
                '} catch {',
                '    "ERROR:uia_failed:$($_.Exception.Message)"',
                '}',
            ].join('\n');
            const result = await psExecAsync(psCmd, 15000);

            log('DEBUG', 'UIA result: ' + (result ? result.substring(0, 80) + '...' : 'NULL'));

            if (!result || result.startsWith('ERROR:')) {
                log('WARN', 'UIA read error: ' + (result || 'null'));
                return this.lastMessages.length > 0 ? this.lastMessages : null;
            }

            const rawText = Buffer.from(result.trim(), 'base64').toString('utf-8');
            log('INFO', `UIA raw text length: ${rawText.length} chars`);
            log('DEBUG', `UIA preview: ${rawText.substring(0, 300).replace(/\n/g, '\\n')}`);

            if (!rawText || rawText.length < 5) {
                return this.lastMessages.length > 0 ? this.lastMessages : null;
            }

            if (rawText === this.lastRawText) {
                return this.lastMessages;
            }
            this.lastRawText = rawText;

            const messages = this.parseUIAText(rawText);
            log('INFO', `Parsed ${messages.length} messages from UIA`);
            if (messages.length > 0) {
                this.lastMessages = messages;
            }
            return this.lastMessages.length > 0 ? this.lastMessages : null;
        } catch (e) {
            log('WARN', 'UIA read failed', e.message);
            return this.lastMessages.length > 0 ? this.lastMessages : null;
        }
    }

    /**
     * Parse UI Automation text into structured messages
     * UIA returns text segments separated by ===MSGSEP===
     * Filters out VS Code UI chrome to extract actual chat content
     */
    parseUIAText(text) {
        const segments = text.split('===MSGSEP===')
            .map(s => s.trim())
            .filter(s => s.length > 20); // Only keep segments > 20 chars (chat msgs are longer)

        const messages = [];
        let msgId = 0;

        // Skip patterns for VS Code / Antigravity UI chrome
        const skipPatterns = [
            /^(File|Edit|View|Run|Terminal|Help|Source Control|Extensions)$/i,
            /^(Search|Debug|Testing|Output|Problems|Ports|Comments)$/i,
            /^\d+$/,                        // Line numbers
            /^[A-Z]:\\/i,                   // File paths
            /\(Ctrl\+/i,                    // Keyboard shortcuts
            /^(Accept|Reject|Allow|Deny|Cancel|OK|Yes|No|Close|Open|Save)$/i,
            /^Antigravity/i,                // Window titles
            /^(Connected|Disconnected|Connecting)$/i,
            /^\s*$/,
            /^(Explorer|Profile|Outline|Timeline|Git|npm|Accounts)$/i,
            /^(Tab|Panel|Editor|Sidebar|Activity Bar|Status Bar)/i,
            /^(Maximize|Minimize|Restore|Go Back|Go Forward)/i,
            /\.(js|ts|css|html|json|md|py|txt|log|pb)$/i, // File names
            /^(server|public|node_modules|package|debug|index)/i,
            /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_]/,  // Object.property patterns
            /^(const|let|var|function|class|import|export|if|for|while|return)\s/,  // Code
            /^\{.*\}$/,                     // JSON objects
            /^\[.*\]$/,                     // Arrays
            /^\/\//,                        // Comments
            /^#\s/,                         // Markdown headings (likely from code)
        ];

        for (const seg of segments) {
            // Skip UI chrome
            if (skipPatterns.some(p => p.test(seg))) continue;

            // Skip very short segments (likely UI labels)
            if (seg.length < 30) continue;

            // Skip segments that look like code (high ratio of special chars)
            const specialChars = (seg.match(/[{}()=>;:,\[\]]/g) || []).length;
            if (specialChars / seg.length > 0.15) continue;

            // Determine role based on content patterns
            const isUserLike = seg.length < 300 && !seg.includes('\n');

            messages.push({
                id: msgId++,
                role: isUserLike && msgId % 2 === 1 ? 'user' : 'assistant',
                content: seg.substring(0, 5000),
                ts: Date.now(),
            });
        }

        // If too many messages, likely still picking up chrome - keep only longer ones
        if (messages.length > 50) {
            const filtered = messages.filter(m => m.content.length > 50);
            return filtered.length > 0 ? filtered.slice(-50) : messages.slice(-50);
        }

        return messages;
    }

    /**
     * Parse raw clipboard text into structured messages
     */
    parseClipboardText(text) {
        const messages = [];
        const lines = text.split(/\r?\n/);
        let currentContent = [];
        let msgId = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                if (currentContent.length > 0) {
                    const content = currentContent.join('\n').trim();
                    if (content.length > 2) {
                        messages.push({
                            id: msgId++,
                            role: 'assistant',
                            content: content.substring(0, 3000),
                            ts: Date.now(),
                        });
                    }
                    currentContent = [];
                }
                continue;
            }
            currentContent.push(trimmed);
        }

        if (currentContent.length > 0) {
            const content = currentContent.join('\n').trim();
            if (content.length > 2) {
                messages.push({
                    id: msgId++,
                    role: 'assistant',
                    content: content.substring(0, 3000),
                    ts: Date.now(),
                });
            }
        }

        if (messages.length === 0 && text.trim().length > 10) {
            messages.push({
                id: 0,
                role: 'assistant',
                content: text.trim().substring(0, 5000),
                ts: Date.now(),
            });
        }

        return messages;
    }

    async readAgentStatus() {
        return null;
    }

    disconnect() {
        this.connected = false;
    }
}

// ============================================================================
// Antigravity Connection Manager (Hybrid: UI Automation + CDP Reader)
// ============================================================================
class AntigravityConnection {
    constructor() {
        this.uiAuto = new WindowsUIAutomation();
        this.conversationMonitor = new ConversationMonitor();
        this.processMonitor = new ProcessMonitor();
        this.clipReader = new ClipboardChatReader();
        this.lastMessages = [];
        this.lastStatus = 'disconnected';
        this.agentStatusFromTitle = 'idle';
        this.conversationUpdateCallback = null;
        this.pendingRead = false; // flag: conversation updated, need to read chat
    }

    async initialize() {
        log('INFO', 'Initializing AntigravityConnection (Clipboard Reader mode)...');

        // Check Antigravity process
        await this.processMonitor.refresh();
        log('INFO', 'Process status', this.processMonitor.getStatus());

        // Find Antigravity window
        await this.uiAuto.findAntigravityWindow();
        log('INFO', `Antigravity running: ${this.uiAuto.isAntigravityRunning}`);

        // Initialize clipboard reader
        await this.clipReader.tryConnect();
        log('INFO', 'Clipboard chat reader ready');

        // Start watching conversations - trigger clipboard read on update
        this.conversationMonitor.startWatching((filename) => {
            log('DEBUG', 'Conversation updated', filename);
            this.pendingRead = true; // Mark that we need to read chat content
            if (this.conversationUpdateCallback) {
                this.conversationUpdateCallback(filename);
            }
        });

        // Initial chat read
        if (this.uiAuto.isAntigravityRunning) {
            try {
                const msgs = await this.clipReader.readChatMessages();
                if (msgs && msgs.length > 0) {
                    this.lastMessages = msgs;
                    log('INFO', `Initial chat read: ${msgs.length} messages`);
                }
            } catch (e) {
                log('WARN', 'Initial chat read failed', e.message);
            }
        }

        return this.isConnected();
    }

    isConnected() {
        return this.uiAuto.isAntigravityRunning || this.processMonitor.antigravityRunning;
    }

    getStatus() {
        return {
            connected: this.isConnected(),
            method: 'clipboard_reader',
            antigravityRunning: this.uiAuto.isAntigravityRunning,
            windowTitle: this.uiAuto.antigravityTitle,
            processStatus: this.processMonitor.getStatus(),
            grpc: false,
            cdp: false,
            clipboardReader: true,
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

        const titleLower = title.toLowerCase();

        if (titleLower.includes('thinking') || titleLower.includes('generating') ||
            titleLower.includes('running') || titleLower.includes('working')) {
            status = 'thinking';
        } else if (titleLower.includes('approval') || titleLower.includes('confirm') ||
            titleLower.includes('allow') || titleLower.includes('accept')) {
            status = 'waiting_approval';
            pendingApprovals.push({ text: 'Action requires approval', cls: 'from-title' });
        }

        // Check file activity
        const latest = this.conversationMonitor.getLatestConversation();
        if (latest) {
            const timeSinceUpdate = Date.now() - latest.mtime;
            if (timeSinceUpdate < 5000) {
                status = status === 'idle' ? 'thinking' : status;
            }
        }

        this.lastStatus = status;
        return { status, pendingApprovals, windowTitle: title };
    }

    /**
     * Get chat messages - reads actual content via clipboard on conversation update
     */
    async getChatMessages() {
        // If conversation was updated, read actual chat content
        if (this.pendingRead && this.clipReader.connected) {
            this.pendingRead = false;
            log('INFO', 'pendingRead triggered, reading clipboard...');
            try {
                const clipMsgs = await this.clipReader.readChatMessages();
                if (clipMsgs && clipMsgs.length > 0) {
                    log('INFO', `Clipboard read success: ${clipMsgs.length} messages`);
                    this.lastMessages = clipMsgs;
                    return clipMsgs;
                } else {
                    log('WARN', 'Clipboard returned no messages');
                }
            } catch (e) {
                log('WARN', 'Clipboard read on update failed', e.message);
            }
        }

        // If we have cached messages from clipboard, return them
        if (this.lastMessages.length > 0) {
            return this.lastMessages;
        }

        // Fallback: file change notifications only
        const hasUpdates = this.conversationMonitor.hasUpdates();
        const latest = this.conversationMonitor.getLatestConversation();

        if (hasUpdates && latest) {
            log('DEBUG', 'No cached messages, creating file update notification');
            const updateMsg = {
                id: Date.now(),
                role: 'system',
                content: `💬 Conversation updated (${new Date(latest.mtime).toLocaleTimeString()})`,
                ts: latest.mtime,
            };

            if (this.lastMessages.length === 0 ||
                this.lastMessages[this.lastMessages.length - 1]?.ts !== latest.mtime) {
                this.lastMessages.push(updateMsg);
                if (this.lastMessages.length > 50) {
                    this.lastMessages = this.lastMessages.slice(-50);
                }
            }
        }

        return this.lastMessages;
    }

    async sendChatMessage(text) {
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
        this.clipReader.disconnect();
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
            console.log('\n  ⚡ AntigravityRemote v2.0 (Hybrid Mode)\n');
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
                mode: this.conn.getStatus().method,
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
            mode: this.conn.getStatus().method,
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

// Global error handlers to prevent server crash
process.on('uncaughtException', (err) => {
    log('ERROR', 'Uncaught Exception', err.message);
    log('ERROR', 'Stack', err.stack);
});
process.on('unhandledRejection', (reason) => {
    log('ERROR', 'Unhandled Rejection', String(reason));
});

const app = new AntigravityRemote();
app.start().catch((err) => {
    log('ERROR', 'Fatal', err.message);
    process.exit(1);
});
