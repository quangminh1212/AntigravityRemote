// --- Touch Long-Press Tooltip System ---
(function () {
    let longPressTimer = null;
    let activeTooltip = null;

    function showTooltip(el) {
        hideTooltip();
        el.classList.add('tooltip-visible');
        activeTooltip = el;
    }

    function hideTooltip() {
        if (activeTooltip) {
            activeTooltip.classList.remove('tooltip-visible');
            activeTooltip = null;
        }
    }

    document.addEventListener('touchstart', (e) => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) { hideTooltip(); return; }
        longPressTimer = setTimeout(() => showTooltip(el), 500);
    }, { passive: true });

    document.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
        setTimeout(hideTooltip, 1500); // auto-hide after 1.5s
    }, { passive: true });

    document.addEventListener('touchmove', () => {
        clearTimeout(longPressTimer);
        hideTooltip();
    }, { passive: true });
})();

// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const settingsBtn = document.getElementById('settingsBtn');
const settingsDropdown = document.getElementById('settingsDropdown');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// --- Fullscreen Toggle ---
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => { });
    } else {
        document.exitFullscreen().catch(() => { });
    }
});

document.addEventListener('fullscreenchange', () => {
    const icon = document.getElementById('fullscreenIcon');
    if (document.fullscreenElement) {
        icon.innerHTML = '<path d="M4 14h3a2 2 0 0 1 2 2v3"></path><path d="M20 10h-3a2 2 0 0 1-2-2V5"></path><path d="M14 20v-3a2 2 0 0 1 2-2h3"></path><path d="M10 4v3a2 2 0 0 1-2 2H5"></path>';
        fullscreenBtn.setAttribute('data-tooltip', 'Exit Fullscreen');
    } else {
        icon.innerHTML = '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>';
        fullscreenBtn.setAttribute('data-tooltip', 'Fullscreen');
    }
});

// --- Theme management ---
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('arTheme', theme);
    // Update active state on options
    document.querySelectorAll('.settings-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.themeValue === theme);
    });
}
// Init theme from localStorage or default to dark
applyTheme(localStorage.getItem('arTheme') || 'dark');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modeMenu = document.getElementById('modeMenu');
const modelMenu = document.getElementById('modelMenu');
const modeDropdown = document.getElementById('modeDropdown');
const modelDropdown = document.getElementById('modelDropdown');
const dropdownBackdrop = document.getElementById('dropdownBackdrop');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0; // Timestamp until which we respect user scroll
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true; // Track if a chat is currently open
let cachedCssText = ''; // Cache CSS to avoid unnecessary re-injection
let lastRenderedHash = ''; // Track last rendered HTML hash to skip identical updates
let lastRenderedHtmlHash = ''; // Track content hash to avoid unnecessary DOM rebuilds
let pendingSnapshot = null; // Buffer for incoming WebSocket snapshots
let renderScheduled = false; // Prevent multiple rAF calls

// Fast string hash (FNV-1a) to compare HTML content
function fastHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}


// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    // Add ngrok skip warning header to all requests
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            return new Promise(() => { }); // Halt execution
        }
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 3000; // 3 seconds of scroll protection

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        // Mode Sync (Fast/Planning) - Desktop is source of truth
        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Planning');
            currentMode = data.mode;
        }

        // Model Sync - Desktop is source of truth
        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }

        // Running state sync - toggle send/stop button
        document.body.classList.toggle('agent-running', !!data.isRunning);

        console.log('[SYNC] State refreshed from Desktop:', data);
    } catch (e) { console.error('[SYNC] Failed to sync state', e); }
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    // Only show banner if currently on HTTP
    if (window.location.protocol === 'https:') return;

    // Check if user dismissed the banner before
    if (localStorage.getItem('sslBannerDismissed')) return;

    sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            sslBanner.innerHTML = `
                <span>✅ ${data.message}</span>
                <button onclick="location.reload()">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
        } else {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Error - Retry';
        btn.disabled = false;
    }
}

function dismissSslBanner() {
    sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

// Check SSL on load
checkSslStatus();
// --- Models ---
const MODELS = [
    { name: "Gemini 3.1 Pro (High)", badge: "New" },
    { name: "Gemini 3.1 Pro (Low)", badge: "New" },
    { name: "Gemini 3 Flash" },
    { name: "Claude Sonnet 4.6 (Thinking)" },
    { name: "Claude Opus 4.6 (Thinking)" },
    { name: "GPT-OSS 120B (Medium)" }
];

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        loadSnapshot(); // Initial load via HTTP
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'error' && data.message === 'Unauthorized') {
            window.location.href = '/login.html';
            return;
        }
        // Hash-based dedup: only fetch if content actually changed
        if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
            if (data.hash && data.hash === lastRenderedHash) return; // Skip identical
            lastRenderedHash = data.hash || '';
            loadSnapshot();
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
}

// --- Schedule render with requestAnimationFrame (prevents layout thrashing) ---
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        if (pendingSnapshot) {
            renderSnapshot(pendingSnapshot);
            pendingSnapshot = null;
        }
    });
}

// --- Core render function (used by both WS and HTTP paths) ---
function renderSnapshot(data) {
    chatIsOpen = true;

    // Capture scroll state BEFORE updating content
    const scrollPos = chatContainer.scrollTop;
    const scrollHeight = chatContainer.scrollHeight;
    const clientHeight = chatContainer.clientHeight;
    const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
    const isUserScrollLocked = Date.now() < userScrollLockUntil;

    // --- UPDATE STATS ---
    if (data.stats) {
        const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
        const nodes = data.stats.nodes;
        const statsText = document.getElementById('statsText');
        if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
    }

    // --- SYNC THEME FROM IDE ---
    if (data.backgroundColor || data.themeVars) {
        const tv = data.themeVars || {};
        const root = document.documentElement.style;
        // Determine best background: prefer VS Code theme var > effective cascade bg > body bg
        const bg = tv['--vscode-editor-background'] || data.backgroundColor || data.bodyBackgroundColor;
        const fg = tv['--vscode-editor-foreground'] || tv['--vscode-foreground'] || data.color || data.bodyColor;
        const panelBg = tv['--vscode-panel-background'] || tv['--vscode-sideBar-background'] || bg;
        const inputBg = tv['--vscode-input-background'] || panelBg;
        const mutedFg = tv['--vscode-descriptionForeground'] || '';

        // Update CSS custom properties so ALL elements using var(--bg-app) etc. auto-sync
        if (bg) root.setProperty('--bg-app', bg);
        if (panelBg) root.setProperty('--bg-panel', panelBg);
        if (inputBg) root.setProperty('--bg-input', inputBg);
        if (fg) root.setProperty('--text-main', fg);
        if (mutedFg) root.setProperty('--text-muted', mutedFg);
    }

    // --- CSS INJECTION (Cached - only update when CSS changes) ---
    let styleTag = document.getElementById('cdp-styles');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'cdp-styles';
        document.head.appendChild(styleTag);
    }

    // Only rebuild CSS if the source CSS from snapshot changed
    if (data.css !== cachedCssText) {
        cachedCssText = data.css;
        // Use IDE theme colors or fallback to defaults
        const tv = data.themeVars || {};
        const themeFg = tv['--vscode-editor-foreground'] || tv['--vscode-foreground'] || data.color || '#f0f0f2';
        const themeMuted = tv['--vscode-descriptionForeground'] || '#8a8d92';
        const darkModeOverrides = '/* --- BASE SNAPSHOT CSS --- */\n' +
            data.css +
            '\n\n/* --- THEME OVERRIDES --- */\n' +
            '#conversation, #chat, #cascade {\n' +
            '    background-color: transparent !important;\n' +
            '    color: var(--text-main) !important;\n' +
            '    font-family: \'Inter\', system-ui, sans-serif !important;\n' +
            '    position: relative !important;\n' +
            '    height: auto !important;\n' +
            '    width: 100% !important;\n' +
            '}\n' +
            '\n' +
            '/* Fix stacking BUT preserve absolute/fixed positioning for dropdowns */\n' +
            '#conversation > div, #chat > div, #cascade > div {\n' +
            '    position: static !important;\n' +
            '}\n' +
            '/* Preserve absolute positioning needed for dropdowns, tooltips, popups */\n' +
            '[style*="position: absolute"], [style*="position: fixed"],\n' +
            '[data-headlessui-state], [id*="headlessui"] {\n' +
            '    position: absolute !important;\n' +
            '}\n' +
            '\n' +
            '/* Force black/very dark inline text to light (preserve other colors) */\n' +
            '[style*="color: rgb(0, 0, 0)"], [style*="color: black"],\n' +
            '[style*="color:#000"], [style*="color: #000"],\n' +
            '[style*="color: rgb(3"], [style*="color: rgb(2"],\n' +
            '[style*="color: rgb(1, "], [style*="color: rgb(5, "],\n' +
            '[style*="color: rgb(10,"], [style*="color: rgb(15,"],\n' +
            '[style*="color: rgb(20,"], [style*="color: rgb(25,"],\n' +
            '[style*="color: rgb(30,"], [style*="color: rgb(35,"],\n' +
            '[style*="color: rgb(40,"], [style*="color: rgb(45,"],\n' +
            '[style*="color: rgb(50,"], [style*="color: rgb(55,"],\n' +
            '[style*="color: rgb(60,"], [style*="color: rgb(65,"],\n' +
            '[style*="color: rgb(70,"], [style*="color: rgb(75,"] {\n' +
            '    color: var(--text-main) !important;\n' +
            '}\n' +
            '\n' +
            '#conversation a, #chat a, #cascade a {\n' +
            '    color: #818cf8 !important;\n' +
            '    text-decoration: underline;\n' +
            '}\n' +
            '\n' +
            '/* Hide broken local file icons (served from /c:/Users/... paths) */\n' +
            'img[src^="/c:"], img[src^="/C:"], img[src*="AppData"] {\n' +
            '    display: none !important;\n' +
            '}\n' +
            '\n' +
            '/* Override Tailwind default block display for embedded file icons */\n' +
            'img, svg {\n' +
            '    display: inline !important;\n' +
            '    vertical-align: middle !important;\n' +
            '}\n' +
            '/* Force file-reference wrappers (icon + filename) to stay inline */\n' +
            'div:has(> img[src^="data:"]), div:has(> img[alt]), span:has(> img) {\n' +
            '    display: inline !important;\n' +
            '    vertical-align: middle !important;\n' +
            '}\n' +
            '/* Inline-flex containers from Antigravity (e.g. file mentions) */\n' +
            '[class*="inline-flex"], [class*="inline-block"], [class*="items-center"]:has(img) {\n' +
            '    display: inline-flex !important;\n' +
            '    vertical-align: middle !important;\n' +
            '}\n' +
            '\n' +
            '/* Fix Inline Code - Ultra-compact */\n' +
            ':not(pre) > code {\n' +
            '    padding: 0px 2px !important;\n' +
            '    border-radius: 2px !important;\n' +
            '    background-color: rgba(255, 255, 255, 0.08) !important;\n' +
            '    font-size: 0.82em !important;\n' +
            '    line-height: 1 !important;\n' +
            '    white-space: normal !important;\n' +
            '}\n' +
            '\n' +
            'pre, code, .monaco-editor-background, [class*="terminal"] {\n' +
            '    background-color: #1a1b20 !important;\n' +
            '    color: #e0e0e4 !important;\n' +
            '    font-family: \'JetBrains Mono\', monospace !important;\n' +
            '    border-radius: 3px;\n' +
            '    border: 1px solid #2a2b32;\n' +
            '}\n' +
            '                \n' +
            '/* Multi-line Code Block - Minimal */\n' +
            'pre {\n' +
            '    position: relative !important;\n' +
            '    white-space: pre-wrap !important; \n' +
            '    word-break: break-word !important;\n' +
            '    padding: 4px 6px !important;\n' +
            '    margin: 2px 0 !important;\n' +
            '    display: block !important;\n' +
            '    width: 100% !important;\n' +
            '}\n' +
            '                \n' +
            'pre.has-copy-btn {\n' +
            '    padding-right: 28px !important;\n' +
            '}\n' +
            '                \n' +
            '/* Single-line Code Block - Minimal */\n' +
            'pre.single-line-pre {\n' +
            '    display: inline-block !important;\n' +
            '    width: auto !important;\n' +
            '    max-width: 100% !important;\n' +
            '    padding: 0px 4px !important;\n' +
            '    margin: 0px !important;\n' +
            '    vertical-align: middle !important;\n' +
            '    background-color: #1a1b20 !important;\n' +
            '    font-size: 0.85em !important;\n' +
            '}\n' +
            '                \n' +
            'pre.single-line-pre > code {\n' +
            '    display: inline !important;\n' +
            '    white-space: nowrap !important;\n' +
            '}\n' +
            '                \n' +
            'pre:not(.single-line-pre) > code {\n' +
            '    display: block !important;\n' +
            '    width: 100% !important;\n' +
            '    overflow-x: auto !important;\n' +
            '    background: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '                \n' +
            '.mobile-copy-btn {\n' +
            '    position: absolute !important;\n' +
            '    top: 2px !important;\n' +
            '    right: 2px !important;\n' +
            '    background: rgba(26, 27, 32, 0.6) !important;\n' +
            '    color: #8a8d92 !important;\n' +
            '    border: none !important;\n' +
            '    width: 24px !important; \n' +
            '    height: 24px !important;\n' +
            '    padding: 0 !important;\n' +
            '    cursor: pointer !important;\n' +
            '    display: flex !important;\n' +
            '    align-items: center !important;\n' +
            '    justify-content: center !important;\n' +
            '    border-radius: 4px !important;\n' +
            '    transition: all 0.2s ease !important;\n' +
            '    -webkit-tap-highlight-color: transparent !important;\n' +
            '    z-index: 10 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '                \n' +
            '.mobile-copy-btn:hover,\n' +
            '.mobile-copy-btn:focus {\n' +
            '    background: rgba(99, 102, 241, 0.2) !important;\n' +
            '    color: #818cf8 !important;\n' +
            '}\n' +
            '                \n' +
            '.mobile-copy-btn svg {\n' +
            '    width: 16px !important;\n' +
            '    height: 16px !important;\n' +
            '    stroke: currentColor !important;\n' +
            '    stroke-width: 2 !important;\n' +
            '    fill: none !important;\n' +
            '}\n' +
            '                \n' +
            'blockquote {\n' +
            '    border-left: 3px solid #6366f1 !important;\n' +
            '    background: rgba(99, 102, 241, 0.08) !important;\n' +
            '    color: #c8c8cc !important;\n' +
            '    padding: 8px 12px !important;\n' +
            '    margin: 8px 0 !important;\n' +
            '}\n' +
            '\n' +
            'table {\n' +
            '    border-collapse: collapse !important;\n' +
            '    width: 100% !important;\n' +
            '    border: 1px solid #2a2b32 !important;\n' +
            '}\n' +
            'th, td {\n' +
            '    border: 1px solid #2a2b32 !important;\n' +
            '    padding: 8px !important;\n' +
            '    color: #e0e0e4 !important;\n' +
            '}\n' +
            '\n' +
            '::-webkit-scrollbar {\n' +
            '    width: 0 !important;\n' +
            '}\n' +
            '                \n' +
            '[style*="background-color: rgb(255, 255, 255)"],\n' +
            '[style*="background-color: white"],\n' +
            '[style*="background: white"],\n' +
            '[style*="background-color: rgb(249"],\n' +
            '[style*="background-color: rgb(248"],\n' +
            '[style*="background-color: rgb(244"],\n' +
            '[style*="background-color: rgb(243"],\n' +
            '[style*="background-color: rgb(241"],\n' +
            '[style*="background-color: rgb(31"],\n' +
            '[style*="background-color: rgb(30"],\n' +
            '[style*="background-color: rgb(15"],\n' +
            '[style*="background-color: rgb(17"],\n' +
            '[style*="background-color: rgb(24"],\n' +
            '[style*="background-color: rgb(32"],\n' +
            '[style*="background-color: rgb(38"],\n' +
            '[class*="bg-gray"], [class*="bg-slate"],\n' +
            '[class*="bg-neutral"], [class*="bg-zinc"],\n' +
            '[class*="bg-ide-"], [class*="from-ide-"],\n' +
            '[class*="bg-white"] {\n' +
            '    background-color: transparent !important;\n' +
            '}\n' +
            '#conversation > div > div, #chat > div > div, #cascade > div > div {\n' +
            '    background-color: transparent !important;\n' +
            '}\n' +
            '\n' +
            '/* IDE-style framed panels (command blocks) */\n' +
            '.rounded-lg {\n' +
            '    background-color: rgba(128, 128, 128, 0.06) !important;\n' +
            '    border: 1px solid var(--border-color, #2a2b32) !important;\n' +
            '    border-radius: 8px !important;\n' +
            '    padding: 8px !important;\n' +
            '    margin: 4px 0 !important;\n' +
            '}\n' +
            '/* Thinking/thought sections - no frame like IDE */\n' +
            '.rounded-lg:has(> details), .rounded-lg:has(> summary),\n' +
            'details.rounded-lg, .rounded-lg > details {\n' +
            '    background-color: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '/* Thinking/thought toggle section (.isolate wrapper) */\n' +
            '.isolate, .isolate > button {\n' +
            '    background-color: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '    border-radius: 0 !important;\n' +
            '    outline: none !important;\n' +
            '    box-shadow: none !important;\n' +
            '}\n' +
            '/* Good/Bad feedback row - no frame */\n' +
            '.rounded-lg:has([data-tooltip-id^="up-"], [data-tooltip-id^="down-"]) {\n' +
            '    background-color: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '\n' +
            '/* User message bubble */\n' +
            '[data-role="user"] {\n' +
            '    background-color: rgba(128, 128, 128, 0.1) !important;\n' +
            '    border-radius: 12px !important;\n' +
            '    padding: 10px 14px !important;\n' +
            '    margin-bottom: 4px !important;\n' +
            '}\n' +
            '/* Remove inner background/border inside user message */\n' +
            '[data-role="user"] .rounded-lg,\n' +
            '[data-role="user"] [class*="bg-gray-500"] {\n' +
            '    background-color: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '\n' +
            '/* IDE text color class sync */\n' +
            '.text-ide-text-color {\n' +
            '    color: var(--text-main) !important;\n' +
            '}';
        styleTag.textContent = darkModeOverrides;
    }

    // --- HTML UPDATE (skip if unchanged to prevent text jittering) ---
    const htmlHash = fastHash(data.html);
    if (htmlHash !== lastRenderedHtmlHash) {
        lastRenderedHtmlHash = htmlHash;
        chatContent.innerHTML = data.html;

        // Ensure dark mode classes are set for Tailwind dark variant activation
        chatContent.classList.add('dark');
        chatContent.setAttribute('data-theme', 'dark');
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';

        // Add mobile copy buttons to all code blocks
        addMobileCopyButtons();
    }

    // Smart scroll behavior: respect user scroll, only auto-scroll when appropriate
    if (isUserScrollLocked) {
        // User recently scrolled - try to maintain their approximate position
        const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
        const newScrollPos = chatContainer.scrollHeight * scrollPercent;
        chatContainer.scrollTop = newScrollPos;
    } else if (isNearBottom || scrollPos === 0) {
        // User was at bottom or hasn't scrolled - instant scroll (no smooth during updates)
        chatContainer.scrollTop = chatContainer.scrollHeight;
    } else {
        // Preserve exact scroll position
        chatContainer.scrollTop = scrollPos;
    }
}

// --- Rendering (HTTP fallback - used for initial load and manual refresh) ---
async function loadSnapshot() {
    try {
        // Add spin animation to refresh button
        const icon = refreshBtn.querySelector('svg');
        icon.classList.remove('spin-anim');
        void icon.offsetWidth; // trigger reflow
        icon.classList.add('spin-anim');

        const response = await fetchWithAuth('/snapshot');
        if (!response.ok) {
            if (response.status === 503) {
                // No snapshot available - likely no chat open
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        const data = await response.json();
        renderSnapshot(data);

    } catch (err) {
        console.error(err);
    }
}

// --- Mobile Code Block Copy Functionality ---
function addMobileCopyButtons() {
    // Find all pre elements (code blocks) in the chat
    const codeBlocks = chatContent.querySelectorAll('pre');

    codeBlocks.forEach((pre, index) => {
        // Skip if already has our button
        if (pre.querySelector('.mobile-copy-btn')) return;

        // Get the code text
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();

        // Check if there's a newline character in the TRIMMED text
        // This ensures single-line blocks with trailing newlines don't get buttons
        const hasNewline = /\n/.test(textToCopy);

        // If it's a single line code block, don't add the copy button
        if (!hasNewline) {
            pre.classList.remove('has-copy-btn');
            pre.classList.add('single-line-pre');
            return;
        }

        // Add class for padding
        pre.classList.remove('single-line-pre');
        pre.classList.add('has-copy-btn');

        // Create the copy button (icon only)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('data-code-index', index);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            `;

        // Add click handler for copy
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const success = await copyToClipboard(textToCopy);

            if (success) {
                // Visual feedback - show checkmark
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            `;

                // Reset after 2 seconds
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            } else {
                // Show X icon briefly on error
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
            `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            }
        });

        // Insert button into pre element
        pre.appendChild(copyBtn);
    });
}

