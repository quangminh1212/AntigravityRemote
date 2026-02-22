/**
 * Development server with hot-reload for AntigravityHub
 * 
 * Features:
 * 1. esbuild watch mode - auto-rebuild TypeScript on changes
 * 2. File watcher on public/ - sends SSE reload signal to browser
 * 3. Auto-restart server when backend code changes
 * 
 * Usage: npm run dev
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const esbuild = require('esbuild');

// SSE clients for live reload
const sseClients = new Set();

// Track if server needs restart
let server = null;
let serverStarting = false;

// Colors for console
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    dim: '\x1b[2m'
};

function log(icon, msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`${c.dim}${time}${c.reset} ${icon} ${msg}`);
}

// Start/restart the AntigravityServer
async function startServer() {
    if (serverStarting) return;
    serverStarting = true;

    try {
        // Stop existing server
        if (server) {
            log('🔄', `${c.yellow}Restarting server...${c.reset}`);
            try { server.stop(); } catch (e) { }
            server = null;
        }

        // Clear require cache for our modules
        Object.keys(require.cache).forEach(key => {
            if (key.includes(path.join(__dirname, 'out'))) {
                delete require.cache[key];
            }
        });

        const { AntigravityServer } = require('./out/server/index');
        const port = 3000;
        const srv = new AntigravityServer(port, __dirname, __dirname, false);
        const result = await srv.start();
        server = srv;

        log('✅', `${c.green}Server ready${c.reset} → ${c.cyan}${result.localUrl}${c.reset}`);
        log('🔑', `${c.dim}Token: ${result.token}${c.reset}`);
    } catch (err) {
        log('❌', `${c.red}Server error: ${err.message}${c.reset}`);
    }
    serverStarting = false;
}

// Notify all SSE clients to reload
function notifyReload(file) {
    const msg = `data: ${JSON.stringify({ type: 'reload', file })}\n\n`;
    for (const res of sseClients) {
        try { res.write(msg); } catch (e) { sseClients.delete(res); }
    }
    log('🔃', `${c.blue}Live reload${c.reset} → ${c.dim}${file}${c.reset} (${sseClients.size} clients)`);
}

// SSE endpoint for live-reload (injected into index.html)  
function startSSEServer() {
    const sseServer = http.createServer((req, res) => {
        if (req.url === '/__dev_reload') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    sseServer.listen(3001, () => {
        log('📡', `${c.cyan}SSE reload server${c.reset} → http://localhost:3001/__dev_reload`);
    });
}

// Watch public/ for HTML/CSS changes → live reload browser
function watchPublicFiles() {
    const publicDir = path.join(__dirname, 'public');
    let debounce = null;

    fs.watch(publicDir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        if (filename.endsWith('.log')) return;

        clearTimeout(debounce);
        debounce = setTimeout(() => {
            notifyReload(filename);
        }, 200);
    });
    log('👁️', `${c.dim}Watching public/ for changes${c.reset}`);
}

// Main
async function main() {
    console.log(`\n${c.cyan}╔══════════════════════════════════════╗${c.reset}`);
    console.log(`${c.cyan}║  ${c.green}Antigravity Hub - Dev Mode${c.reset}          ${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╚══════════════════════════════════════╝${c.reset}\n`);

    // 1. Start esbuild watch
    log('🔨', `${c.yellow}Starting esbuild watch...${c.reset}`);
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'out/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        sourcemap: true,
        external: ['vscode'],
        logLevel: 'warning',
        plugins: [{
            name: 'rebuild-notify',
            setup(build) {
                build.onEnd(result => {
                    if (result.errors.length === 0) {
                        log('✅', `${c.green}Build OK${c.reset} ${c.dim}(${result.warnings.length} warnings)${c.reset}`);
                        // Auto-restart server when backend changes
                        startServer();
                    } else {
                        log('❌', `${c.red}Build FAILED${c.reset} (${result.errors.length} errors)`);
                    }
                });
            }
        }]
    });
    await ctx.watch();
    log('👁️', `${c.dim}Watching src/ for TypeScript changes${c.reset}`);

    // 2. Start SSE server for live reload
    startSSEServer();

    // 3. Watch public/ files
    watchPublicFiles();

    // 4. Start main server (first build triggers this via plugin)
    await startServer();

    console.log(`\n${c.green}Ready!${c.reset} Open on mobile: ${c.cyan}http://localhost:3000/?token=pwaphqy5pwdvbhcs8qdkr${c.reset}`);
    console.log(`${c.dim}• Edit public/index.html → browser auto-reloads${c.reset}`);
    console.log(`${c.dim}• Edit src/*.ts → auto-rebuild + server restart${c.reset}`);
    console.log(`${c.dim}• Press Ctrl+C to stop\n${c.reset}`);

    process.on('SIGINT', () => {
        log('🛑', 'Shutting down...');
        if (server) server.stop();
        ctx.dispose();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
