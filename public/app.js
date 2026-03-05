/**
 * AntigravityRemote - Frontend Application
 * PWA Chat Client mirroring Antigravity IDE chat panel
 */

// ============================================================================
// State
// ============================================================================
const state = {
    ws: null,
    connected: false,
    ideConnected: false,
    connectionMode: 'ui_automation',
    windowTitle: '',
    messages: [],
    agentStatus: 'disconnected',
    pendingApprovals: [],
    reconnectAttempts: 0,
    maxReconnectAttempts: 50,
    reconnectDelay: 2000,
    screenshotInterval: null,
    screenshotRefreshMs: 2500,
    settingsOpen: false,
};

// ============================================================================
// DOM Elements (lazy init after DOMContentLoaded)
// ============================================================================
let DOM = {};

function initDOM() {
    DOM = {
        chatContainer: document.getElementById('chatContainer'),
        chatContent: document.getElementById('chatContent'),
        messageInput: document.getElementById('messageInput'),
        sendBtn: document.getElementById('sendBtn'),
        headerTitle: document.getElementById('headerTitle'),
        connectionDot: document.getElementById('connectionDot'),
        approvalBanner: document.getElementById('approvalBanner'),
        approvalDesc: document.getElementById('approvalDesc'),
        agentDot: document.getElementById('agentDot'),
        agentStatusText: document.getElementById('agentStatusText'),
        modelName: document.getElementById('modelName'),
        reconnectOverlay: document.getElementById('reconnectOverlay'),
        settingsPanel: document.getElementById('settingsPanel'),
        connStatus: document.getElementById('connStatus'),
        screenshotImg: document.getElementById('screenshotImg'),
    };
}

// ============================================================================
// WebSocket Connection
// ============================================================================
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
        state.ws = new WebSocket(wsUrl);
    } catch (e) {
        console.error('[WS] Failed to create:', e);
        scheduleReconnect();
        return;
    }

    state.ws.onopen = () => {
        console.log('[WS] Connected');
        state.connected = true;
        state.reconnectAttempts = 0;
        DOM.reconnectOverlay?.classList.add('hidden');
        updateConnectionDot();
    };

    state.ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (err) {
            console.error('[WS] Parse error:', err);
        }
    };

    state.ws.onclose = () => {
        console.log('[WS] Disconnected');
        state.connected = false;
        updateConnectionDot();
        scheduleReconnect();
    };

    state.ws.onerror = () => { };
}

// Heartbeat
let heartbeatTimer = null;
function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
}

function scheduleReconnect() {
    if (state.reconnectAttempts >= state.maxReconnectAttempts) {
        DOM.reconnectOverlay?.classList.remove('hidden');
        return;
    }

    state.reconnectAttempts++;
    const delay = Math.min(state.reconnectDelay * Math.pow(1.3, state.reconnectAttempts), 30000);

    setTimeout(() => {
        if (!state.connected) {
            console.log(`[WS] Reconnecting (attempt ${state.reconnectAttempts})...`);
            connectWebSocket();
        }
    }, delay);
}

// ============================================================================
// Message Handler
// ============================================================================
function handleMessage(data) {
    switch (data.type) {
        case 'init':
            state.ideConnected = data.connected || data.antigravityRunning;
            state.connectionMode = data.mode || 'ui_automation';
            state.windowTitle = data.windowTitle || '';
            if (data.messages && data.messages.length > 0) {
                state.messages = data.messages;
            }
            updateAgentStatus(data.status || 'idle');
            updateConnectionDot();
            updateHeader();
            if (data.pendingApprovals) {
                updateApprovalBanner(data.pendingApprovals);
            }
            refreshScreenshot();
            break;

        case 'state_update':
            if (data.messages && data.messages.length > 0) {
                const changed = data.messages.length !== state.messages.length ||
                    JSON.stringify(data.messages[data.messages.length - 1]?.content?.substring(0, 100)) !==
                    JSON.stringify(state.messages[state.messages.length - 1]?.content?.substring(0, 100));

                if (changed) {
                    state.messages = data.messages;
                    refreshScreenshot();
                }
            }
            if (data.windowTitle) {
                state.windowTitle = data.windowTitle;
                updateHeader();
            }
            updateAgentStatus(data.status);
            updateApprovalBanner(data.pendingApprovals || []);
            break;

        case 'connection_status':
            state.ideConnected = data.connected || data.antigravityRunning;
            state.connectionMode = data.mode || 'ui_automation';
            updateConnectionDot();
            break;

        case 'conversation_update':
            refreshScreenshot();
            break;

        case 'send_result':
            if (!data.success) {
                showToast('❌ ' + (data.error || 'Send failed'));
            } else {
                showToast('✓ Message sent');
            }
            break;

        case 'approve_result':
            if (data.success) {
                showToast('✓ Approved');
                DOM.approvalBanner?.classList.add('hidden');
            } else {
                showToast('❌ ' + (data.error || 'Approve failed'));
            }
            break;

        case 'pong':
            break;
    }
}

// ============================================================================
// UI Updates
// ============================================================================
function updateConnectionDot() {
    const dot = DOM.connectionDot;
    if (!dot) return;

    dot.classList.remove('connected', 'disconnected');

    if (state.ideConnected) {
        dot.classList.add('connected');
        dot.title = 'Connected to Antigravity';
    } else if (state.connected) {
        dot.title = 'Server OK · No IDE';
    } else {
        dot.classList.add('disconnected');
        dot.title = 'Disconnected';
    }

    // Update settings panel connection status
    if (DOM.connStatus) {
        if (state.ideConnected) {
            DOM.connStatus.textContent = 'IDE Connected';
            DOM.connStatus.style.color = 'var(--success)';
        } else if (state.connected) {
            DOM.connStatus.textContent = 'Server Only';
            DOM.connStatus.style.color = 'var(--warning)';
        } else {
            DOM.connStatus.textContent = 'Disconnected';
            DOM.connStatus.style.color = 'var(--danger)';
        }
    }
}