// --- Cross-platform Clipboard Copy ---
async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API (works on HTTPS or localhost)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[COPY] Success via Clipboard API');
            return true;
        } catch (err) {
            console.warn('[COPY] Clipboard API failed:', err);
        }
    }

    // Method 2: Fallback using execCommand (works on HTTP, older browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;

        // Avoid scrolling to bottom on iOS
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);

        // iOS specific handling
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            const range = document.createRange();
            range.selectNodeContents(textArea);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            textArea.setSelectionRange(0, text.length);
        } else {
            textArea.select();
        }

        const success = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (success) {
            console.log('[COPY] Success via execCommand fallback');
            return true;
        }
    } catch (err) {
        console.warn('[COPY] execCommand fallback failed:', err);
    }

    // Method 3: For Android WebView or restricted contexts
    // Show the text in a selectable modal if all else fails
    console.error('[COPY] All copy methods failed');
    return false;
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// --- Inputs ---
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    // Optimistic UI updates
    const previousValue = messageInput.value;
    messageInput.value = ''; // Clear immediately
    messageInput.style.height = 'auto'; // Reset height
    messageInput.blur(); // Close keyboard on mobile immediately

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        // If no chat is open, start a new one first
        if (!chatIsOpen) {
            const newChatRes = await fetchWithAuth('/new-chat', { method: 'POST' });
            const newChatData = await newChatRes.json();
            if (newChatData.success) {
                // Wait for the new chat to be ready
                await new Promise(r => setTimeout(r, 800));
                chatIsOpen = true;
            }
        }

        const res = await fetchWithAuth('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        // Always reload snapshot to check if message appeared
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 800);
        setTimeout(checkChatStatus, 1000);

        // Don't revert the input - if user sees the message in chat, it was sent
        // Only log errors for debugging, don't show alert popups
        if (!res.ok) {
            console.warn('Send response not ok, but message may have been sent:', await res.json().catch(() => ({})));
        }
    } catch (e) {
        // Network error - still try to refresh in case it went through
        console.error('Send error:', e);
        setTimeout(loadSnapshot, 500);
    } finally {
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
    }
}

