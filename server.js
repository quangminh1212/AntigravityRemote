#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inspectUI } from './ui_inspector.js';
import { execSync, spawn } from 'child_process';
import multer from 'multer';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNTIME_ROOT = process.env.AG_RUNTIME_DIR || __dirname;
const IS_EMBEDDED_RUNTIME = process.env.TAURI_EMBEDDED === '1';

try {
    fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
} catch (e) {
    console.error('Failed to initialize runtime directory:', e.message);
    process.exit(1);
}

// ============================================================
// FILE LOGGING SYSTEM - All output goes to log.txt for debugging
// ============================================================
const LOG_FILE = join(RUNTIME_ROOT, 'log.txt');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB auto-rotate

// Rotate log if too large
try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
        const backupPath = join(RUNTIME_ROOT, 'log.old.txt');
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        fs.renameSync(LOG_FILE, backupPath);
    }
} catch (e) { /* ignore rotation errors */ }

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });

function formatLogLine(level, args) {
    const ts = new Date().toISOString();
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    // Strip emoji for clean log file on Windows
    const clean = msg.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]/gu, '').trim();
    return `[${ts}] [${level}] ${clean}\n`;
}

// Intercept console methods → write to both terminal AND log.txt
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log = (...args) => {
    _origLog(...args);
    try { logStream.write(formatLogLine('INFO', args)); } catch (e) { /* ignore */ }
};
console.warn = (...args) => {
    _origWarn(...args);
    try { logStream.write(formatLogLine('WARN', args)); } catch (e) { /* ignore */ }
};
console.error = (...args) => {
    _origError(...args);
    try { logStream.write(formatLogLine('ERROR', args)); } catch (e) { /* ignore */ }
};

// ============================================================
// CRASH PROTECTION - Prevent process from dying on unhandled errors
// ============================================================
process.on('uncaughtException', (err) => {
    console.error('💥 UNCAUGHT EXCEPTION (process kept alive):', err.message);
    console.error('   Stack:', err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 UNHANDLED REJECTION (process kept alive):', reason);
});

console.log('========================================');
console.log('🚀 Antigravity Remote starting...');
console.log(`   PID: ${process.pid}`);
console.log(`   Node: ${process.version}`);
console.log(`   Time: ${new Date().toISOString()}`);
console.log(`   Runtime root: ${RUNTIME_ROOT}`);
console.log(`   Runtime mode: ${IS_EMBEDDED_RUNTIME ? 'embedded-webview' : 'browser-server'}`);
console.log('========================================');

const PORTS = [9000, 9001, 9002, 9003];
const PRIMARY_CDP_PORT = PORTS[0];
const POLL_INTERVAL = 500; // 500ms for smoother updates
const SNAPSHOT_WARMUP_DELAY_MS = 350;
const SNAPSHOT_REQUEST_WAIT_MS = 3500;
const SNAPSHOT_REQUEST_WAIT_MAX_MS = 5000;
const SNAPSHOT_READY_TEXT_THRESHOLD = 120;
const SNAPSHOT_PLACEHOLDER_TEXT_MAX = 90;
const SERVER_PORT = Number(process.env.PORT || 3000);
const EMBEDDED_HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || process.env.AG_PUBLIC_URL || '');
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const AUTH_COOKIE_NAME = 'ag_auth_token';
const AUTO_LAUNCH_ANTIGRAVITY = process.env.AG_SKIP_AUTO_LAUNCH !== '1';
// Note: hashString is defined later, so we'll initialize the token inside createServer or use a simple string for now.
let AUTH_TOKEN = 'ag_default_token';


// Shared CDP connection
let cdpConnection = null;
let lastSnapshot = null;
let lastSnapshotHash = null;
let antigravityLaunchPromise = null;
let snapshotFailureStreak = 0;
let isRecoveringSnapshotConnection = false;
let snapshotWarmupPromise = null;
let snapshotWarmupStreak = 0;

// Kill any existing process on the server port (prevents EADDRINUSE)
async function killPortProcess(port) {
    // Step 1: Find and kill processes on the port
    try {
        if (process.platform === 'win32') {
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0' && pid !== String(process.pid)) pids.add(pid);
            }
            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p);
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
    } catch (e) {
        // No process found on port - this is fine
    }

    // Step 2: Wait until port is actually free (max 5 seconds)
    const maxWait = 5000;
    const checkInterval = 200;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        const isFree = await new Promise(resolve => {
            const testServer = http.createServer();
            testServer.once('error', () => resolve(false));
            testServer.once('listening', () => {
                testServer.close(() => resolve(true));
            });
            testServer.listen(port, '0.0.0.0');
        });
        if (isFree) {
            console.log(`✅ Port ${port} is free`);
            return;
        }
        await new Promise(r => setTimeout(r, checkInterval));
    }
    console.warn(`⚠️  Port ${port} may still be in use after ${maxWait}ms wait`);
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

function normalizePublicBaseUrl(rawUrl) {
    if (!rawUrl) {
        return null;
    }

    try {
        const url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('PUBLIC_BASE_URL must start with http:// or https://');
        }

        return url.origin;
    } catch (error) {
        console.warn(`Ignoring invalid PUBLIC_BASE_URL: ${error.message}`);
        return null;
    }
}

function ensureDirectory(path) {
    fs.mkdirSync(path, { recursive: true });
}

function getCloudflaredDownloadUrl() {
    if (process.platform !== 'win32') {
        return null;
    }

    if (process.arch === 'x64') {
        return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    }

    if (process.arch === 'ia32') {
        return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe';
    }

    return null;
}

function downloadFile(downloadUrl, destinationPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Too many redirects while downloading cloudflared'));
            return;
        }

        const client = downloadUrl.startsWith('https:') ? https : http;
        const request = client.get(downloadUrl, {
            headers: {
                'User-Agent': 'AntigravityRemote/1.0'
            }
        }, (response) => {
            const { statusCode = 0, headers } = response;

            if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
                response.resume();
                const redirectedUrl = new URL(headers.location, downloadUrl).toString();
                resolve(downloadFile(redirectedUrl, destinationPath, redirectCount + 1));
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`Failed to download cloudflared (HTTP ${statusCode})`));
                return;
            }

            ensureDirectory(dirname(destinationPath));
            const tempPath = `${destinationPath}.tmp-${process.pid}`;
            const fileStream = fs.createWriteStream(tempPath);

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(() => {
                    try {
                        fs.renameSync(tempPath, destinationPath);
                        if (process.platform !== 'win32') {
                            fs.chmodSync(destinationPath, 0o755);
                        }
                        resolve(destinationPath);
                    } catch (error) {
                        try { fs.unlinkSync(tempPath); } catch (unlinkError) { }
                        reject(error);
                    }
                });
            });

            fileStream.on('error', (error) => {
                try { fs.unlinkSync(tempPath); } catch (unlinkError) { }
                reject(error);
            });
        });

        request.on('error', reject);
    });
}

async function ensureCloudflaredBinary() {
    const bundledDir = join(RUNTIME_ROOT, 'tools');
    const bundledPath = join(bundledDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }

    const installedPath = findCommandOnPath('cloudflared');
    if (installedPath) {
        return installedPath;
    }

    const downloadUrl = getCloudflaredDownloadUrl();
    if (!downloadUrl) {
        throw new Error(`cloudflared is not installed and automatic project-local download is not supported on ${process.platform}/${process.arch}`);
    }

    console.log(`[PUBLIC] Downloading cloudflared into ${bundledPath}`);
    await downloadFile(downloadUrl, bundledPath);
    console.log('[PUBLIC] cloudflared download completed');
    return bundledPath;
}

function buildConnectUrl(baseUrl, password) {
    const url = new URL(baseUrl);
    url.searchParams.set('key', password);
    return url.toString();
}

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureRuntimeSslCertificates(keyPath, certPath) {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        return true;
    }

    try {
        console.log('SSL certificates not found. Generating certificates for default HTTPS access...');
        execSync('node generate_ssl.js', {
            cwd: __dirname,
            stdio: 'pipe',
            env: {
                ...process.env,
                AG_RUNTIME_DIR: RUNTIME_ROOT
            }
        });
    } catch (error) {
        console.warn(`Auto SSL certificate generation failed: ${error.message}`);
    }

    return fs.existsSync(keyPath) && fs.existsSync(certPath);
}

function getAntigravityStoragePath() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'storage.json');
    }

    if (process.platform === 'darwin' && process.env.HOME) {
        return join(process.env.HOME, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'storage.json');
    }

    if (process.env.XDG_CONFIG_HOME) {
        return join(process.env.XDG_CONFIG_HOME, 'Antigravity', 'User', 'globalStorage', 'storage.json');
    }

    if (process.env.HOME) {
        return join(process.env.HOME, '.config', 'Antigravity', 'User', 'globalStorage', 'storage.json');
    }

    return null;
}

function findRecentAntigravityWorkspace() {
    const storagePath = getAntigravityStoragePath();
    if (!storagePath || !fs.existsSync(storagePath)) {
        return null;
    }

    try {
        const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
        const folderUris = [
            storage?.windowsState?.lastActiveWindow?.folder,
            ...(storage?.backupWorkspaces?.folders || []).map(folder => folder?.folderUri)
        ].filter(Boolean);

        for (const folderUri of folderUris) {
            try {
                const workspacePath = fileURLToPath(folderUri);
                if (workspacePath && fs.existsSync(workspacePath)) {
                    return workspacePath;
                }
            } catch (error) {
                console.warn(`Ignoring invalid Antigravity workspace URI: ${folderUri}`);
            }
        }
    } catch (error) {
        console.warn(`Failed to read Antigravity storage: ${error.message}`);
    }

    return null;
}

function getTargetWorkspace() {
    return findRecentAntigravityWorkspace() || process.cwd();
}