function updateHeader() {
    if (!DOM.headerTitle) return;

    if (state.windowTitle) {
        // Extract conversation title from window title
        // e.g. "Refine Antigravity Chat Reader" from "en Agent Manager ... Refine Antigravity Chat Reader + ..."
        const cleaned = state.windowTitle.replace(/^\s*en\s+Agent\s+Manager\s*/i, '').trim();
        DOM.headerTitle.textContent = cleaned || 'Antigravity Chat';
    }

    // Extract model name from window title if available
    if (state.windowTitle && DOM.modelName) {
        const modelMatch = state.windowTitle.match(/Claude\s+[\w.]+(?:\s*\([^)]+\))?/i);
        if (modelMatch) {
            DOM.modelName.textContent = modelMatch[0];
        }
    }
}

function updateAgentStatus(status) {
    state.agentStatus = status;
    const dot = DOM.agentDot;
    const text = DOM.agentStatusText;
    if (!dot || !text) return;

    dot.className = 'agent-dot';

    switch (status) {
        case 'thinking':
            dot.classList.add('working');
            text.textContent = 'Working';
            break;
        case 'waiting_approval':
            dot.classList.add('waiting');
            text.textContent = 'Waiting for approval';
            break;
        case 'idle':
            dot.classList.add('idle');
            text.textContent = 'Idle';
            break;
        case 'disconnected':
            dot.classList.add('disconnected');
            text.textContent = 'Disconnected';
            break;
        default:
            text.textContent = status || 'Unknown';
    }
}

function updateApprovalBanner(approvals) {
    state.pendingApprovals = approvals;

    if (approvals.length > 0) {
        DOM.approvalBanner?.classList.remove('hidden');
        if (DOM.approvalDesc) {
            DOM.approvalDesc.textContent = approvals.map(a => a.text).join(', ') || 'Pending action';
        }
        // Vibrate on mobile
        if (navigator.vibrate) {
            navigator.vibrate([80, 40, 80]);
        }
    } else {
        DOM.approvalBanner?.classList.add('hidden');
    }
}

// ============================================================================
// Screenshot Refresh
// ============================================================================
function refreshScreenshot() {
    const img = DOM.screenshotImg;
    if (!img) return;

    const newSrc = '/api/screenshot?t=' + Date.now();
    img.src = newSrc;
}

function startScreenshotRefresh() {
    stopScreenshotRefresh();
    if (state.screenshotRefreshMs <= 0) return;

    state.screenshotInterval = setInterval(refreshScreenshot, state.screenshotRefreshMs);
    refreshScreenshot();
}

function stopScreenshotRefresh() {
    if (state.screenshotInterval) {
        clearInterval(state.screenshotInterval);
        state.screenshotInterval = null;
    }
}

function updateRefreshInterval(ms) {
    state.screenshotRefreshMs = parseInt(ms) || 0;
    startScreenshotRefresh();
}

function forceRefresh() {
    refreshScreenshot();
    showToast('Refreshed');
}

// ============================================================================
// Actions
// ============================================================================
async function sendMessage() {
    const input = DOM.messageInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    DOM.sendBtn.disabled = true;

    // Send via WebSocket
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'send_message', message: text }));
    } else {
        // Fallback to HTTP
        try {
            const res = await fetch('/api/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const result = await res.json();
            if (!result.success) {
                showToast('❌ ' + (result.error || 'Send failed'));
            } else {
                showToast('✓ Sent');
            }
        } catch {
            showToast('❌ Connection error');
        }
    }

    // Refresh screenshot after a delay to see the result
    setTimeout(refreshScreenshot, 1500);
}

async function approveAction() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'approve', index: 0 }));
    } else {
        try {
            const res = await fetch('/api/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: 0 }),
            });
            const result = await res.json();
            if (result.success) {
                showToast('✓ Approved');
                DOM.approvalBanner?.classList.add('hidden');
            }
        } catch {
            showToast('❌ Failed');
        }
    }
}

function rejectAction() {
    DOM.approvalBanner?.classList.add('hidden');
    showToast('Dismissed');
}

async function reconnect() {
    state.reconnectAttempts = 0;
    DOM.reconnectOverlay?.classList.add('hidden');

    try {
        await fetch('/api/reconnect', { method: 'POST' });
    } catch { /* ignore */ }

    connectWebSocket();
}

function toggleSettings() {
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen) {
        DOM.settingsPanel?.classList.remove('hidden');
    } else {
        DOM.settingsPanel?.classList.add('hidden');
    }
}

// ============================================================================
// Toast Notification
// ============================================================================
function showToast(message, duration = 2500) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.25s';
        setTimeout(() => toast.remove(), 250);
    }, duration);
}

// ============================================================================
// Input Handlers
// ============================================================================
function setupInputHandlers() {
    const input = DOM.messageInput;
    const sendBtn = DOM.sendBtn;
    if (!input || !sendBtn) return;

    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 100) + 'px';
        sendBtn.disabled = !input.value.trim();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (input.value.trim()) {
                sendMessage();
            }
        }
    });
}

// ============================================================================
// PWA Service Worker
// ============================================================================
async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('/sw.js');
        } catch { /* ignore */ }
    }
}

// ============================================================================
// Initialize
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    initDOM();
    setupInputHandlers();
    connectWebSocket();
    startHeartbeat();
    registerServiceWorker();
    startScreenshotRefresh();

    // Handle visibility change
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopScreenshotRefresh();
        } else {
            startScreenshotRefresh();
            if (!state.connected) {
                connectWebSocket();
            }
        }
    });
});