// --- Event Listeners ---
sendBtn.addEventListener('click', sendMessage);

refreshBtn.addEventListener('click', () => {
    // Refresh both Chat and State (Mode/Model)
    loadSnapshot();
    fetchAppState(); // PRIORITY: Sync from Desktop
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// --- File Attach Logic ---
attachBtn.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;

    // Create or get preview bar
    let previewBar = document.querySelector('.file-preview-bar');
    if (!previewBar) {
        previewBar = document.createElement('div');
        previewBar.className = 'file-preview-bar';
        // Insert before textarea inside input-box
        const inputBox = document.querySelector('.input-box');
        inputBox.insertBefore(previewBar, inputBox.firstChild);
    }

    // Upload each file
    for (const file of files) {
        const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        // Create preview item
        const item = document.createElement('div');
        item.className = 'file-preview-item uploading';
        item.id = fileId;
        item.innerHTML = `
            <span class="file-preview-name" title="${file.name}">${file.name}</span>
            <span class="file-preview-size">${formatFileSize(file.size)}</span>
            <div class="file-preview-spinner"></div>
        `;
        previewBar.appendChild(item);

        // Upload
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetchWithAuth('/upload', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.success) {
                item.classList.remove('uploading');
                item.classList.add('uploaded');
                item.querySelector('.file-preview-spinner').outerHTML = '<span class="file-preview-check">✓</span>';
                // Add remove button
                const removeBtn = document.createElement('button');
                removeBtn.className = 'file-preview-remove';
                removeBtn.innerHTML = '×';
                removeBtn.setAttribute('aria-label', 'Remove file');
                removeBtn.addEventListener('click', () => {
                    item.remove();
                    if (previewBar.children.length === 0) previewBar.remove();
                });
                item.appendChild(removeBtn);

                // Auto-remove after 5s
                setTimeout(() => {
                    item.style.transition = 'opacity 0.3s';
                    item.style.opacity = '0';
                    setTimeout(() => {
                        item.remove();
                        if (previewBar && previewBar.children.length === 0) previewBar.remove();
                    }, 300);
                }, 5000);
            } else {
                item.classList.remove('uploading');
                item.classList.add('error');
                item.querySelector('.file-preview-spinner').outerHTML = '<span style="color:#ef4444">✗</span>';
                console.error('[UPLOAD] Failed:', data.error);
            }
        } catch (e) {
            item.classList.remove('uploading');
            item.classList.add('error');
            item.querySelector('.file-preview-spinner').outerHTML = '<span style="color:#ef4444">✗</span>';
            console.error('[UPLOAD] Error:', e);
        }
    }

    // Reset file input so the same file can be re-selected
    fileInput.value = '';

    // Reload snapshot to see the attached file in chat
    setTimeout(loadSnapshot, 1000);
    setTimeout(loadSnapshot, 2500);
});

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