function findCommandOnPath(command) {
    const locator = process.platform === 'win32' ? 'where' : 'which';

    try {
        const output = execSync(`${locator} ${command}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return output.split(/\r?\n/).find(Boolean) || null;
    } catch (error) {
        return null;
    }
}

function findAntigravityExecutable() {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const defaultPath = join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'Antigravity.exe');
        if (fs.existsSync(defaultPath)) {
            return defaultPath;
        }
    }

    return findCommandOnPath(process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity')
        || (process.platform === 'win32' ? findCommandOnPath('antigravity') : null);
}

function isAntigravityRunning() {
    try {
        if (process.platform === 'win32') {
            const output = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return output.toLowerCase().includes('antigravity.exe');
        }

        execSync('pgrep -f antigravity', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

function killAntigravityProcesses() {
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM Antigravity.exe', { stdio: 'ignore' });
            return;
        }

        execSync('pkill -f antigravity', { stdio: 'ignore' });
    } catch (error) {
        // Ignore "not running" failures.
    }
}

async function waitForCDP(timeoutMs = 30000) {
    const start = Date.now();

    while ((Date.now() - start) < timeoutMs) {
        try {
            await discoverCDP();
            return true;
        } catch (error) {
            await sleep(1000);
        }
    }

    return false;
}

async function launchAntigravityWithCDP() {
    if (!AUTO_LAUNCH_ANTIGRAVITY) {
        return { skipped: true };
    }

    if (antigravityLaunchPromise) {
        return antigravityLaunchPromise;
    }

    antigravityLaunchPromise = (async () => {
        const executable = findAntigravityExecutable();
        if (!executable) {
            console.warn('Antigravity executable not found. Start Antigravity manually with --remote-debugging-port=9000.');
            return { attempted: false, reason: 'missing-executable' };
        }

        const targetWorkspace = getTargetWorkspace();

        if (isAntigravityRunning()) {
            console.log(`Antigravity is running without CDP. Restarting with --remote-debugging-port=${PRIMARY_CDP_PORT}...`);
            killAntigravityProcesses();
            await sleep(1500);
        } else {
            console.log(`Antigravity is not running. Launching with --remote-debugging-port=${PRIMARY_CDP_PORT}...`);
        }

        console.log(`Opening Antigravity on workspace: ${targetWorkspace}`);

        try {
            const child = spawn(executable, [
                targetWorkspace,
                `--remote-debugging-port=${PRIMARY_CDP_PORT}`
            ], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
        } catch (error) {
            console.error(`Failed to launch Antigravity: ${error.message}`);
            return { attempted: false, reason: 'spawn-failed', error: error.message };
        }

        const ready = await waitForCDP(30000);
        if (ready) {
            console.log(`Antigravity CDP is ready on port ${PRIMARY_CDP_PORT}.`);
        } else {
            console.warn('Antigravity launched, but CDP is still not available after 30s.');
        }

        return { attempted: true, ready, targetWorkspace };
    })().finally(() => {
        antigravityLaunchPromise = null;
    });

    return antigravityLaunchPromise;
}

// Find Antigravity CDP endpoint
// Find Antigravity CDP endpoint
function describeCDPTarget(target = {}) {
    return String(target.title || '').trim() || target.url || 'unknown target';
}

function classifyCDPTarget(target = {}) {
    const url = String(target.url || '').toLowerCase();
    const title = String(target.title || '').trim();
    const lowerTitle = title.toLowerCase();

    if (target.type !== 'page' || !target.webSocketDebuggerUrl) {
        return { kind: 'unsupported', score: -1000, label: describeCDPTarget(target) };
    }

    if (url.includes('/workbench/workbench.html')) {
        return { kind: 'standard-workbench', score: 300, label: describeCDPTarget(target) };
    }

    if (url.includes('workbench-jetski-agent.html') || lowerTitle === 'launchpad') {
        return { kind: 'launchpad', score: 50, label: describeCDPTarget(target) };
    }

    if (url.includes('workbench') && !url.includes('jetski')) {
        return { kind: 'workbench', score: 220, label: describeCDPTarget(target) };
    }

    if (lowerTitle.includes('antigravity')) {
        return { kind: 'antigravity-page', score: 180, label: describeCDPTarget(target) };
    }

    return { kind: 'other', score: 0, label: describeCDPTarget(target) };
}

async function discoverCDP() {
    const errors = [];
    const candidates = [];
    const launchpadCandidates = [];

    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            for (const target of Array.isArray(list) ? list : []) {
                const meta = classifyCDPTarget(target);
                if (meta.kind === 'unsupported') continue;

                const candidate = {
                    port,
                    url: target.webSocketDebuggerUrl,
                    target,
                    kind: meta.kind,
                    score: meta.score,
                    label: meta.label
                };

                if (meta.kind === 'launchpad') {
                    launchpadCandidates.push(candidate);
                } else if (meta.score > 0) {
                    candidates.push(candidate);
                }
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }

    if (candidates.length > 0) {
        candidates.sort((a, b) =>
            b.score - a.score ||
            String(b.target?.title || '').length - String(a.target?.title || '').length ||
            a.port - b.port
        );
        const best = candidates[0];
        console.log(`Found ${best.kind} target:`, best.label);
        return best;
    }

    if (launchpadCandidates.length > 0) {
        const summary = launchpadCandidates
            .map(candidate => `${candidate.port}:${candidate.label}`)
            .join(', ');
        throw new Error(`Standard workbench target not ready yet. Launchpad detected on ${summary}`);
    }

    const errorSummary = errors.length ? `Errors: ${errors.join(', ')}` : 'No ports responding';
    throw new Error(`CDP not found. ${errorSummary}`);
}

// Connect to CDP
async function connectCDP(url, targetInfo = null) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map(); // Track pending calls by ID
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000; // 30 seconds timeout

    // Single centralized message handler (fixes MaxListenersExceeded warning)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch (e) { }
    });

    // Handle CDP WebSocket disconnect - triggers auto-reconnect in polling loop
    ws.on('close', () => {
        console.warn('🔌 CDP WebSocket closed - will auto-reconnect');
        // Reject all pending calls
        for (const [id, { reject, timeoutId }] of pendingCalls) {
            clearTimeout(timeoutId);
            reject(new Error('CDP connection closed'));
        }
        pendingCalls.clear();
        if (cdpConnection?.ws === ws) {
            cdpConnection = null;
        }
    });

    ws.on('error', (err) => {
        console.error('🔌 CDP WebSocket error:', err.message);
        // Don't null cdpConnection here - 'close' event will handle it
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        // Check if WebSocket is still open before sending
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('CDP WebSocket not open'));
        }

        const id = idCounter++;

        // Setup timeout to prevent memory leaks from never-resolved calls
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);

        pendingCalls.set(id, { resolve, reject, timeoutId });

        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
            clearTimeout(timeoutId);
            pendingCalls.delete(id);
            reject(new Error(`CDP send failed: ${e.message}`));
        }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return {
        ws,
        call,
        contexts,
        targetInfo,
        connectedAt: Date.now()
    };
}

function getPreferredContexts(contexts = []) {
    return [...contexts].sort((a, b) => {
        const aDefault = a?.auxData?.isDefault ? 1 : 0;
        const bDefault = b?.auxData?.isDefault ? 1 : 0;
        if (aDefault !== bDefault) return bDefault - aDefault;
        return (a?.id || 0) - (b?.id || 0);
    });
}

function shouldRetryChatContainerRecovery(connection) {
    const targetKind = connection?.targetInfo?.kind || '';
    if (targetKind === 'launchpad') {
        return true;
    }

    const connectedAt = connection?.connectedAt || 0;
    return connectedAt > 0 && (Date.now() - connectedAt) < 15000;
}

async function recoverSnapshotConnection() {
    if (isRecoveringSnapshotConnection) {
        return null;
    }

    isRecoveringSnapshotConnection = true;
    const previousConnection = cdpConnection;

    try {
        console.warn('Attempting fresh CDP snapshot recovery...');
        const cdpInfo = await discoverCDP();
        const freshConnection = await connectCDP(cdpInfo.url, cdpInfo);
        const freshSnapshot = await captureSnapshot(freshConnection);

        if (freshSnapshot && !freshSnapshot.error) {
            cdpConnection = freshConnection;
            if (previousConnection?.ws && previousConnection.ws !== freshConnection.ws) {
                try { previousConnection.ws.close(); } catch (e) { }
            }
            console.warn('Recovered snapshot capture using a fresh CDP connection');
            return freshSnapshot;
        }

        try { freshConnection.ws.close(); } catch (e) { }
        return freshSnapshot;
    } catch (error) {
        return { error: `Fresh CDP recovery failed: ${error.message}` };
    } finally {
        isRecoveringSnapshotConnection = false;
    }
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = String.raw`(async () => {
        const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
        if (!cascade) {
            // Debug info
            const body = document.body;
            const childIds = Array.from(body.children).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        // Find the main scrollable container
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);
        const collectText = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
        const hasMeasuredHeight = (el) => /height\s*:\s*\d+(\.\d+)?px/i.test(el?.getAttribute('style') || '');
        const isSkeletonLikeElement = (el) => {
            const className = typeof el?.className === 'string' ? el.className : '';
            return className.includes('bg-gray-500/10') || className.includes('animate-pulse') || className.includes('skeleton');
        };
        const isIgnorableTurnChild = (el) => {
            if (!el) return false;
            const text = collectText(el);
            if (text) return false;

            const className = typeof el.className === 'string' ? el.className : '';
            const styleText = el.getAttribute('style') || '';
            const isHidden =
                className.includes('hidden') ||
                className.includes('opacity-0') ||
                /display\s*:\s*none/i.test(styleText) ||
                /visibility\s*:\s*hidden/i.test(styleText);
            const hasRichContent = !!el.querySelector('img, video, canvas, pre, code, table, a[href], button');

            return !hasRichContent && (isSkeletonLikeElement(el) || (isHidden && el.children.length <= 2) || hasMeasuredHeight(el));
        };
        
        // Remove the interaction/input area without touching message content.
        try {
            // 1. Identify common interaction wrappers by class combinations
            const interactionSelectors = [
                '.relative.flex.flex-col.gap-8',
                '.flex.grow.flex-col.justify-start.gap-8',
                'div[class*="interaction-area"]',
                '[class*="bg-gray-500/10"]',
                '.outline-solid.justify-between',
                '[contenteditable="true"]'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        // For the editor, we want to remove its interaction container
                        if (selector === '[contenteditable="true"]') {
                            const area = el.closest('.relative.flex.flex-col.gap-8') || 
                                         el.closest('.flex.grow.flex-col.justify-start.gap-8') ||
                                         el.closest('div[id^="interaction"]') ||
                                         el.parentElement?.parentElement;
                            if (area && area !== clone) area.remove();
                            else el.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });
        } catch (globalErr) { }

        // Mark user messages vs assistant messages for styling
        try {
            const turnsContainer = clone.querySelector('.relative.flex.flex-col.gap-y-3.px-4') || clone;
            const turns = Array.from(turnsContainer.children).filter(el => el.tagName === 'DIV');
            turns.forEach(turn => {
                const children = Array.from(turn.children)
                    .filter(c => c.tagName === 'DIV')
                    .filter(c => !isIgnorableTurnChild(c));
                // Only infer a user/assistant pair when the turn actually has
                // multiple meaningful blocks. Virtualized scroll buckets often
                // collapse to a single wrapper, and tagging that wrapper as
                // "user" paints the entire assistant output like a chat bubble.
                if (children.length >= 2) {
                    children[0].setAttribute('data-role', 'user');
                    for (let i = 1; i < children.length; i++) {
                        children[i].setAttribute('data-role', 'assistant');
                    }
                }
            });
        } catch(e) {}

        // Inline images so detached snapshot HTML still renders in mobile/webview.
        let inlinedImageCount = 0;
        let contentImageCount = 0;
        try {
            const originalImages = Array.from(cascade.querySelectorAll('img'));
            const clonedImages = Array.from(clone.querySelectorAll('img'));
            const toDataUrl = (blob) => new Promise(resolve => {
                try {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result || null);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(blob);
                } catch (e) {
                    resolve(null);
                }
            });
            const normalizeFetchSrc = (src) => {
                if (!src) return '';
                const value = String(src).trim();
                if (/^[A-Za-z]:[\\/]/.test(value)) {
                    return 'file:///' + value.replace(/\\/g, '/');
                }
                return value;
            };
            const shouldFetchImage = (src) => {
                if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return false;
                return /^(blob:|vscode-file:|file:|https?:|\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(src);
            };
            const stripResponsiveImageAttrs = (img) => {
                if (!img) return;
                img.removeAttribute('srcset');
                img.removeAttribute('sizes');
                const picture = img.closest('picture');
                if (!picture) return;
                picture.querySelectorAll('source').forEach(source => {
                    source.removeAttribute('srcset');
                    source.removeAttribute('sizes');
                });
            };
            const getImageRenderMetrics = (sourceImg, targetImg) => {
                const rect = typeof sourceImg?.getBoundingClientRect === 'function'
                    ? sourceImg.getBoundingClientRect()
                    : null;
                const computedStyle = sourceImg ? window.getComputedStyle(sourceImg) : null;
                const renderedWidth = Math.round(
                    rect?.width
                    || parseFloat(computedStyle?.width)
                    || Number(targetImg?.getAttribute('width'))
                    || 0
                );
                const renderedHeight = Math.round(
                    rect?.height
                    || parseFloat(computedStyle?.height)
                    || Number(targetImg?.getAttribute('height'))
                    || 0
                );
                const naturalWidth = sourceImg?.naturalWidth || Number(targetImg?.getAttribute('width')) || 0;
                const naturalHeight = sourceImg?.naturalHeight || Number(targetImg?.getAttribute('height')) || 0;
                return {
                    renderedWidth,
                    renderedHeight,
                    naturalWidth,
                    naturalHeight,
                    objectFit: computedStyle?.objectFit || ''
                };
            };
            const markImageKind = (sourceImg, targetImg) => {
                const { renderedWidth, renderedHeight, naturalWidth, naturalHeight } = getImageRenderMetrics(sourceImg, targetImg);
                const width = renderedWidth || naturalWidth;
                const height = renderedHeight || naturalHeight;
                const kind = width > 0 && height > 0 && width <= 48 && height <= 48
                    ? 'inline-icon'
                    : 'content-image';
                targetImg.setAttribute('data-remote-image-kind', kind);
                return kind;
            };
            const preserveImageSizing = (sourceImg, targetImg, kind) => {
                if (!targetImg) return;
                const { renderedWidth, renderedHeight, naturalWidth, naturalHeight, objectFit } = getImageRenderMetrics(sourceImg, targetImg);
                const maxWidth = renderedWidth || naturalWidth;
                const aspectWidth = renderedWidth || naturalWidth;
                const aspectHeight = renderedHeight || naturalHeight;

                if (renderedWidth > 0) {
                    targetImg.setAttribute('data-remote-rendered-width', String(renderedWidth));
                }
                if (renderedHeight > 0) {
                    targetImg.setAttribute('data-remote-rendered-height', String(renderedHeight));
                }

                if (kind === 'inline-icon') {
                    if (renderedWidth > 0) {
                        targetImg.style.setProperty('width', String(renderedWidth) + 'px', 'important');
                        targetImg.style.setProperty('max-width', String(renderedWidth) + 'px', 'important');
                    }
                    if (renderedHeight > 0) {
                        targetImg.style.setProperty('height', String(renderedHeight) + 'px', 'important');
                        targetImg.style.setProperty('max-height', String(renderedHeight) + 'px', 'important');
                    }
                    targetImg.style.setProperty('display', 'inline-block', 'important');
                } else {
                    if (maxWidth > 0) {
                        targetImg.style.setProperty('--remote-image-max-width', String(maxWidth) + 'px');
                        targetImg.style.setProperty('max-width', String(maxWidth) + 'px', 'important');
                    }
                    if (aspectWidth > 0 && aspectHeight > 0) {
                        targetImg.style.setProperty('aspect-ratio', String(aspectWidth) + ' / ' + String(aspectHeight), 'important');
                    }
                    targetImg.style.setProperty('width', '100%', 'important');
                    targetImg.style.setProperty('height', 'auto', 'important');
                    targetImg.style.setProperty('display', 'block', 'important');
                }

                if (objectFit) {
                    targetImg.style.setProperty('object-fit', objectFit, 'important');
                }
            };
            const inlineViaCanvas = (sourceImg) => {
                try {
                    if (!sourceImg || !sourceImg.complete || !sourceImg.naturalWidth || !sourceImg.naturalHeight) {
                        return null;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = sourceImg.naturalWidth;
                    canvas.height = sourceImg.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return null;
                    ctx.drawImage(sourceImg, 0, 0);
                    const dataUrl = canvas.toDataURL('image/png');
                    return dataUrl && dataUrl.startsWith('data:image/') ? dataUrl : null;
                } catch (e) {
                    return null;
                }
            };
            const collectImageSources = (sourceImg, targetImg) => {
                const candidates = [
                    sourceImg?.currentSrc,
                    sourceImg?.getAttribute('src'),
                    sourceImg?.src,
                    targetImg?.getAttribute('src'),
                    targetImg?.src
                ].filter(Boolean);
                return Array.from(new Set(candidates.map(normalizeFetchSrc).filter(Boolean)));
            };

            const results = await Promise.all(clonedImages.map(async (targetImg, index) => {
                const sourceImg = originalImages[index] || targetImg;
                stripResponsiveImageAttrs(targetImg);
                const imageKind = markImageKind(sourceImg, targetImg);
                preserveImageSizing(sourceImg, targetImg, imageKind);
                if (imageKind === 'content-image') {
                    contentImageCount += 1;
                }

                const canvasDataUrl = inlineViaCanvas(sourceImg);
                if (canvasDataUrl) {
                    targetImg.setAttribute('src', canvasDataUrl);
                    targetImg.removeAttribute('loading');
                    return true;
                }

                for (const candidate of collectImageSources(sourceImg, targetImg)) {
                    if (candidate.startsWith('data:')) {
                        targetImg.setAttribute('src', candidate);
                        targetImg.removeAttribute('loading');
                        return true;
                    }
                    if (!shouldFetchImage(candidate)) continue;
                    try {
                        const res = await fetch(candidate);
                        if (!res.ok) continue;
                        const dataUrl = await toDataUrl(await res.blob());
                        if (!dataUrl || !dataUrl.startsWith('data:image/')) continue;
                        targetImg.setAttribute('src', dataUrl);
                        targetImg.removeAttribute('loading');
                        return true;
                    } catch (e) { }
                }

                return false;
            }));

            inlinedImageCount = results.filter(Boolean).length;
        } catch (e) { }

        // Fix inline file references: Antigravity nests <div> elements inside
        // <span> and <p> tags (e.g. file-type icons). Browsers auto-close <p> and
        // <span> when they encounter a <div>, causing unwanted line breaks.
        // Solution: Convert any <div> inside an inline parent to a <span>.
        try {
            const inlineTags = new Set(['SPAN', 'P', 'A', 'LABEL', 'EM', 'STRONG', 'CODE']);
            const allDivs = Array.from(clone.querySelectorAll('div'));
            for (const div of allDivs) {
                try {
                    if (!div.parentNode) continue;
                    const parent = div.parentElement;
                    if (!parent) continue;
                    
                    const parentIsInline = inlineTags.has(parent.tagName) || 
                        (parent.className && (parent.className.includes('inline-flex') || parent.className.includes('inline-block')));
                        
                    if (parentIsInline) {
                        const span = document.createElement('span');
                        // MOVE children instead of copying (prevents orphaning nested divs)
                        while (div.firstChild) {
                            span.appendChild(div.firstChild);
                        }
                        if (div.className) span.className = div.className;
                        if (div.getAttribute('style')) span.setAttribute('style', div.getAttribute('style'));
                        span.style.display = 'inline-flex';
                        span.style.alignItems = 'center';
                        span.style.verticalAlign = 'middle';
                        div.replaceWith(span);
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        const html = clone.outerHTML;
        
        const rules = [];
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    rules.push(rule.cssText);
                }
            } catch (e) { }
        }
        const allCSS = rules.join('\n');
        
        // Extract comprehensive theme colors
        const bodyStyles = window.getComputedStyle(document.body);
        const rootStyles = window.getComputedStyle(document.documentElement);
        
        // Walk up from cascade to find the first non-transparent background
        let effectiveBg = cascadeStyles.backgroundColor;
        let el = cascade;
        while (el && (effectiveBg === 'transparent' || effectiveBg === 'rgba(0, 0, 0, 0)')) {
            el = el.parentElement;
            if (el) effectiveBg = window.getComputedStyle(el).backgroundColor;
        }
        if (effectiveBg === 'transparent' || effectiveBg === 'rgba(0, 0, 0, 0)') {
            effectiveBg = bodyStyles.backgroundColor;
        }
        
        // Extract VS Code / Antigravity theme CSS variables
        const themeVars = {};
        const varNames = [
            '--vscode-editor-background', '--vscode-editor-foreground',
            '--vscode-sideBar-background', '--vscode-panel-background',
            '--vscode-input-background', '--vscode-input-foreground',
            '--vscode-foreground', '--vscode-descriptionForeground',
            '--vscode-textLink-foreground', '--vscode-button-background',
            '--vscode-badge-background', '--vscode-badge-foreground',
            '--vscode-list-activeSelectionBackground',
            '--vscode-editorWidget-background',
            '--vscode-activityBar-background',
            '--vscode-tab-activeBackground'
        ];
        varNames.forEach(v => {
            const val = rootStyles.getPropertyValue(v).trim();
            if (val) themeVars[v] = val;
        });
        
        const isPlaceholderBlock = (el) => {
            const text = collectText(el);
            if (text) return false;
            return isSkeletonLikeElement(el) && hasMeasuredHeight(el);
        };
        const snapshotText = collectText(clone);
        const measurableBlocks = Array.from(clone.querySelectorAll('*'));
        const placeholderBlockCount = measurableBlocks.filter(isPlaceholderBlock).length;
        const blankSizedBlockCount = measurableBlocks.filter(el => {
            const text = collectText(el);
            if (text) return false;
            const styleText = el.getAttribute('style') || '';
            return /height\s*:\s*\d+(\.\d+)?px/i.test(styleText);
        }).length;
        const meaningfulTextBlockCount = measurableBlocks.filter(el => {
            const text = collectText(el);
            return text.length >= 24 && el.children.length < 12;
        }).length;
        const roleNodes = Array.from(clone.querySelectorAll('[data-role]'));
        const userRoleNodes = roleNodes.filter(node => node.getAttribute('data-role') === 'user');
        const assistantRoleNodes = roleNodes.filter(node => node.getAttribute('data-role') === 'assistant');
        const userPlaceholderCount = userRoleNodes.filter(isPlaceholderBlock).length;
        const assistantPlaceholderCount = assistantRoleNodes.filter(isPlaceholderBlock).length;
        const leadingPlaceholderCount = roleNodes.slice(0, Math.min(roleNodes.length, 3)).filter(isPlaceholderBlock).length;
        const turnCount = roleNodes.length;
        const codeBlockCount = clone.querySelectorAll('pre, code').length;
        const linkCount = clone.querySelectorAll('a[href]').length;

        return {
            html: html,
            css: allCSS,
            backgroundColor: effectiveBg,
            bodyBackgroundColor: bodyStyles.backgroundColor,
            color: cascadeStyles.color,
            bodyColor: bodyStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            themeVars: themeVars,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length,
                textLength: snapshotText.length,
                images: {
                    total: clone.querySelectorAll('img').length,
                    content: contentImageCount,
                    inlined: inlinedImageCount
                }
            },
            captureMeta: {
                textLength: snapshotText.length,
                meaningfulTextBlockCount: meaningfulTextBlockCount,
                placeholderBlockCount: placeholderBlockCount,
                blankSizedBlockCount: blankSizedBlockCount,
                userPlaceholderCount: userPlaceholderCount,
                assistantPlaceholderCount: assistantPlaceholderCount,
                leadingPlaceholderCount: leadingPlaceholderCount,
                turnCount: turnCount,
                codeBlockCount: codeBlockCount,
                linkCount: linkCount
            }
        };
    })()`;

    let bestFailure = null;
    const candidates = [];

    for (const ctx of getPreferredContexts(cdp.contexts)) {
        try {
            // console.log(`Trying context ${ctx.id} (${ctx.name || ctx.origin})...`);
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                bestFailure = {
                    error: `Context ${ctx.id} exception: ${result.exceptionDetails.text || 'Runtime evaluation failed'} ${result.exceptionDetails.exception?.description || ''}`.trim(),
                    contextId: ctx.id,
                    contextName: ctx.name || '',
                    isDefault: !!ctx?.auxData?.isDefault
                };
                continue;
            }

            if (result.result && result.result.value) {
                const val = result.result.value;
                if (val.error) {
                    bestFailure = {
                        error: val.error,
                        contextId: ctx.id,
                        contextName: ctx.name || '',
                        isDefault: !!ctx?.auxData?.isDefault,
                        debug: val.debug || null
                    };
                } else {
                    const snapshot = annotateSnapshotQuality(val, {
                        contextId: ctx.id,
                        contextName: ctx.name || '',
                        isDefault: !!ctx?.auxData?.isDefault
                    });
                    candidates.push({
                        snapshot,
                        quality: getSnapshotQuality(snapshot),
                        context: ctx
                    });
                }
            } else {
                bestFailure = {
                    error: `Context ${ctx.id} returned no value`,
                    contextId: ctx.id,
                    contextName: ctx.name || '',
                    isDefault: !!ctx?.auxData?.isDefault
                };
            }
        } catch (e) {
            bestFailure = {
                error: `Context ${ctx.id} connection error: ${e.message}`,
                contextId: ctx.id,
                contextName: ctx.name || '',
                isDefault: !!ctx?.auxData?.isDefault
            };
        }
    }

    if (candidates.length > 0) {
        candidates.sort(compareSnapshotCandidates);
        return candidates[0].snapshot;
    }

    return bestFailure || { error: 'No valid snapshot captured (check contexts)' };
}

// Inject message into Antigravity
async function injectMessage(cdp, text) {
    // Use JSON.stringify for robust escaping (handles ", \, newlines, backticks, unicode, etc.)
    const safeText = JSON.stringify(text);

    const EXPRESSION = `(async () => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        const editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        const textToInsert = ${safeText};

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
        if (!inserted) {
            editor.textContent = textToInsert;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
        if (submit && !submit.disabled) {
            submit.click();
            return { ok:true, method:"click_submit" };
        }

        // Submit button not found, but text is inserted - trigger Enter key
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));
        
        return { ok:true, method:"enter_keypress" };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Inject file into Antigravity via CDP file chooser
async function injectFile(cdp, filePath) {
    // Normalize to absolute Windows path for CDP
    const absolutePath = filePath.startsWith('/') ? filePath : join(__dirname, filePath).replace(/\\/g, '/');
    const winPath = absolutePath.replace(/\//g, '\\');

    console.log(`📂 Injecting file via CDP: ${winPath}`);

    try {
        // Step 1: Enable file chooser interception
        await cdp.call("Page.setInterceptFileChooserDialog", { enabled: true });

        // Step 2: Set up a promise to wait for the file chooser event
        const fileChooserPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cdp.ws.removeListener('message', handler);
                reject(new Error('File chooser did not open within 5s'));
            }, 5000);

            const handler = (rawMsg) => {
                try {
                    const msg = JSON.parse(rawMsg);
                    if (msg.method === 'Page.fileChooserOpened') {
                        clearTimeout(timeout);
                        cdp.ws.removeListener('message', handler);
                        resolve(msg.params);
                    }
                } catch (e) { /* ignore parse errors */ }
            };
            cdp.ws.on('message', handler);
        });

        // Step 3: Click the context/media "+" button in IDE (bottom-left, near editor)
        const clickResult = await clickContextPlusButton(cdp);
        console.log(`🖱️ Click context+ result:`, clickResult);

        if (!clickResult.success) {
            // Disable interception before returning
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e) { }
            return { success: false, error: 'Could not find context+ button in IDE', details: clickResult };
        }

        // Step 4: Wait for file chooser to open, then accept with our file
        try {
            const chooserParams = await fileChooserPromise;
            console.log(`📁 File chooser opened, mode: ${chooserParams.mode}`);

            await cdp.call("Page.handleFileChooser", {
                action: "accept",
                files: [winPath]
            });

            console.log(`✅ File injected successfully: ${winPath}`);

            // Disable interception
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e) { }

            return { success: true, method: 'file_chooser', path: winPath };
        } catch (e) {
            // File chooser didn't open - perhaps the button doesn't open file dialog
            // Try fallback: drag-and-drop via CDP Input events
            console.warn(`⚠️ File chooser approach failed: ${e.message}. Trying fallback...`);
            try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e2) { }

            // Fallback: Use DOM.setFileInputFiles if there's a file input
            return await injectFileViaInput(cdp, winPath);
        }
    } catch (e) {
        try { await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false }); } catch (e2) { }
        console.error(`❌ File injection error: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// Click the context/media "+" button in IDE (NOT the "new conversation" + button)
async function clickContextPlusButton(cdp) {
    const EXP = `(async () => {
        try {
            // Strategy 1: Look for the add-context button (usually a + or paperclip near input area)
            // In Antigravity/Windsurf, this is typically the "Add context" button at the bottom
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
            
            // Filter for plus/attach buttons near the bottom input area
            const inputArea = document.querySelector('[contenteditable="true"]');
            if (!inputArea) return { success: false, error: 'No editor found' };
            
            const inputRect = inputArea.getBoundingClientRect();
            
            // Find buttons near the input area that have plus/attach icons
            const candidates = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false;
                const rect = btn.getBoundingClientRect();
                // Must be near the input area (within 100px vertically)
                if (Math.abs(rect.top - inputRect.top) > 100 && Math.abs(rect.bottom - inputRect.bottom) > 100) return false;
                
                // Check for plus icon (lucide-plus) or attach/paperclip icon
                const svg = btn.querySelector('svg');
                if (!svg) return false;
                const cls = (svg.getAttribute('class') || '').toLowerCase();
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const title = (btn.getAttribute('title') || '').toLowerCase();
                
                return cls.includes('plus') || cls.includes('paperclip') || cls.includes('attach') ||
                       label.includes('context') || label.includes('attach') || label.includes('add') ||
                       title.includes('context') || title.includes('attach') || title.includes('add file');
            });
            
            if (candidates.length > 0) {
                candidates[0].click();
                return { success: true, method: 'context_plus_button', count: candidates.length };
            }
            
            // Strategy 2: Look for any file input type and click its label/trigger
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
            if (fileInputs.length > 0) {
                fileInputs[0].click();
                return { success: true, method: 'file_input_direct' };
            }
            
            // Strategy 3: Find buttons with data-tooltip containing "context" or "attach"
            const tooltipBtn = allButtons.find(btn => {
                const tooltipId = btn.getAttribute('data-tooltip-id') || '';
                return tooltipId.includes('context') || tooltipId.includes('attach') || tooltipId.includes('media');
            });
            
            if (tooltipBtn) {
                tooltipBtn.click();
                return { success: true, method: 'tooltip_button' };
            }

            return { success: false, error: 'No context/attach button found' };
        } catch (e) {
            return { success: false, error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { success: false, error: 'No matching context' };
}

// Fallback: inject file via DOM file input
async function injectFileViaInput(cdp, filePath) {
    const EXP = `(() => {
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        if (fileInputs.length === 0) return { found: false };
        return { found: true, count: fileInputs.length };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });

            if (res.result?.value?.found) {
                // Use DOM.setFileInputFiles to set files on the input
                // First get the document
                const doc = await cdp.call("DOM.getDocument", { depth: 0 });
                const nodeResult = await cdp.call("DOM.querySelector", {
                    nodeId: doc.root.nodeId,
                    selector: 'input[type="file"]'
                });

                if (nodeResult.nodeId) {
                    await cdp.call("DOM.setFileInputFiles", {
                        files: [filePath],
                        nodeId: nodeResult.nodeId
                    });
                    return { success: true, method: 'dom_set_file_input' };
                }
            }
        } catch (e) {
            console.warn(`DOM file input fallback failed in context ${ctx.id}:`, e.message);
        }
    }
    return { success: false, error: 'No file input found in IDE' };
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode) {
    if (!['Fast', 'Planning'].includes(mode)) return { error: 'Invalid mode' };

    const EXP = `(async () => {
        try {
            // STRATEGY: Find the element that IS the current mode indicator.
            // It will have text 'Fast' or 'Planning'.
            // It might not be a <button>, could be a <div> with cursor-pointer.
            
            // 1. Get all elements with text 'Fast' or 'Planning'
            const allEls = Array.from(document.querySelectorAll('*'));
            const candidates = allEls.filter(el => {
                // Must have single text node child to avoid parents
                if (el.children.length > 0) return false;
                const txt = el.textContent.trim();
                return txt === 'Fast' || txt === 'Planning';
            });

            // 2. Find the one that looks interactive (cursor-pointer)
            // Traverse up from text node to find clickable container
            let modeBtn = null;
            
            for (const el of candidates) {
                let current = el;
                // Go up max 4 levels
                for (let i = 0; i < 4; i++) {
                    if (!current) break;
                    const style = window.getComputedStyle(current);
                    if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                        modeBtn = current;
                        break;
                    }
                    current = current.parentElement;
                }
                if (modeBtn) break;
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if (modeBtn.innerText.includes('${mode}')) return { success: true, alreadySet: true };

            // 3. Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // 4. Find the dialog
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                                    .find(d => d.offsetHeight > 0 && d.innerText.includes('${mode}'));
            
            // Fallback: Just look for any new visible container if role=dialog is missing
            if (!visibleDialog) {
                // Maybe it's not role=dialog? Look for a popover-like div
                 visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText.includes('${mode}') &&
                               !d.innerText.includes('Files With Changes'); // Anti-context menu
                    });
            }

            if (!visibleDialog) return { error: 'Dropdown not opened or options not visible' };

            // 5. Click the option
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const target = allDialogEls.find(el => 
                el.children.length === 0 && el.textContent.trim() === '${mode}'
            );

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }
            
            return { error: 'Mode option text not found in dialog. Dialog text: ' + visibleDialog.innerText.substring(0, 50) };

        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Stop Generation
async function stopGeneration(cdp) {
    const EXP = `(async () => {
        // Look for the cancel button
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true, method: 'fallback_square' };
        }

        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const safeText = JSON.stringify(textContent || '');

    const EXP = `(async () => {
        try {
            // Priority: Search inside the chat container first for better accuracy
            const root = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade') || document;
            
            // Strategy: Find all elements matching the selector
            let elements = Array.from(root.querySelectorAll('${selector}'));
            
            const filterText = ${safeText};
            if (filterText) {
                elements = elements.filter(el => {
                    const txt = (el.innerText || el.textContent || '').trim();
                    const firstLine = txt.split('\\n')[0].trim();
                    // Match if first line matches (thought blocks) or if it contains the label (buttons)
                    return firstLine === filterText || txt.includes(filterText);
                });
                
                // CRITICAL: If elements are nested (e.g. <div><span>Text</span></div>), 
                // both will match. We only want the most specific (inner-most) one.
                elements = elements.filter(el => {
                    return !elements.some(other => other !== el && el.contains(other));
                });
            }

            const target = elements[${index}];

            if (target) {
                // Focus and Click
                if (target.focus) target.focus();
                target.click();
                return { success: true, found: elements.length, indexUsed: ${index} };
            }
            
            return { error: 'Element not found at index ' + ${index} + ' among ' + elements.length + ' matches' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
            // If we found it but click didn't return success (unlikely with this script), continue to next context
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts or element not found at index' };
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    // Try to scroll the chat container in Antigravity
    const EXPRESSION = `(async () => {
        try {
            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                // Fallback: scroll the main container element
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling for better sync
            if (${scrollPercent} !== undefined) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * ${scrollPercent};
            } else {
                target.scrollTop = ${scrollTop || 0};
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

// Set AI Model
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            let modelBtn = null;
            
            // Strategy 1: Look for data-tooltip-id patterns (most reliable)
            modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            // Priority 1: Exact selector from user (data-tooltip-id="new-conversation-tooltip")
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true, method: 'data-tooltip-id' };
            }

            // Fallback: Use previous heuristics
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            
            // Find all buttons with plus icons
            const plusButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false; // Skip hidden
                const hasPlusIcon = btn.querySelector('svg.lucide-plus') || 
                                   btn.querySelector('svg.lucide-square-plus') ||
                                   btn.querySelector('svg[class*="plus"]');
                return hasPlusIcon;
            });
            
            // Filter only top buttons (toolbar area)
            const topPlusButtons = plusButtons.filter(btn => {
                const rect = btn.getBoundingClientRect();
                return rect.top < 200;
            });

            if (topPlusButtons.length > 0) {
                 topPlusButtons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                 topPlusButtons[0].click();
                 return { success: true, method: 'filtered_top_plus', count: topPlusButtons.length };
            }
            
            // Fallback: aria-label
             const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                return (ariaLabel.includes('new') || title.includes('new')) && btn.offsetParent !== null;
            });
            
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true, method: 'aria_label_new' };
            }
            
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}
// Get Chat History - Click history button and scrape conversations
async function getChatHistory(cdp, options = {}) {
    const keepOpen = options.keepOpen === true;
    const EXP = `(async () => {
        const KEEP_OPEN = ${keepOpen ? 'true' : 'false'};
        let historyOpened = false;

        const closeHistoryPanel = async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            await new Promise(r => setTimeout(r, 150));
        };

        try {
            const chats = [];
            const seenTitles = new Set();

            // Priority 1: Look for tooltip ID pattern (history/past/recent)
            let historyBtn = document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"], [data-tooltip-id*="conversation-history"]');
            
            // Priority 2: Look for button ADJACENT to the new chat button
            if (!historyBtn) {
                const newChatBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
                if (newChatBtn) {
                    const parent = newChatBtn.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(el => el !== newChatBtn);
                        historyBtn = siblings.find(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
                    }
                }
            }

            // Fallback: Use previous heuristics (icon/aria-label)
            if (!historyBtn) {
                const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a[data-tooltip-id]'));
                for (const btn of allButtons) {
                    if (btn.offsetParent === null) continue;
                    const hasHistoryIcon = btn.querySelector('svg.lucide-clock') ||
                                           btn.querySelector('svg.lucide-history') ||
                                           btn.querySelector('svg.lucide-folder') ||
                                           btn.querySelector('svg[class*="clock"]') ||
                                           btn.querySelector('svg[class*="history"]');
                    if (hasHistoryIcon) {
                        historyBtn = btn;
                        break;
                    }
                }
            }
            
            if (!historyBtn) {
                return { error: 'History button not found', chats: [] };
            }

            // Click and Wait
            historyBtn.click();
            historyOpened = true;
            await new Promise(r => setTimeout(r, 2000));
            
            // Find the side panel
            let panel = null;
            let inputsFoundDebug = [];
            
            // Strategy 1: The search input has specific placeholder
            let searchInput = null;
            const inputs = Array.from(document.querySelectorAll('input'));
            searchInput = inputs.find(i => {
                const ph = (i.placeholder || '').toLowerCase();
                return ph.includes('select') || ph.includes('conversation');
            });
            
            // Strategy 2: Look for any text input that looks like a search bar (based on user snippet classes)
            if (!searchInput) {
                const allInputs = Array.from(document.querySelectorAll('input[type="text"]'));
                inputsFoundDebug = allInputs.map(i => 'ph:' + i.placeholder + ', cls:' + i.className);
                
                searchInput = allInputs.find(i => 
                    i.offsetParent !== null && 
                    (i.className.includes('w-full') || i.classList.contains('w-full'))
                );
            }
            
            // Strategy 3: Find known text in the panel (Anchor Text Strategy)
            let anchorElement = null;
            if (!searchInput) {
                 const allSpans = Array.from(document.querySelectorAll('span, div, p'));
                 anchorElement = allSpans.find(s => {
                     const t = (s.innerText || '').trim();
                     return t === 'Current' || t === 'Refining Chat History Scraper'; // specific known title
                 });
            }

            const startElement = searchInput || anchorElement;

            if (startElement) {
                // Walk up to find the panel container
                let container = startElement;
                for (let i = 0; i < 15; i++) { 
                    if (!container.parentElement) break;
                    container = container.parentElement;
                    const rect = container.getBoundingClientRect();
                    
                    // Panel should have good dimensions
                    // Relaxed constraints for mobile
                    if (rect.width > 50 && rect.height > 100) {
                        panel = container;
                        
                        // If it looks like a modal/popover (fixed or absolute pos), that's definitely it
                        const style = window.getComputedStyle(container);
                        if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 10) {
                            break;
                        }
                    }
                }
                
                // Fallback if loop finishes without specific break
                if (!panel && startElement) {
                     // Just go up 4 levels
                     let p = startElement;
                     for(let k=0; k<4; k++) { if(p.parentElement) p = p.parentElement; }
                     panel = p;
                }
            }
            
            const debugInfo = { 
                panelFound: !!panel, 
                panelWidth: panel?.offsetWidth || 0,
                inputFound: !!searchInput,
                anchorFound: !!anchorElement,
                inputsDebug: inputsFoundDebug.slice(0, 5)
            };
            
            if (panel) {
                // Chat titles are in <span> elements
                const spans = Array.from(panel.querySelectorAll('span'));
                
                // Section headers to skip
                const SKIP_EXACT = new Set([
                    'current', 'other conversations', 'now'
                ]);
                
                for (const span of spans) {
                    const text = span.textContent?.trim() || '';
                    const lower = text.toLowerCase();
                    
                    // Skip empty or too short
                    if (text.length < 3) continue;
                    
                    // Skip section headers
                    if (SKIP_EXACT.has(lower)) continue;
                    if (lower.startsWith('recent in ')) continue;
                    if (lower.startsWith('show ') && lower.includes('more')) continue;
                    
                    // Skip timestamps
                    if (lower.endsWith(' ago') || /^\\d+\\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
                    
                    // Skip very long text (containers)
                    if (text.length > 100) continue;
                    
                    // Skip duplicates
                    if (seenTitles.has(text)) continue;
                    
                    seenTitles.add(text);
                    chats.push({ title: text, date: 'Recent' });
                    
                    if (chats.length >= 50) break;
                }
            }
            
            return { success: true, chats: chats, debug: debugInfo };
        } catch(e) {
            return { error: e.toString(), chats: [] };
        } finally {
            if (historyOpened && !KEEP_OPEN) {
                try {
                    await closeHistoryPanel();
                } catch (closeErr) { }
            }
        }
    })()`;

    let lastError = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
            // If result.value is null/undefined but no error thrown, check exceptionDetails
            if (res.exceptionDetails) {
                lastError = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
            }
        } catch (e) {
            lastError = e.message;
        }
    }
    return { error: 'Context failed: ' + (lastError || 'No contexts available'), chats: [] };
}

async function selectChat(cdp, chatTitle) {
    const safeChatTitle = JSON.stringify(chatTitle);

    const EXP = `(async () => {
    try {
        const targetTitle = ${safeChatTitle};
        const normalizeTitle = (value) => String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
        const levenshtein = (a, b) => {
            const rows = a.length + 1;
            const cols = b.length + 1;
            const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
            for (let i = 0; i < rows; i++) dp[i][0] = i;
            for (let j = 0; j < cols; j++) dp[0][j] = j;
            for (let i = 1; i < rows; i++) {
                for (let j = 1; j < cols; j++) {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    dp[i][j] = Math.min(
                        dp[i - 1][j] + 1,
                        dp[i][j - 1] + 1,
                        dp[i - 1][j - 1] + cost
                    );
                }
            }
            return dp[a.length][b.length];
        };
        const getSimilarity = (candidate, target) => {
            const normalizedCandidate = normalizeTitle(candidate);
            const normalizedTarget = normalizeTitle(target);
            if (!normalizedCandidate || !normalizedTarget) return 0;
            if (normalizedCandidate === normalizedTarget) return 1;
            if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) {
                return Math.min(normalizedCandidate.length, normalizedTarget.length) / Math.max(normalizedCandidate.length, normalizedTarget.length);
            }
            const distance = levenshtein(normalizedCandidate, normalizedTarget);
            return 1 - (distance / Math.max(normalizedCandidate.length, normalizedTarget.length));
        };
        const getDepth = (el) => {
            let depth = 0;
            let current = el;
            while (current) {
                depth++;
                current = current.parentElement;
            }
            return depth;
        };
        const findClickable = (el) => {
            let current = el;
            for (let i = 0; i < 6 && current; i++) {
                const style = window.getComputedStyle(current);
                if (
                    current.tagName === 'BUTTON' ||
                    current.getAttribute('role') === 'button' ||
                    style.cursor === 'pointer' ||
                    current.classList?.contains('cursor-pointer')
                ) {
                    return current;
                }
                current = current.parentElement;
            }
            return el;
        };

        // Open the same history panel that getChatHistory() scrapes from.
        let historyBtn = document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"], [data-tooltip-id*="conversation-history"]');
        if (!historyBtn) {
            const newChatBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (newChatBtn?.parentElement) {
                const siblings = Array.from(newChatBtn.parentElement.children).filter(el => el !== newChatBtn);
                historyBtn = siblings.find(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') || null;
            }
        }
        if (!historyBtn) {
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a[data-tooltip-id]'));
            historyBtn = allButtons.find(btn =>
                btn.offsetParent !== null &&
                (
                    btn.querySelector('svg.lucide-clock') ||
                    btn.querySelector('svg.lucide-history') ||
                    btn.querySelector('svg.lucide-folder') ||
                    btn.querySelector('svg.lucide-clock-rotate-left') ||
                    btn.querySelector('svg[class*="clock"]') ||
                    btn.querySelector('svg[class*="history"]')
                )
            ) || null;
        }

        if (historyBtn) {
            historyBtn.click();
            await new Promise(r => setTimeout(r, 1200));
        }

        let panel = null;
        let searchInput = null;
        const inputs = Array.from(document.querySelectorAll('input'));
        searchInput = inputs.find(i => {
            const ph = (i.placeholder || '').toLowerCase();
            return ph.includes('select') || ph.includes('conversation');
        });
        if (!searchInput) {
            const allInputs = Array.from(document.querySelectorAll('input[type="text"]'));
            searchInput = allInputs.find(i =>
                i.offsetParent !== null &&
                (i.className.includes('w-full') || i.classList.contains('w-full'))
            ) || null;
        }
        let anchorElement = null;
        if (!searchInput) {
            const allSpans = Array.from(document.querySelectorAll('span, div, p'));
            anchorElement = allSpans.find(s => {
                const text = (s.innerText || '').trim();
                return text === 'Current' || text.startsWith('Recent in ');
            }) || null;
        }
        const startElement = searchInput || anchorElement;
        if (startElement) {
            let container = startElement;
            for (let i = 0; i < 15; i++) {
                if (!container.parentElement) break;
                container = container.parentElement;
                const rect = container.getBoundingClientRect();
                if (rect.width > 50 && rect.height > 100) {
                    panel = container;
                    const style = window.getComputedStyle(container);
                    if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 10) {
                        break;
                    }
                }
            }
        }
        if (!panel) {
            panel = document.body;
        }

        const allElements = Array.from(panel.querySelectorAll('span, div, p')).filter(el => {
            if (el.offsetParent === null) return false;
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            return text && text.length >= 3 && text.length <= Math.max(targetTitle.length + 40, 140);
        });

        const ranked = allElements.map(el => {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            return {
                el,
                text,
                score: getSimilarity(text, targetTitle),
                depth: getDepth(el)
            };
        }).filter(candidate => candidate.score >= 0.72);

        ranked.sort((a, b) =>
            b.score - a.score ||
            a.text.length - b.text.length ||
            b.depth - a.depth
        );

        const best = ranked[0] || null;
        if (best) {
            const clickable = findClickable(best.el);
            if (clickable?.scrollIntoView) {
                clickable.scrollIntoView({ block: 'center' });
                await new Promise(r => setTimeout(r, 120));
            }
            if (clickable) {
                clickable.click();
                return { success: true, method: 'fuzzy_click', matchedText: best.text, score: best.score };
            }
        }

        return { error: 'Chat not found: ' + targetTitle, candidates: ranked.slice(0, 5).map(item => ({ text: item.text, score: item.score })) };
    } catch (e) {
        return { error: e.toString() };
    }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Close History Panel (Escape)
async function closeHistory(cdp) {
    const EXP = `(async () => {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            return { success: true };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to close history panel' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const chatContainer = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
    const hasMessages = chatContainer && chatContainer.querySelectorAll('[class*="message"], [data-message]').length > 0;
    return {
        hasChat: !!chatContainer,
        hasMessages: hasMessages,
        editorFound: !!(chatContainer && chatContainer.querySelector('[data-lexical-editor="true"]'))
    };
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { hasChat: false, hasMessages: false, editorFound: false };
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Unknown', model: 'Unknown' };

        // 1. Get Mode (Fast/Planning)
        // Strategy: Find the clickable mode button which contains either "Fast" or "Planning"
        // It's usually a button or div with cursor:pointer containing the mode text
        const allEls = Array.from(document.querySelectorAll('*'));

        // Find elements that are likely mode buttons
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const text = (el.innerText || '').trim();
            if (text !== 'Fast' && text !== 'Planning') continue;

            // Check if this or a parent is clickable (the actual mode selector)
            let current = el;
            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const style = window.getComputedStyle(current);
                if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                    state.mode = text;
                    break;
                }
                current = current.parentElement;
            }
            if (state.mode !== 'Unknown') break;
        }

        // Fallback: Just look for visible text
        if (state.mode === 'Unknown') {
            const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
            if (textNodes.some(el => el.innerText.trim() === 'Planning')) state.mode = 'Planning';
            else if (textNodes.some(el => el.innerText.trim() === 'Fast')) state.mode = 'Fast';
        }

        // 2. Get Model
        // Strategy: Look for leaf text nodes containing a known model keyword
        // BUT exclude status bar items (which contain "%" or "|" or "MB")
        const KNOWN_MODELS = ["Gemini", "Claude", "GPT"];
        const textNodes2 = allEls.filter(el => el.children.length === 0 && el.innerText);
        
        // Helper: check if text looks like a real model name (not a status bar snippet)
        function isModelName(txt) {
            if (!KNOWN_MODELS.some(k => txt.includes(k))) return false;
            // Reject status bar patterns: "Claude 80%", "Flash 100% | Pro 100% | Claude 80%"
            if (txt.includes('%') || txt.includes('|') || txt.includes('MB')) return false;
            // Must look like a model name: "Claude Opus 4.6 (Thinking)", "Gemini 3.1 Pro (High)" etc.
            // At minimum: keyword + version or qualifier
            if (txt.length < 8 || txt.length > 60) return false;
            return true;
        }
        
        // First try: find inside a clickable parent (button, cursor:pointer)
        let modelEl = textNodes2.find(el => {
            const txt = el.innerText.trim();
            if (!isModelName(txt)) return false;
            // Must be in a clickable context (header/toolbar, not chat content)
            let parent = el;
            for (let i = 0; i < 8; i++) {
                if (!parent) break;
                if (parent.tagName === 'BUTTON' || window.getComputedStyle(parent).cursor === 'pointer') return true;
                parent = parent.parentElement;
            }
            return false;
        });
        
        // Fallback: any leaf node with a known model name
        if (!modelEl) {
            modelEl = textNodes2.find(el => {
                const txt = el.innerText.trim();
                return isModelName(txt);
            });
        }

        if (modelEl) {
            state.model = modelEl.innerText.trim();
        }

        // 3. Detect if agent is currently running (generating)
        // Check for cancel/stop button visibility
        const cancelBtn = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        const stopIcon = document.querySelector('button svg.lucide-square')?.closest('button');
        state.isRunning = (cancelBtn && cancelBtn.offsetParent !== null) || 
                          (stopIcon && stopIcon.offsetParent !== null) || false;

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

function getSnapshotQuality(snapshot) {
    const meta = snapshot?.captureMeta || {};
    const textLength = meta.textLength || snapshot?.stats?.textLength || 0;
    const meaningfulTextBlockCount = meta.meaningfulTextBlockCount || 0;
    const placeholderBlockCount = meta.placeholderBlockCount || 0;
    const blankSizedBlockCount = meta.blankSizedBlockCount || 0;
    const userPlaceholderCount = meta.userPlaceholderCount || 0;
    const assistantPlaceholderCount = meta.assistantPlaceholderCount || 0;
    const leadingPlaceholderCount = meta.leadingPlaceholderCount || 0;
    const turnCount = meta.turnCount || 0;
    const codeBlockCount = meta.codeBlockCount || 0;
    const linkCount = meta.linkCount || 0;
    const contentImageCount = snapshot?.stats?.images?.content || 0;
    const hasMeaningfulContent =
        textLength >= SNAPSHOT_READY_TEXT_THRESHOLD ||
        meaningfulTextBlockCount >= 2 ||
        codeBlockCount > 0 ||
        contentImageCount > 0 ||
        linkCount >= 2;
    const isPlaceholderOnly =
        placeholderBlockCount >= 2 &&
        textLength <= SNAPSHOT_PLACEHOLDER_TEXT_MAX &&
        meaningfulTextBlockCount === 0 &&
        codeBlockCount === 0 &&
        contentImageCount === 0 &&
        linkCount === 0;
    const hasCriticalPlaceholders = userPlaceholderCount > 0 || leadingPlaceholderCount > 0;
    const isReady =
        !snapshot?.error &&
        !isPlaceholderOnly &&
        !hasCriticalPlaceholders &&
        (hasMeaningfulContent || turnCount > 0 || textLength > 0 || placeholderBlockCount === 0);
    const score =
        textLength +
        (meaningfulTextBlockCount * 220) +
        (codeBlockCount * 160) +
        (contentImageCount * 200) +
        (linkCount * 40) +
        (turnCount * 15) -
        (userPlaceholderCount * 2200) -
        (leadingPlaceholderCount * 1800) -
        (assistantPlaceholderCount * 900) -
        (placeholderBlockCount * 360) -
        (blankSizedBlockCount * 20);

    return {
        textLength,
        meaningfulTextBlockCount,
        placeholderBlockCount,
        blankSizedBlockCount,
        userPlaceholderCount,
        assistantPlaceholderCount,
        leadingPlaceholderCount,
        turnCount,
        codeBlockCount,
        linkCount,
        contentImageCount,
        hasMeaningfulContent,
        hasCriticalPlaceholders,
        isPlaceholderOnly,
        isReady,
        score
    };
}

function annotateSnapshotQuality(snapshot, extraMeta = {}) {
    if (!snapshot || snapshot.error) return snapshot;
    const quality = getSnapshotQuality(snapshot);
    snapshot.captureMeta = {
        ...(snapshot.captureMeta || {}),
        ...quality,
        ...extraMeta
    };
    return snapshot;
}

function compareSnapshotQuality(a, b) {
    if (!b) return 1;
    return (
        (Number(a.isReady) - Number(b.isReady)) ||
        (Number(!a.isPlaceholderOnly) - Number(!b.isPlaceholderOnly)) ||
        (a.score - b.score) ||
        (a.textLength - b.textLength)
    );
}

function compareSnapshotCandidates(a, b) {
    return (
        compareSnapshotQuality(b.quality, a.quality) ||
        (Number(b.context?.auxData?.isDefault) - Number(a.context?.auxData?.isDefault)) ||
        ((a.context?.id || 0) - (b.context?.id || 0))
    );
}

function shouldReplaceSnapshot(existingSnapshot, nextSnapshot) {
    if (!existingSnapshot || existingSnapshot.error) {
        return true;
    }

    const current = getSnapshotQuality(existingSnapshot);
    const next = getSnapshotQuality(nextSnapshot);

    if (!next.isReady && current.isReady) {
        return false;
    }

    const placeholderRegression =
        next.userPlaceholderCount > current.userPlaceholderCount ||
        next.leadingPlaceholderCount > current.leadingPlaceholderCount ||
        next.hasCriticalPlaceholders;
    const majorTextDrop =
        current.textLength >= SNAPSHOT_READY_TEXT_THRESHOLD &&
        next.textLength < Math.max(current.textLength * 0.72, SNAPSHOT_READY_TEXT_THRESHOLD);
    const majorScoreDrop = next.score + 1200 < current.score;

    if (placeholderRegression && (current.isReady || majorTextDrop || majorScoreDrop)) {
        return false;
    }

    return true;
}

function publishSnapshot(snapshot, wss) {
    const preparedSnapshot = annotateSnapshotQuality(snapshot);
    if (!preparedSnapshot || preparedSnapshot.error) {
        return { changed: false, hash: null };
    }
    const quality = getSnapshotQuality(preparedSnapshot);

    if (!quality.isReady) {
        return { changed: false, hash: lastSnapshotHash, skipped: true, reason: 'not_ready' };
    }

    if (!shouldReplaceSnapshot(lastSnapshot, preparedSnapshot)) {
        return { changed: false, hash: lastSnapshotHash, skipped: true };
    }

    const hash = hashString(preparedSnapshot.html);
    const changed = hash !== lastSnapshotHash;
    lastSnapshot = preparedSnapshot;
    lastSnapshotHash = hash;

    if (changed && wss) {
        const wsNotify = JSON.stringify({
            type: 'snapshot_update',
            hash
        });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try { client.send(wsNotify); } catch (e) { }
            }
        });
    }

    return { changed, hash };
}

async function warmSnapshotCache(wss, options = {}) {
    const {
        timeoutMs = SNAPSHOT_REQUEST_WAIT_MS,
        force = false,
        minAttempts = 1
    } = options;

    if (!cdpConnection || cdpConnection.ws?.readyState !== WebSocket.OPEN) {
        return lastSnapshot;
    }

    if (!force && lastSnapshot) {
        const cachedQuality = getSnapshotQuality(lastSnapshot);
        if (cachedQuality.isReady) {
            return lastSnapshot;
        }
    }

    if (snapshotWarmupPromise) {
        return snapshotWarmupPromise;
    }

    snapshotWarmupPromise = (async () => {
        const totalAttempts = Math.max(
            minAttempts,
            timeoutMs > 0 ? Math.ceil(timeoutMs / SNAPSHOT_WARMUP_DELAY_MS) + 1 : 1
        );
        let bestCandidate = lastSnapshot;
        let bestQuality = bestCandidate ? getSnapshotQuality(bestCandidate) : null;

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const snapshot = await captureSnapshot(cdpConnection);

            if (snapshot && !snapshot.error) {
                const quality = getSnapshotQuality(snapshot);
                if (!bestQuality || compareSnapshotQuality(quality, bestQuality) > 0) {
                    bestCandidate = snapshot;
                    bestQuality = quality;
                }

                if (quality.isReady) {
                    snapshotWarmupStreak = 0;
                    const publishResult = publishSnapshot(snapshot, wss);
                    if (!publishResult.skipped) {
                        return snapshot;
                    }
                }
            }

            if (attempt < totalAttempts - 1) {
                await sleep(SNAPSHOT_WARMUP_DELAY_MS);
            }
        }

        if (bestCandidate && bestCandidate !== lastSnapshot && getSnapshotQuality(bestCandidate).isReady) {
            const publishResult = publishSnapshot(bestCandidate, wss);
            if (!publishResult.skipped) {
                return bestCandidate;
            }
        }

        return lastSnapshot && getSnapshotQuality(lastSnapshot).isReady ? lastSnapshot : null;
    })().finally(() => {
        snapshotWarmupPromise = null;
    });

    return snapshotWarmupPromise;
}

// Check if a request is from the same Wi-Fi (internal network)
function isLocalRequest(req) {
    // 1. Check for proxy headers (Cloudflare, ngrok, etc.)
    // If these exist, the request is coming via an external tunnel/proxy
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    // 2. Check the remote IP address
    const ip = req.ip || req.socket.remoteAddress || '';

    // Standard local/private IPv4 and IPv6 ranges
    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

// Initialize CDP connection
async function initCDP() {
    console.log('🔍 Discovering Antigravity CDP endpoint...');
    const cdpInfo = await discoverCDP();
    console.log(`✅ Found Antigravity on port ${cdpInfo.port} `);

    console.log('🔌 Connecting to CDP...');
    cdpConnection = await connectCDP(cdpInfo.url, cdpInfo);
    console.log(`🎯 Using target: ${cdpInfo.label}`);
    console.log(`✅ Connected! Found ${cdpConnection.contexts.length} execution contexts\n`);
}

// Background polling
async function startPolling(wss) {
    let lastErrorLog = 0;
    let isConnecting = false;

    const poll = async () => {
        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('🔍 Looking for Antigravity CDP connection...');
                isConnecting = true;
            }
            if (cdpConnection) {
                // Was connected, now lost
                console.log('🔄 CDP connection lost. Attempting to reconnect...');
                cdpConnection = null;
            }
            try {
                await initCDP();
                if (cdpConnection) {
                    console.log('✅ CDP Connection established from polling loop');
                    isConnecting = false;
                    void warmSnapshotCache(wss, {
                        timeoutMs: SNAPSHOT_REQUEST_WAIT_MS,
                        force: true,
                        minAttempts: 2
                    }).catch((error) => {
                        console.warn(`Snapshot warm-up after connect failed: ${error.message}`);
                    });
                }
            } catch (err) {
                // Not found yet, just wait for next cycle
            }
            setTimeout(poll, 2000); // Try again in 2 seconds if not found
            return;
        }

        try {
            let snapshot = await captureSnapshot(cdpConnection);
            if (snapshot && !snapshot.error) {
                const quality = getSnapshotQuality(snapshot);

                if (quality.isReady) {
                    snapshotFailureStreak = 0;
                    snapshotWarmupStreak = 0;
                    const { changed, hash } = publishSnapshot(snapshot, wss);
                    if (changed) {
                        console.log(`ðŸ“¸ Snapshot updated(hash: ${hash})`);
                    }
                    setTimeout(poll, POLL_INTERVAL);
                    return;
                }

                snapshotWarmupStreak += 1;
                const now = Date.now();
                const cachedQuality = lastSnapshot ? getSnapshotQuality(lastSnapshot) : null;

                if ((!cachedQuality || cachedQuality.isPlaceholderOnly) && !snapshotWarmupPromise) {
                    void warmSnapshotCache(wss, {
                        timeoutMs: SNAPSHOT_REQUEST_WAIT_MS,
                        force: true,
                        minAttempts: 2
                    }).catch((error) => {
                        console.warn(`Snapshot warm-up retry failed: ${error.message}`);
                    });
                }

                if (!lastErrorLog || now - lastErrorLog > 5000) {
                    console.log(
                        `â³ Snapshot warming up (text=${quality.textLength}, blocks=${quality.meaningfulTextBlockCount}, placeholders=${quality.placeholderBlockCount})`
                    );
                    lastErrorLog = now;
                }

                setTimeout(poll, POLL_INTERVAL);
                return;
            }
            if (snapshot?.error) {
                snapshotFailureStreak += 1;
                const errorMsg = snapshot.error || 'No valid snapshot captured (check contexts)';
                const shouldRecover =
                    cdpConnection?.ws?.readyState === WebSocket.OPEN &&
                    cdpConnection.contexts.length > 0 &&
                    snapshotFailureStreak >= 3 &&
                    (
                        !errorMsg.includes('chat container not found') ||
                        shouldRetryChatContainerRecovery(cdpConnection)
                    );

                if (shouldRecover) {
                    const recoveredSnapshot = await recoverSnapshotConnection();
                    if (recoveredSnapshot && !recoveredSnapshot.error) {
                        snapshotFailureStreak = 0;
                        snapshot = recoveredSnapshot;
                    } else if (recoveredSnapshot?.error) {
                        snapshot = recoveredSnapshot;
                    }
                }
            }
            if (snapshot && !snapshot.error) {
                snapshotFailureStreak = 0;
                const { changed, hash } = publishSnapshot(snapshot, wss);

                // Only update if content changed
                if (changed) {
                    console.log(`📸 Snapshot updated(hash: ${hash})`);
                }
            } else {
                // Snapshot is null or has error
                const now = Date.now();
                const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';

                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    console.warn(`⚠️  Snapshot capture issue: ${errorMsg} `);
                    if (snapshot?.debug) {
                        console.warn(`   Debug: ${JSON.stringify(snapshot.debug)}`);
                    }
                    if (errorMsg.includes('container not found')) {
                        if (cdpConnection?.targetInfo?.kind === 'launchpad') {
                            console.log('   (Tip: Launchpad target detected. Waiting for the main Antigravity workspace target.)');
                        } else {
                            console.log('   (Tip: Ensure an active chat is open in Antigravity)');
                        }
                    }
                    if (cdpConnection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Antigravity window)');
                    }
                    if (isRecoveringSnapshotConnection) {
                        console.warn(`   Snapshot recovery in progress after ${snapshotFailureStreak} consecutive capture failures`);
                    }
                    lastErrorLog = now;
                }
            }
        } catch (err) {
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, POLL_INTERVAL);
    };

    poll();
}

// Create Express app
async function createServer() {
    const app = express();

    // Check for SSL certificates
    const keyPath = join(RUNTIME_ROOT, 'certs', 'server.key');
    const certPath = join(RUNTIME_ROOT, 'certs', 'server.cert');
    const certsExist = ensureRuntimeSslCertificates(keyPath, certPath);
    const primaryUsesHttps = certsExist && !IS_EMBEDDED_RUNTIME;
    const phoneUsesHttps = certsExist;
    const phoneHttpsPort = primaryUsesHttps ? SERVER_PORT : EMBEDDED_HTTPS_PORT;
    const phoneProtocol = phoneUsesHttps ? 'https' : 'http';
    const phonePort = phoneUsesHttps ? phoneHttpsPort : SERVER_PORT;
    const webProtocol = primaryUsesHttps ? 'https' : 'http';
    const explicitPublicBaseUrl = PUBLIC_BASE_URL;
    const autoPublicTunnelEnabled = !explicitPublicBaseUrl && process.env.AG_AUTO_PUBLIC_TUNNEL !== '0';
    const quickTunnelOriginUrl = `${primaryUsesHttps ? 'https' : 'http'}://127.0.0.1:${SERVER_PORT}`;
    const cloudflaredHome = join(RUNTIME_ROOT, '.cloudflared-quick-tunnel-home');
    let cachedPublicBaseUrl = explicitPublicBaseUrl;
    let cachedPublicAccessSource = explicitPublicBaseUrl ? 'configured' : null;
    let publicTunnelProcess = null;
    let publicTunnelPromise = null;
    let publicTunnelError = null;
    let publicTunnelLastFailureAt = 0;

    const resetPublicTunnelState = (options = {}) => {
        if (!explicitPublicBaseUrl) {
            cachedPublicBaseUrl = null;
            cachedPublicAccessSource = null;
        }

        publicTunnelPromise = null;
        if (options.clearError) {
            publicTunnelError = null;
            publicTunnelLastFailureAt = 0;
        }
    };

    const stopPublicTunnel = () => {
        if (!publicTunnelProcess) return;
        try {
            publicTunnelProcess.kill();
        } catch (error) { }
        publicTunnelProcess = null;
    };

    const extractPublicUrl = (text) => {
        const sanitizedText = String(text || '').replace(/\u001b\[[0-9;]*m/g, ' ');
        const matches = sanitizedText.match(/https?:\/\/[^\s"'`]+/gi) || [];

        for (const rawMatch of matches) {
            const candidate = rawMatch.replace(/[),.;]+$/g, '');
            try {
                const url = new URL(candidate);
                if (['http:', 'https:'].includes(url.protocol)) {
                    return url.origin;
                }
            } catch (error) { }
        }

        return null;
    };

    const ensureAutoPublicBaseUrl = async () => {
        if (!autoPublicTunnelEnabled) {
            return null;
        }

        if (cachedPublicBaseUrl && cachedPublicAccessSource === 'cloudflare-quick-tunnel' && publicTunnelProcess && !publicTunnelProcess.killed && publicTunnelProcess.exitCode == null) {
            return cachedPublicBaseUrl;
        }

        if (publicTunnelPromise) {
            return publicTunnelPromise;
        }

        if (publicTunnelLastFailureAt && (Date.now() - publicTunnelLastFailureAt) < 15000) {
            return null;
        }

        publicTunnelPromise = new Promise((resolve) => {
            let settled = false;
            const finish = (url, errorMessage = null) => {
                if (settled) return;
                settled = true;

                if (errorMessage) {
                    publicTunnelError = errorMessage;
                    publicTunnelLastFailureAt = Date.now();
                } else {
                    publicTunnelError = null;
                    publicTunnelLastFailureAt = 0;
                }

                publicTunnelPromise = null;
                resolve(url || null);
            };

            (async () => {
                try {
                    const cloudflaredBinary = await ensureCloudflaredBinary();
                    ensureDirectory(cloudflaredHome);
                    ensureDirectory(join(cloudflaredHome, '.cloudflared'));

                    const tunnelArgs = ['tunnel', '--url', quickTunnelOriginUrl];
                    if (primaryUsesHttps) {
                        tunnelArgs.push('--no-tls-verify');
                    }

                    const child = spawn(cloudflaredBinary, tunnelArgs, {
                        cwd: __dirname,
                        windowsHide: true,
                        env: {
                            ...process.env,
                            HOME: cloudflaredHome,
                            USERPROFILE: cloudflaredHome
                        },
                        stdio: ['ignore', 'pipe', 'pipe']
                    });

                    publicTunnelProcess = child;

                    const timeout = setTimeout(() => {
                        if (!cachedPublicBaseUrl || cachedPublicAccessSource !== 'cloudflare-quick-tunnel') {
                            stopPublicTunnel();
                            finish(null, 'Cloudflare Quick Tunnel startup timed out');
                        }
                    }, 25000);

                    const handleOutput = (chunk) => {
                        const text = String(chunk || '');
                        if (!text.trim()) return;

                        const detectedUrl = extractPublicUrl(text);
                        if (detectedUrl && detectedUrl.includes('trycloudflare.com')) {
                            cachedPublicBaseUrl = detectedUrl;
                            cachedPublicAccessSource = 'cloudflare-quick-tunnel';
                            clearTimeout(timeout);
                            console.log(`[PUBLIC] Cloudflare Quick Tunnel ready: ${detectedUrl}`);
                            finish(detectedUrl);
                            return;
                        }

                        if (/error|failed|unable|unreachable|timed out/i.test(text)) {
                            publicTunnelError = text.trim().split(/\r?\n/).pop();
                        }
                    };

                    child.stdout.on('data', handleOutput);
                    child.stderr.on('data', handleOutput);

                    child.once('error', (error) => {
                        clearTimeout(timeout);
                        publicTunnelProcess = null;
                        resetPublicTunnelState();
                        finish(null, `Cloudflare Quick Tunnel failed to start: ${error.message}`);
                    });

                    child.once('exit', (code, signal) => {
                        clearTimeout(timeout);
                        if (publicTunnelProcess === child) {
                            publicTunnelProcess = null;
                        }

                        const currentUrl = cachedPublicAccessSource === 'cloudflare-quick-tunnel' ? cachedPublicBaseUrl : null;
                        resetPublicTunnelState();

                        if (!settled) {
                            finish(currentUrl, currentUrl ? null : `Cloudflare Quick Tunnel exited before publishing a URL (${signal || code || 'unknown'})`);
                            return;
                        }

                        if (currentUrl) {
                            publicTunnelError = 'Cloudflare Quick Tunnel stopped';
                            publicTunnelLastFailureAt = Date.now();
                            console.warn('[PUBLIC] Cloudflare Quick Tunnel stopped. QR will fall back to the local network address until the tunnel is recreated.');
                        }
                    });
                } catch (error) {
                    publicTunnelProcess = null;
                    resetPublicTunnelState();
                    finish(null, error.message);
                }
            })();
        });

        return publicTunnelPromise;
    };

    const getEffectivePublicBaseUrl = async ({ startTunnel = false } = {}) => {
        if (explicitPublicBaseUrl) {
            return explicitPublicBaseUrl;
        }

        if (startTunnel) {
            return await ensureAutoPublicBaseUrl();
        }

        return cachedPublicBaseUrl;
    };

    const resolveAccessInfo = async ({ startTunnel = false } = {}) => {
        const localIP = getLocalIP();
        const activePublicBaseUrl = await getEffectivePublicBaseUrl({ startTunnel });

        if (activePublicBaseUrl) {
            const publicUrl = new URL(activePublicBaseUrl);
            return {
                connectUrl: buildConnectUrl(activePublicBaseUrl, APP_PASSWORD),
                baseUrl: activePublicBaseUrl,
                localIP,
                host: publicUrl.host,
                port: publicUrl.port ? Number(publicUrl.port) : (publicUrl.protocol === 'https:' ? 443 : 80),
                protocol: publicUrl.protocol.replace(':', ''),
                accessMode: 'public',
                sameNetworkRequired: false,
                publicAccessSource: cachedPublicAccessSource || 'configured',
                description: cachedPublicAccessSource === 'cloudflare-quick-tunnel'
                    ? 'Your phone will open Antigravity Remote through a Cloudflare Quick Tunnel.'
                    : 'Your phone will open Antigravity Remote through the configured public URL.',
                hint: cachedPublicAccessSource === 'cloudflare-quick-tunnel'
                    ? 'This QR uses Cloudflare Quick Tunnel, so the phone can connect from outside your local Wi-Fi while this machine stays online.'
                    : 'This QR uses a public URL, so the phone can connect from outside your local Wi-Fi as long as this machine and the tunnel stay online.'
            };
        }

        return {
            connectUrl: `${phoneProtocol}://${localIP}:${phonePort}?key=${encodeURIComponent(APP_PASSWORD)}`,
            baseUrl: `${phoneProtocol}://${localIP}:${phonePort}`,
            localIP,
            host: `${localIP}:${phonePort}`,
            port: phonePort,
            protocol: phoneProtocol,
            accessMode: 'local',
            sameNetworkRequired: true,
            publicAccessSource: null,
            description: 'Your phone will open Antigravity Remote directly on the current local address.',
            hint: autoPublicTunnelEnabled && publicTunnelError
                ? `Cloudflare Quick Tunnel is unavailable right now. ${publicTunnelError}. Keep the phone on the same Wi-Fi as this machine, or configure PUBLIC_BASE_URL for external access.`
                : 'Keep the phone on the same Wi-Fi as this machine when using the local connection.'
        };
    };

    let server;
    let httpsServer = null;

    if (certsExist) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
    }

    if (certsExist && IS_EMBEDDED_RUNTIME) {
        console.log(`[EMBEDDED] SSL certificates detected. Keeping local HTTP on port ${SERVER_PORT} for the embedded webview and enabling HTTPS on port ${phoneHttpsPort} for phone access.`);
    }

    if (explicitPublicBaseUrl) {
        console.log(`[PUBLIC] External access configured. QR links will use ${explicitPublicBaseUrl}`);
    } else if (autoPublicTunnelEnabled) {
        console.log('[PUBLIC] Automatic public tunnel is enabled. Open Phone QR to create a Cloudflare Quick Tunnel URL.');
    }

    if (primaryUsesHttps) {
        server = httpsServer;

        // Create HTTP redirect server → always redirect to HTTPS
        const redirectApp = express();
        redirectApp.use((req, res) => {
            const httpsUrl = `https://${req.hostname}:${SERVER_PORT}${req.url}`;
            res.redirect(301, httpsUrl);
        });
        const httpRedirectServer = http.createServer(redirectApp);
        const HTTP_REDIRECT_PORT = parseInt(SERVER_PORT) + 1;
        await killPortProcess(HTTP_REDIRECT_PORT);
        httpRedirectServer.listen(HTTP_REDIRECT_PORT, '0.0.0.0', () => {
            console.log(`🔀 HTTP redirect: http://localhost:${HTTP_REDIRECT_PORT} → https://localhost:${SERVER_PORT}`);
        }).on('error', () => {
            // Silently fail if redirect port is busy - HTTPS is primary
        });
    } else {
        server = http.createServer(app);
    }

    const websocketServers = [new WebSocketServer({ server })];
    if (httpsServer && httpsServer !== server) {
        websocketServers.push(new WebSocketServer({ server: httpsServer }));
    }

    const wss = {
        servers: websocketServers,
        get clients() {
            const clients = new Set();
            for (const wsServer of websocketServers) {
                wsServer.clients.forEach((client) => clients.add(client));
            }
            return clients;
        }
    };

    // Initialize Auth Token using a unique salt from environment
    const authSalt = process.env.AUTH_SALT || 'antigravity_default_salt_99';
    AUTH_TOKEN = hashString(APP_PASSWORD + authSalt);

    app.use(compression());
    app.use(express.json());

    // Use a secure session secret from .env if available
    const sessionSecret = process.env.SESSION_SECRET || 'antigravity_secret_key_1337';
    app.use(cookieParser(sessionSecret));

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    // Auth Middleware
    app.use((req, res, next) => {
        const publicPaths = ['/login', '/login.html', '/favicon.ico', '/logo.png'];
        if (publicPaths.includes(req.path) || req.path.startsWith('/css/')) {
            return next();
        }

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            return next();
        }

        // Magic Link / QR Code Auto-Login
        if (req.query.key === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            // Remove the key from the URL by redirecting to the base path
            return res.redirect('/');
        }

        const token = req.signedCookies[AUTH_COOKIE_NAME];
        if (token === AUTH_TOKEN) {
            return next();
        }

        // If it's an API request, return 401, otherwise redirect to login
        if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/snapshot') || req.path.startsWith('/send')) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    });

    app.use(express.static(join(__dirname, 'public')));

    // Login endpoint
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    // Logout endpoint
    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    // Get current snapshot
    app.get('/snapshot', async (req, res) => {
        const requestedWaitMs = Number.parseInt(String(req.query.waitMs || ''), 10);
        const waitMs = Number.isFinite(requestedWaitMs)
            ? Math.max(0, Math.min(requestedWaitMs, SNAPSHOT_REQUEST_WAIT_MAX_MS))
            : SNAPSHOT_REQUEST_WAIT_MS;

        let snapshot = lastSnapshot;
        let quality = snapshot ? getSnapshotQuality(snapshot) : null;
        const needsWarmup = !snapshot || !quality?.isReady;

        if (needsWarmup && cdpConnection?.ws?.readyState === WebSocket.OPEN) {
            try {
                const warmedSnapshot = await warmSnapshotCache(wss, {
                    timeoutMs: waitMs,
                    force: true,
                    minAttempts: 2
                });
                if (warmedSnapshot && !warmedSnapshot.error) {
                    snapshot = warmedSnapshot;
                    quality = getSnapshotQuality(snapshot);
                }
            } catch (error) {
                console.warn(`Snapshot request warm-up failed: ${error.message}`);
            }
        }

        if (!snapshot || !quality?.isReady) {
            let chatState = { hasChat: false, editorFound: false };
            if (cdpConnection?.ws?.readyState === WebSocket.OPEN) {
                try {
                    chatState = await hasChatOpen(cdpConnection);
                } catch (error) { }
            }

            const hasChat = !!(chatState?.hasChat || chatState?.editorFound);
            return res.status(503).json({
                error: hasChat ? 'Snapshot warming up' : 'No snapshot available yet',
                warming: hasChat,
                hasChat,
                retryAfterMs: 700
            });
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(snapshot);
    });

    // Health check endpoint
    app.get('/health', async (req, res) => {
        const accessInfo = await resolveAccessInfo();
        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1, // WebSocket.OPEN = 1
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            https: phoneUsesHttps,
            embedded: IS_EMBEDDED_RUNTIME,
            publicAccessEnabled: accessInfo.accessMode === 'public',
            publicBaseUrl: accessInfo.accessMode === 'public' ? accessInfo.baseUrl : null,
            publicAccessSource: accessInfo.publicAccessSource,
            publicTunnelError
        });
    });

    // QR Code endpoint - generates QR for phone connection
    app.get('/qr-info', async (req, res) => {
        try {
            const accessInfo = await resolveAccessInfo({ startTunnel: true });
            const connectUrl = accessInfo.connectUrl;

            const qrDataUrl = await QRCode.toDataURL(connectUrl, {
                width: 280,
                margin: 2,
                color: {
                    dark: '#e0e0e4',
                    light: '#111215'
                }
            });

            res.json({
                qrDataUrl,
                ...accessInfo
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // SSL status endpoint
    app.get('/ssl-status', async (req, res) => {
        const accessInfo = await resolveAccessInfo();
        const publicAccessEnabled = accessInfo.accessMode === 'public';
        const publicStatusUrl = publicAccessEnabled ? accessInfo.baseUrl : null;
        res.json({
            enabled: phoneUsesHttps,
            certsExist: certsExist,
            embedded: IS_EMBEDDED_RUNTIME,
            port: accessInfo.port,
            protocol: accessInfo.protocol,
            publicAccessEnabled,
            publicBaseUrl: publicStatusUrl,
            publicAccessSource: accessInfo.publicAccessSource,
            publicTunnelError,
            accessMode: accessInfo.accessMode,
            sameNetworkRequired: accessInfo.sameNetworkRequired,
            message: publicAccessEnabled ? `Public access is enabled via ${publicStatusUrl}. QR links will use this public URL.` :
                autoPublicTunnelEnabled && !publicTunnelError ? 'Cloudflare Quick Tunnel is ready on demand. Open Phone QR to create a shareable outside-network URL.' :
                    autoPublicTunnelEnabled && publicTunnelError ? `Cloudflare Quick Tunnel is unavailable right now: ${publicTunnelError}` :
                phoneUsesHttps && IS_EMBEDDED_RUNTIME ? `HTTPS is active for phone access on port ${phonePort}. Embedded webview stays on local HTTP.` :
                    phoneUsesHttps ? 'HTTPS is active' :
                    'No certificates found'
        });
    });

    // Generate SSL certificates endpoint
    app.post('/generate-ssl', async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node generate_ssl.js', {
                cwd: __dirname,
                stdio: 'pipe',
                env: {
                    ...process.env,
                    AG_RUNTIME_DIR: RUNTIME_ROOT
                }
            });
            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    });

    // Debug UI Endpoint
    app.get('/debug-ui', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    });

    // Set Mode
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    });

    // Set Model
    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    });

    // Stop Generation
    app.post('/stop', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    });

    // Send message
    app.post('/send', async (req, res) => {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const result = await injectMessage(cdpConnection, message);

        // Always return 200 - the message usually goes through even if CDP reports issues
        // The client will refresh and see if the message appeared
        res.json({
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        });
    });

    // --- File Upload ---
    const uploadsDir = join(RUNTIME_ROOT, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const upload = multer({
        storage: multer.diskStorage({
            destination: uploadsDir,
            filename: (req, file, cb) => {
                // Keep original name but prevent overwrite with timestamp prefix
                const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
                cb(null, `${Date.now()}-${safeName}`);
            }
        }),
        limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
    });

    app.post('/upload', upload.single('file'), async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const filePath = req.file.path.replace(/\\/g, '/'); // Normalize path for Windows
        console.log(`📎 File uploaded: ${req.file.originalname} (${req.file.size} bytes) → ${filePath}`);

        try {
            const result = await injectFile(cdpConnection, filePath);
            res.json({
                success: result.success !== false,
                file: req.file.originalname,
                size: req.file.size,
                details: result
            });
        } catch (e) {
            console.error('File inject error:', e);
            res.json({
                success: false,
                file: req.file.originalname,
                error: e.message
            });
        }
    });

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });

        const EXP = `(() => {
    try {
        // Safeguard for non-DOM contexts
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        // Helper to get string class name safely (handles SVGAnimatedString)
        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        // Helper to pierce Shadow DOM
        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (e) { }
            }
            return results;
        }

        // Get standard info
        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        // Scan for buttons
        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, i) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index: i,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(b => b.visible);

        return {
            url, title, bodyLen, hasCascade,
            buttons, lucideIcons: allLucideElements
        };
    } catch (err) {
        return { error: err.toString(), stack: err.stack };
    }
})()`;

        try {
            // 1. Get Frames
            const { frameTree } = await cdpConnection.call("Page.getFrameTree");
            function flattenFrames(node) {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];
                if (node.childFrames) {
                    for (const child of node.childFrames) list = list.concat(flattenFrames(child));
                }
                return list;
            }
            const allFrames = flattenFrames(frameTree);

            // 2. Map Contexts
            const contexts = cdpConnection.contexts.map(c => ({
                id: c.id,
                name: c.name,
                origin: c.origin,
                frameId: c.auxData ? c.auxData.frameId : null,
                isDefault: c.auxData ? c.auxData.isDefault : false
            }));

            // 3. Scan ALL Contexts
            const contextResults = [];
            for (const ctx of contexts) {
                try {
                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result?.value) {
                        const val = result.result.value;
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            url: val.url,
                            title: val.title,
                            hasCascade: val.hasCascade,
                            buttonCount: val.buttons.length,
                            lucideCount: val.lucideIcons.length,
                            buttons: val.buttons, // Store buttons for analysis
                            lucideIcons: val.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (e) {
                    contextResults.push({ contextId: ctx.id, error: e.message });
                }
            }

            // 4. Match and Analyze
            const cascadeFrame = allFrames.find(f => f.url.includes('cascade'));
            const matchingContext = contextResults.find(c => c.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((a, b) => (b.buttonCount || 0) - (a.buttonCount || 0))[0];

            // Prepare "useful buttons" from the best context
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext ? (bestContext.buttons || []).filter(b =>
                b.ariaLabel?.includes('New Conversation') ||
                b.title?.includes('New Conversation') ||
                b.ariaLabel?.includes('Past Conversations') ||
                b.title?.includes('Past Conversations') ||
                b.ariaLabel?.includes('History')
            ) : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts: contexts,
                scanResults: contextResults.map(c => ({
                    id: c.contextId,
                    frameId: c.frameId,
                    url: c.url,
                    hasCascade: c.hasCascade,
                    buttons: c.buttonCount,
                    error: c.error
                })),
                usefulButtons: usefulButtons,
                bestContextData: bestContext // Full data for the best context
            });

        } catch (e) {
            res.status(500).json({ error: e.message, stack: e.stack });
        }
    });

    // Endpoint to list all CDP targets - helpful for debugging connection issues
    app.get('/cdp-targets', async (req, res) => {
        const results = {};
        for (const port of PORTS) {
            try {
                const list = await getJson(`http://127.0.0.1:${port}/json/list`);
                results[port] = list;
            } catch (e) {
                results[port] = e.message;
            }
        }
        res.json(results);
    });

    // WebSocket connection with Auth check
    const handleWebSocketConnection = (ws, req) => {
        // Parse cookies from headers
        const rawCookies = req.headers.cookie || '';
        const parsedCookies = {};
        rawCookies.split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (k && v) {
                try {
                    parsedCookies[k] = decodeURIComponent(v);
                } catch (e) {
                    parsedCookies[k] = v;
                }
            }
        });

        // Verify signed cookie manually
        const signedToken = parsedCookies[AUTH_COOKIE_NAME];
        let isAuthenticated = false;

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            isAuthenticated = true;
        } else if (signedToken) {
            const sessionSecret = process.env.SESSION_SECRET || 'antigravity_secret_key_1337';
            const token = cookieParser.signedCookie(signedToken, sessionSecret);
            if (token === AUTH_TOKEN) {
                isAuthenticated = true;
            }
        }

        if (!isAuthenticated) {
            console.log('🚫 Unauthorized WebSocket connection attempt');
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        console.log('📱 Client connected (Authenticated)');

        void warmSnapshotCache(wss, {
            timeoutMs: SNAPSHOT_REQUEST_WAIT_MS,
            force: !lastSnapshot || getSnapshotQuality(lastSnapshot).isPlaceholderOnly,
            minAttempts: 2
        }).catch((error) => {
            console.warn(`Snapshot warm-up on client connect failed: ${error.message}`);
        });

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    };

    websocketServers.forEach((wsServer) => {
        wsServer.on('connection', handleWebSocketConnection);
    });

    return {
        server,
        httpsServer,
        wss,
        app,
        hasSSL: phoneUsesHttps,
        webProtocol,
        phoneProtocol,
        phonePort
    };
}

