/**
 * AntigravityRemote - Frontend Application
 * PWA Chat Client for Antigravity IDE
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
};

// ============================================================================
// DOM Elements
// ============================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
    chatMessages: $('#chatMessages'),
    chatContainer: $('#chatContainer'),
    messageInput: $('#messageInput'),
    sendBtn: $('#sendBtn'),
    connectionBadge: $('#connectionBadge'),
    approvalBanner: $('#approvalBanner'),
    approvalDesc: $('#approvalDesc'),
    agentStatus: $('#agentStatus'),
    statusIndicator: $('#statusIndicator'),
    statusText: $('#statusText'),
    reconnectOverlay: $('#reconnectOverlay'),
};

// ============================================================================
// WebSocket Connection
// ============================================================================
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
        console.log('[WS] Connected');
        state.connected = true;
        state.reconnectAttempts = 0;
        DOM.reconnectOverlay.classList.add('hidden');
        updateConnectionBadge();
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
        updateConnectionBadge();
        scheduleReconnect();
    };

    state.ws.onerror = (err) => {
        console.error('[WS] Error:', err);
    };

    // Heartbeat
    setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
}

function scheduleReconnect() {
    if (state.reconnectAttempts >= state.maxReconnectAttempts) {
        DOM.reconnectOverlay.classList.remove('hidden');
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
            if (data.messages && data.messages.length > 0) {
                state.messages = data.messages;
                renderMessages();
            }
            updateAgentStatus(data.status || 'idle');
            updateConnectionBadge();
            if (data.pendingApprovals) {
                updateApprovalBanner(data.pendingApprovals);
            }
            break;

        case 'state_update':
            if (data.messages && data.messages.length > 0) {
                const changed = data.messages.length !== state.messages.length ||
                    JSON.stringify(data.messages[data.messages.length - 1]?.content?.substring(0, 100)) !==
                    JSON.stringify(state.messages[state.messages.length - 1]?.content?.substring(0, 100));

                if (changed) {
                    state.messages = data.messages;
                    renderMessages();
                }
            }
            if (data.windowTitle) {
                state.windowTitle = data.windowTitle;
            }
            updateAgentStatus(data.status);
            updateApprovalBanner(data.pendingApprovals || []);
            break;

        case 'connection_status':
            state.ideConnected = data.connected || data.antigravityRunning;
            state.connectionMode = data.mode || 'ui_automation';
            updateConnectionBadge();
            break;

        case 'conversation_update':
            // File-based conversation update notification
            showToast('💬 Conversation updated');
            break;

        case 'send_result':
            if (!data.success) {
                showToast('Failed to send message: ' + (data.error || 'Unknown error'));
            } else {
                showToast('Message sent via keyboard ✓');
            }
            break;

        case 'approve_result':
            if (data.success) {
                showToast('Action approved ✓');
                DOM.approvalBanner.classList.add('hidden');
            } else {
                showToast('Failed to approve: ' + (data.error || 'Unknown error'));
            }
            break;

        case 'pong':
            break;
    }
}

// ============================================================================
// UI Updates
// ============================================================================
function updateConnectionBadge() {
    const badge = DOM.connectionBadge;
    const label = badge.querySelector('.label');

    badge.classList.remove('connected', 'disconnected');

    if (state.ideConnected) {
        badge.classList.add('connected');
        const modes = { hybrid: 'Hybrid', clipboard_reader: 'Clipboard', ui_automation: 'UI Auto' };
        const modeLabel = modes[state.connectionMode] || 'Connected';
        label.textContent = `Connected (${modeLabel})`;
    } else if (state.connected) {
        label.textContent = 'Server OK · No IDE';
    } else {
        badge.classList.add('disconnected');
        label.textContent = 'Disconnected';
    }
}

function updateAgentStatus(status) {
    state.agentStatus = status;
    const indicator = DOM.statusIndicator;
    const text = DOM.statusText;

    indicator.className = 'status-indicator';

    switch (status) {
        case 'thinking':
            indicator.classList.add('thinking');
            text.textContent = 'Agent is working...';
            break;
        case 'waiting_approval':
            indicator.classList.add('waiting');
            text.textContent = 'Waiting for approval';
            break;
        case 'idle':
            indicator.classList.add('idle');
            text.textContent = 'Agent idle';
            break;
        case 'disconnected':
            text.textContent = 'Not connected';
            break;
        default:
            text.textContent = 'Unknown state';
    }
}

function updateApprovalBanner(approvals) {
    state.pendingApprovals = approvals;

    if (approvals.length > 0) {
        DOM.approvalBanner.classList.remove('hidden');
        DOM.approvalDesc.textContent = approvals.map(a => a.text).join(', ') || 'Pending action';

        // Vibrate on mobile if supported
        if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
        }
    } else {
        DOM.approvalBanner.classList.add('hidden');
    }
}

// ============================================================================
// Chat Rendering
// ============================================================================
function renderMessages() {
    // Refresh screenshot image to show latest chat panel state
    refreshScreenshot();
}

let screenshotInterval = null;

function refreshScreenshot() {
    const img = document.getElementById('screenshotImg');
    if (img) {
        // Add timestamp to bust cache
        img.src = '/api/screenshot?t=' + Date.now();
    }
}

function startScreenshotRefresh() {
    if (screenshotInterval) return;
    // Refresh every 2.5 seconds
    screenshotInterval = setInterval(refreshScreenshot, 2500);
    // Also refresh immediately
    refreshScreenshot();
}

function formatMessage(text) {
    if (!text) return '';

    // Escape HTML
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
}

function isScrolledToBottom() {
    const container = DOM.chatContainer;
    return container.scrollHeight - container.clientHeight <= container.scrollTop + 50;
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        DOM.chatContainer.scrollTop = DOM.chatContainer.scrollHeight;
    });
}

// ============================================================================
// Actions
// ============================================================================
async function sendMessage() {
    const input = DOM.messageInput;
    const text = input.value.trim();
    if (!text) return;

    // Add to local state immediately
    state.messages.push({
        id: Date.now(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
    });
    renderMessages();
    scrollToBottom();

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
                showToast('Send failed: ' + (result.error || 'Unknown'));
            }
        } catch (err) {
            showToast('Connection error');
        }
    }
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
                showToast('Action approved ✓');
                DOM.approvalBanner.classList.add('hidden');
            }
        } catch (err) {
            showToast('Failed to approve');
        }
    }
}

function rejectAction() {
    // Just hide the banner - agent will timeout
    DOM.approvalBanner.classList.add('hidden');
    showToast('Action dismissed');
}

async function reconnect() {
    state.reconnectAttempts = 0;
    DOM.reconnectOverlay.classList.add('hidden');

    try {
        await fetch('/api/reconnect', { method: 'POST' });
    } catch { /* ignore */ }

    connectWebSocket();
}

// ============================================================================
// Toast Notification
// ============================================================================
function showToast(message, duration = 3000) {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toast.style.cssText = `
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-elevated);
    color: var(--text-primary);
    padding: 10px 20px;
    border-radius: var(--radius-md);
    font-size: 13px;
    font-family: var(--font-sans);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
    z-index: 500;
    animation: fadeInUp 0.25s ease;
  `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ============================================================================
// Input Handlers
// ============================================================================
function setupInputHandlers() {
    const input = DOM.messageInput;
    const sendBtn = DOM.sendBtn;

    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        sendBtn.disabled = !input.value.trim();
    });

    // Enter to send (Shift+Enter for new line)
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
            const reg = await navigator.serviceWorker.register('/sw.js');
            console.log('[SW] Registered', reg.scope);
        } catch (err) {
            console.log('[SW] Registration failed:', err);
        }
    }
}

// ============================================================================
// Initialize
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    setupInputHandlers();
    connectWebSocket();
    registerServiceWorker();
    startScreenshotRefresh();

    // Handle visibility change - reconnect when app comes to foreground
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !state.connected) {
            connectWebSocket();
        }
    });
});