// --- Scroll Sync to Desktop ---
let scrollSyncTimeout = null;
let lastScrollSync = 0;
const SCROLL_SYNC_DEBOUNCE = 150; // ms between scroll syncs
let snapshotReloadPending = false;

async function syncScrollToDesktop() {
    const scrollPercent = chatContainer.scrollTop / (chatContainer.scrollHeight - chatContainer.clientHeight);
    try {
        await fetchWithAuth('/remote-scroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scrollPercent })
        });

        // After scrolling desktop, reload snapshot to get newly visible content
        // (Antigravity uses virtualized scrolling - only visible messages are in DOM)
        if (!snapshotReloadPending) {
            snapshotReloadPending = true;
            setTimeout(() => {
                loadSnapshot();
                snapshotReloadPending = false;
            }, 300);
        }
    } catch (e) {
        console.log('Scroll sync failed:', e.message);
    }
}

chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    // Set a lock to prevent auto-scroll jumping for a few seconds
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        // If user scrolled to bottom, clear the lock so auto-scroll works
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    // Debounced scroll sync to desktop
    const now = Date.now();
    if (now - lastScrollSync > SCROLL_SYNC_DEBOUNCE) {
        lastScrollSync = now;
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(syncScrollToDesktop, 100);
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
        autoRefreshEnabled = true;
    }, 5000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0; // Clear lock so auto-scroll works again
    scrollToBottom();
});