// Main
async function main() {
    let initialCdpError = null;

    try {
        await initCDP();
    } catch (err) {
        initialCdpError = err;
        const launchResult = await launchAntigravityWithCDP();
        if (launchResult?.ready) {
            try {
                await initCDP();
            } catch (retryErr) {
                initialCdpError = retryErr;
            }
        }

        if (!cdpConnection) {
        console.warn(`⚠️  Initial CDP discovery failed: ${err.message}`);
        console.log('💡 Start Antigravity with --remote-debugging-port=9000 to connect.');
    }

    }

    try {
        const { server, httpsServer, wss, app, hasSSL, webProtocol, phoneProtocol, phonePort } = await createServer();

        // Start background polling (it will now handle reconnections)
        startPolling(wss);

        // Remote Click
        app.post('/remote-click', async (req, res) => {
            const { selector, index, textContent } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await clickElement(cdpConnection, { selector, index, textContent });
            res.json(result);
        });

        // Remote Scroll - sync phone scroll to desktop
        app.post('/remote-scroll', async (req, res) => {
            const { scrollTop, scrollPercent } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
            res.json(result);
        });

        // Get App State
        app.get('/app-state', async (req, res) => {
            if (!cdpConnection) return res.json({ mode: 'Unknown', model: 'Unknown' });
            const result = await getAppState(cdpConnection);
            res.json(result);
        });

        // Start New Chat
        app.post('/new-chat', async (req, res) => {
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await startNewChat(cdpConnection);
            res.json(result);
        });

        // Get Chat History
        app.get('/chat-history', async (req, res) => {
            if (!cdpConnection) return res.json({ error: 'CDP disconnected', chats: [] });
            const keepOpen = req.query.keepOpen === '1' || req.query.keepOpen === 'true';
            const result = await getChatHistory(cdpConnection, { keepOpen });
            res.json(result);
        });

        // Select a Chat
        app.post('/select-chat', async (req, res) => {
            const { title } = req.body;
            if (!title) return res.status(400).json({ error: 'Chat title required' });
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await selectChat(cdpConnection, title);
            res.json(result);
        });

        // Close Chat History
        app.post('/close-history', async (req, res) => {
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await closeHistory(cdpConnection);
            res.json(result);
        });

        // Check if Chat is Open
        app.get('/chat-status', async (req, res) => {
            if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
            const result = await hasChatOpen(cdpConnection);
            res.json(result);
        });

        // Kill any existing process on the ports before starting
        await killPortProcess(SERVER_PORT);
        if (httpsServer && httpsServer !== server && phonePort !== SERVER_PORT) {
            await killPortProcess(phonePort);
        }

        // Start server(s) with EADDRINUSE retry
        const localIP = getLocalIP();
        const MAX_LISTEN_RETRIES = 3;

        const listenWithRetries = (targetServer, port, label, onReady) => {
            let listenRetries = 0;

            const startListening = () => {
                targetServer.listen(port, '0.0.0.0', onReady);
            };

            targetServer.on('error', async (err) => {
                if (err.code === 'EADDRINUSE' && listenRetries < MAX_LISTEN_RETRIES) {
                    listenRetries++;
                    console.warn(`[LISTEN] ${label} port ${port} busy, retry ${listenRetries}/${MAX_LISTEN_RETRIES}...`);
                    await killPortProcess(port);
                    setTimeout(startListening, 1000);
                    return;
                }

                if (err.code === 'EADDRINUSE') {
                    console.error(`[LISTEN] ${label} port ${port} still in use after ${MAX_LISTEN_RETRIES} retries. Exiting.`);
                    process.exit(1);
                    return;
                }

                console.error(`[LISTEN] ${label} server error:`, err.message);
            });

            startListening();
        };

        listenWithRetries(server, SERVER_PORT, 'Primary', () => {
            console.log(`[SERVER] Primary server running on ${webProtocol}://${localIP}:${SERVER_PORT}`);

            if (PUBLIC_BASE_URL) {
                console.log(`[PUBLIC] Share ${PUBLIC_BASE_URL} to access this machine from outside the local network.`);
            } else if (process.env.AG_AUTO_PUBLIC_TUNNEL !== '0') {
                console.log('[PUBLIC] Phone QR will create a Cloudflare Quick Tunnel URL for outside-network access when needed.');
            }

            if (httpsServer && httpsServer !== server) {
                console.log(`[SERVER] Phone HTTPS server will be available on https://${localIP}:${phonePort}`);
                console.log('[SERVER] First time on phone? Accept the security warning to proceed.');
                return;
            }

            if (hasSSL) {
                console.log('[SERVER] First time on phone? Accept the security warning to proceed.');
            }
        });

        if (httpsServer && httpsServer !== server) {
            listenWithRetries(httpsServer, phonePort, 'Phone HTTPS', () => {
                console.log(`[SERVER] Phone HTTPS server running on https://${localIP}:${phonePort}`);
            });
        }

        // Graceful shutdown handlers
        let isShuttingDown = false;
        const gracefulShutdown = (signal) => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            console.log(`\n[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);

            wss.servers.forEach((wsServer) => {
                wsServer.close(() => {
                    console.log('   WebSocket server closed');
                });
            });

            server.close(() => {
                console.log(`   ${server === httpsServer ? 'HTTPS' : 'HTTP'} server closed`);
            });

            if (httpsServer && httpsServer !== server) {
                httpsServer.close(() => {
                    console.log('   HTTPS phone server closed');
                });
            }

            stopPublicTunnel();
            console.log('   Public tunnel closed');

            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }

            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