// --- Stop Logic ---
stopBtn.addEventListener('click', async () => {
    stopBtn.style.opacity = '0.5';
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // Immediately switch back to send button
            document.body.classList.remove('agent-running');
        }
    } catch (e) { }
    setTimeout(() => stopBtn.style.opacity = '1', 500);
    // Re-sync state from desktop
    setTimeout(fetchAppState, 1000);
});

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            // Reload snapshot to show new empty chat
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1000);
            setTimeout(checkChatStatus, 1500);
        } else {
            console.error('Failed to start new chat:', data.error);
        }
    } catch (e) {
        console.error('New chat error:', e);
    }

    setTimeout(() => {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
    }, 500);
}

newChatBtn.addEventListener('click', startNewChat);

// --- Settings / Theme Toggle ---
settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
});

settingsDropdown.addEventListener('click', (e) => {
    const option = e.target.closest('.settings-option');
    if (option) {
        applyTheme(option.dataset.themeValue);
        settingsDropdown.classList.remove('open');
    }
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-wrapper')) {
        settingsDropdown.classList.remove('open');
    }
});

// --- Chat History Logic ---
async function showChatHistory() {
    const historyLayer = document.getElementById('historyLayer');
    const historyList = document.getElementById('historyList');

    // Show loading state
    historyList.innerHTML = `
        <div class="history-state-container">
            <div class="history-spinner"></div>
            <div class="history-state-text">Loading History...</div>
        </div>
    `;
    historyLayer.classList.add('show');
    historyBtn.style.opacity = '1';

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();

        if (data.error) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon">⚠️</div>
                    <div class="history-state-title">Error loading history</div>
                    <div class="history-state-desc">${data.error}</div>
                    <button class="history-new-btn mt-4" onclick="hideChatHistory(); startNewChat();">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `;
            return;
        }

        const chats = data.chats || [];
        if (chats.length === 0) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon">📝</div>
                    <div class="history-state-title">No conversations yet</div>
                    <div class="history-state-desc">Start a new conversation to see them here.</div>
                </div>
            `;
            return;
        }

        // Helper: relative time
        function timeAgo(dateStr) {
            if (!dateStr) return '';
            const diff = Date.now() - new Date(dateStr).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 1) return 'now';
            if (mins < 60) return mins + ' mins ago';
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return hrs + ' hrs ago';
            const days = Math.floor(hrs / 24);
            return days + ' day' + (days > 1 ? 's' : '') + ' ago';
        }

        // Current chat = first item (most recent/active)
        const current = chats[0];
        const rest = chats.slice(1);
        const safeCurrentTitle = current.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        let html = '';

        // Current section
        html += `<div class="history-section-label">Current</div>`;
        html += `<div class="history-item current" onclick="hideChatHistory(); selectChat('${safeCurrentTitle}');">
            <span class="history-item-title">${escapeHtml(current.title)}</span>
            <span class="history-item-time">${timeAgo(current.lastModified)}</span>
        </div>`;

        // Recent section
        if (rest.length > 0) {
            html += `<div class="history-section-label">Recent</div>`;
            rest.forEach(chat => {
                const safeTitle = chat.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                html += `<div class="history-item" onclick="hideChatHistory(); selectChat('${safeTitle}');">
                    <span class="history-item-title">${escapeHtml(chat.title)}</span>
                    <span class="history-item-time">${timeAgo(chat.lastModified)}</span>
                </div>`;
            });
        }

        historyList.innerHTML = html;

    } catch (e) {
        historyList.innerHTML = `
            <div class="history-state-container">
                <div class="history-state-icon">🔌</div>
                <div class="history-state-title">Connection Error</div>
                <div class="history-state-desc">Failed to reach the server.</div>
            </div>
        `;
    }
}


function hideChatHistory() {
    historyLayer.classList.remove('show');
    // Send an escape key to Antigravity to close the History panel
    try {
        fetchWithAuth('/close-history', { method: 'POST' });
    } catch (e) {
        console.error('Failed to close history on desktop:', e);
    }
}

historyBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent settings dropdown from catching this click
    settingsDropdown.classList.remove('open'); // Close settings dropdown
    showChatHistory();
});

// --- Select Chat from History ---
async function selectChat(title) {
    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        const data = await res.json();

        if (data.success) {
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(checkChatStatus, 1000);
        } else {
            console.error('Failed to select chat:', data.error);
        }
    } catch (e) {
        console.error('Select chat error:', e);
    }
}

// --- Check Chat Status ---
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();

        chatIsOpen = data.hasChat || data.editorFound;

        if (!chatIsOpen) {
            showEmptyState();
        }
    } catch (e) {
        console.error('Chat status check failed:', e);
    }
}

// --- Empty State (No Chat Open) ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                <line x1="9" y1="10" x2="15" y2="10"></line>
            </svg>
            <h2>No Chat Open</h2>
            <p>Start a new conversation or select one from your history to begin chatting.</p>
            <button class="empty-state-btn" onclick="startNewChat()">
                Start New Conversation
            </button>
        </div>
    `;
}

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Dropdown Logic ---

function closeAllDropdowns() {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.toolbar-chip.open').forEach(c => c.classList.remove('open'));
    dropdownBackdrop.classList.remove('show');
}

function toggleDropdown(menu, chip) {
    const isOpen = menu.classList.contains('show');
    closeAllDropdowns();
    if (!isOpen) {
        menu.classList.add('show');
        chip.classList.add('open');
        dropdownBackdrop.classList.add('show');
    }
}

dropdownBackdrop.addEventListener('click', closeAllDropdowns);

// --- Mode dropdown ---
modeBtn.addEventListener('click', () => {
    toggleDropdown(modeMenu, modeBtn);
});

modeMenu.addEventListener('click', async (e) => {
    const opt = e.target.closest('.dropdown-option');
    if (!opt) return;
    const mode = opt.dataset.value;
    closeAllDropdowns();

    modeText.textContent = 'Setting...';
    try {
        const res = await fetchWithAuth('/set-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (data.success) {
            currentMode = mode;
            modeText.textContent = mode;
            // Update active state
            modeMenu.querySelectorAll('.dropdown-option').forEach(o => {
                o.classList.toggle('active', o.dataset.value === mode);
            });
        } else {
            alert('Error: ' + (data.error || 'Unknown'));
            modeText.textContent = currentMode;
        }
    } catch (e) {
        modeText.textContent = currentMode;
    }
});

// --- Model dropdown - build options dynamically ---
function buildModelMenu() {
    const currentModel = modelText.textContent;
    modelMenu.innerHTML = '<div class="dropdown-title">Model</div>';
    MODELS.forEach(item => {
        const isActive = item.name === currentModel;
        const div = document.createElement('div');
        div.className = 'dropdown-option model-option' + (isActive ? ' active' : '');
        div.dataset.value = item.name;
        const badgeHtml = item.badge ? `<span class="model-badge">${item.badge}</span>` : '';
        div.innerHTML = `<span class="model-option-name">${item.name}</span>${badgeHtml}`;
        modelMenu.appendChild(div);
    });
}

modelBtn.addEventListener('click', () => {
    buildModelMenu();
    toggleDropdown(modelMenu, modelBtn);
});

modelMenu.addEventListener('click', async (e) => {
    const opt = e.target.closest('.dropdown-option');
    if (!opt) return;
    const model = opt.dataset.value;
    if (!model) return;
    closeAllDropdowns();

    const prev = modelText.textContent;
    modelText.textContent = 'Setting...';
    try {
        const res = await fetchWithAuth('/set-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
        });
        const data = await res.json();
        if (data.success) {
            modelText.textContent = model;
        } else {
            alert('Error: ' + (data.error || 'Unknown'));
            modelText.textContent = prev;
        }
    } catch (e) {
        modelText.textContent = prev;
    }
});

// --- Viewport / Keyboard Handling ---
// This fixes the issue where the keyboard hides the input or layout breaks
if (window.visualViewport) {
    function handleResize() {
        // Resize the body to match the visual viewport (screen minus keyboard)
        document.body.style.height = window.visualViewport.height + 'px';

        // Scroll to bottom if keyboard opened
        if (document.activeElement === messageInput) {
            setTimeout(scrollToBottom, 100);
        }
    }

    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', handleResize);
    handleResize(); // Init
} else {
    // Fallback for older browsers without visualViewport support
    window.addEventListener('resize', () => {
        document.body.style.height = window.innerHeight + 'px';
    });
    document.body.style.height = window.innerHeight + 'px'; // Init
}

// --- Remote Click Logic (Thinking/Thought) ---
chatContainer.addEventListener('click', async (e) => {
    // Strategy: Check if the clicked element OR its parent contains "Thought" or "Thinking" text.
    // This handles both opening (collapsed) and closing (expanded) states.

    // 1. Find the nearest container that might be the "Thought" block
    const target = e.target.closest('div, span, p, summary, button, details');
    if (!target) return;

    const text = target.innerText || '';

    // Check if this looks like a thought toggle (matches "Thought for Xs" or "Thinking" patterns)
    // Also match the header of expanded thoughts which may have more content
    const isThoughtToggle = /Thought|Thinking/i.test(text) && text.length < 500;

    if (isThoughtToggle) {
        // Visual feedback - briefly dim the clicked element
        target.style.opacity = '0.5';
        setTimeout(() => target.style.opacity = '1', 300);

        // Extract just the first line for matching (e.g., "Thought for 3s")
        const firstLine = text.split('\n')[0].trim();

        // Determine which occurrence of this text the user tapped
        // This handles multiple Thought blocks with identical labels
        const allElements = chatContainer.querySelectorAll(target.tagName.toLowerCase());
        let tapIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const elText = el.innerText || '';
            const elFirstLine = elText.split('\n')[0].trim();

            // Only count if it looks like a thought toggle and matches the first line exactly
            if (/Thought|Thinking/i.test(elText) && elText.length < 500 && elFirstLine === firstLine) {
                // If this is our target (or contains it), we've found the correct index
                if (el === target || el.contains(target)) {
                    break;
                }
                tapIndex++;
            }
        }

        try {
            const response = await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: target.tagName.toLowerCase(),
                    index: tapIndex,
                    textContent: firstLine  // Use first line for more reliable matching
                })
            });

            // Reload snapshot multiple times to catch the UI change
            // Desktop animation takes time, so we poll a few times
            setTimeout(loadSnapshot, 400);   // Quick check
            setTimeout(loadSnapshot, 800);   // After animation starts
            setTimeout(loadSnapshot, 1500);  // After animation completes
        } catch (e) {
            console.error('Remote click failed:', e);
        }
        return;
    }

    // --- Command Action Buttons (Run / Reject) ---
    const btn = e.target.closest('button');
    if (btn) {
        const btnText = (btn.innerText || '').trim();
        // Match "Run", "Run Alt+⏎", "Reject"
        const isRun = /^Run/i.test(btnText);
        const isReject = /^Reject$/i.test(btnText);

        if (isRun || isReject) {
            btn.style.opacity = '0.5';
            setTimeout(() => btn.style.opacity = '1', 300);

            // Determine which occurrence of this button text the user tapped
            const label = isRun ? 'Run' : 'Reject';
            const allButtons = Array.from(chatContainer.querySelectorAll('button'));

            // Filter to only those that match our specific label (to handle multiple commands)
            const matchingButtons = allButtons.filter(b => (b.innerText || '').includes(label));
            const btnIndex = matchingButtons.indexOf(btn);

            try {
                await fetchWithAuth('/remote-click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selector: 'button',
                        index: btnIndex >= 0 ? btnIndex : 0,
                        textContent: label
                    })
                });
                setTimeout(loadSnapshot, 500);
                setTimeout(loadSnapshot, 1500);
                setTimeout(loadSnapshot, 3000);
            } catch (err) {
                console.error('Remote command click failed:', err);
            }
        }
    }
});

// --- Init ---
connectWebSocket();
// Sync state initially and every 5 seconds to keep phone in sync with desktop changes
fetchAppState();
setInterval(fetchAppState, 5000);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, 10000); // Check every 10 seconds

// --- QR Code Modal ---
const qrBtn = document.getElementById('qrBtn');
const qrOverlay = document.getElementById('qrOverlay');
const qrCloseBtn = document.getElementById('qrCloseBtn');
const qrImage = document.getElementById('qrImage');
const qrUrl = document.getElementById('qrUrl');
const qrLoading = document.getElementById('qrLoading');

if (qrBtn) {
    qrBtn.addEventListener('click', async () => {
        qrOverlay.classList.add('open');
        qrImage.style.display = 'none';
        qrUrl.textContent = '';
        qrLoading.style.display = 'flex';

        try {
            const res = await fetchWithAuth('/qr-info');
            const data = await res.json();

            qrImage.src = data.qrDataUrl;
            qrImage.style.display = 'block';
            qrUrl.textContent = data.connectUrl;
            qrLoading.style.display = 'none';
        } catch (e) {
            qrLoading.innerHTML = '<p style="color: var(--error)">Failed to generate QR code</p>';
            console.error('[QR] Error:', e);
        }
    });
}

if (qrCloseBtn) {
    qrCloseBtn.addEventListener('click', () => {
        qrOverlay.classList.remove('open');
    });
}

if (qrOverlay) {
    qrOverlay.addEventListener('click', (e) => {
        if (e.target === qrOverlay) qrOverlay.classList.remove('open');
    });
}

// Copy URL on click
if (qrUrl) {
    qrUrl.addEventListener('click', async () => {
        const url = qrUrl.textContent;
        if (url) {
            const ok = await copyToClipboard(url);
            if (ok) {
                const orig = qrUrl.textContent;
                qrUrl.textContent = '✓ Copied!';
                setTimeout(() => { qrUrl.textContent = orig; }, 1500);
            }
        }
    });
}

