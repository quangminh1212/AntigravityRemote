/**
 * AntigravityHub - VS Code Extension Entry Point
 * Shows QR code in a webview panel so you can access chat from phone
 */
const vscode = require('vscode');
const path = require('path');
const { startServer, stopServer, getServerInfo } = require('./server');
const qrcode = require('qrcode');

let panel = null;
let outputChannel = null;
let statusBarItem = null;

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AntigravityHub');

    // Status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(broadcast) AntigravityHub';
    statusBarItem.tooltip = 'Click to open remote chat';
    statusBarItem.command = 'antigravityhub.start';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register start command
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityhub.start', async () => {
            try {
                // Start server if not running
                const info = await startServer(outputChannel);
                statusBarItem.text = '$(broadcast) Hub: ' + info.port;
                statusBarItem.backgroundColor = undefined;

                // Create or reveal webview panel
                if (panel) {
                    panel.reveal(vscode.ViewColumn.Beside);
                } else {
                    panel = vscode.window.createWebviewPanel(
                        'antigravityhub',
                        'AntigravityHub',
                        vscode.ViewColumn.Beside,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true,
                            localResourceRoots: [
                                vscode.Uri.file(path.join(context.extensionPath, 'public'))
                            ]
                        }
                    );
                    panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'icon.png'));

                    panel.onDidDispose(() => {
                        panel = null;
                    }, null, context.subscriptions);
                }

                // Generate QR code as data URL
                const qrDataUrl = await qrcode.toDataURL(info.url, {
                    width: 280,
                    margin: 2,
                    color: { dark: '#e0e0e0', light: '#1e1e1e' }
                });

                panel.webview.html = getWebviewContent(info, qrDataUrl);
                outputChannel.appendLine(`[INFO] Server running at ${info.url}`);

            } catch (err) {
                vscode.window.showErrorMessage(`AntigravityHub: ${err.message}`);
                outputChannel.appendLine(`[ERROR] ${err.message}`);
            }
        })
    );

    // Register stop command
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityhub.stop', () => {
            stopServer();
            statusBarItem.text = '$(broadcast) AntigravityHub';
            if (panel) {
                panel.dispose();
                panel = null;
            }
            vscode.window.showInformationMessage('AntigravityHub server stopped');
            outputChannel.appendLine('[INFO] Server stopped by user');
        })
    );

    // Auto-start server on activation
    vscode.commands.executeCommand('antigravityhub.start');
}

function deactivate() {
    stopServer();
    if (panel) {
        panel.dispose();
        panel = null;
    }
}

function getWebviewContent(info, qrDataUrl) {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #1e1e1e;
            color: #cccccc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 24px;
        }
        .card {
            background: #252526;
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 12px;
            padding: 32px;
            max-width: 400px;
            width: 100%;
            text-align: center;
        }
        .logo { font-size: 36px; margin-bottom: 8px; }
        h1 {
            font-size: 20px;
            font-weight: 600;
            color: #e0e0e0;
            margin-bottom: 4px;
        }
        .subtitle {
            font-size: 13px;
            color: #888;
            margin-bottom: 24px;
        }
        .qr-container {
            background: #1e1e1e;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 24px;
            display: inline-block;
        }
        .qr-container img {
            width: 240px;
            height: 240px;
            image-rendering: pixelated;
        }
        .instruction {
            font-size: 14px;
            color: #89d185;
            margin-bottom: 16px;
            font-weight: 500;
        }
        .url-box {
            background: #1e1e1e;
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 8px;
            padding: 10px 14px;
            font-family: 'Cascadia Code', 'Fira Code', monospace;
            font-size: 12px;
            color: #0078d4;
            word-break: break-all;
            cursor: pointer;
            transition: background 0.2s;
            margin-bottom: 12px;
        }
        .url-box:hover { background: #2a2d2e; }
        .status {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-size: 12px;
            color: #888;
        }
        .status-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            background: #89d185;
            box-shadow: 0 0 6px #89d185;
        }
        .tip {
            margin-top: 20px;
            font-size: 11px;
            color: #666;
            line-height: 1.5;
        }
        .copied {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%) translateY(-10px);
            background: rgba(37, 37, 38, 0.95);
            color: #89d185;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            opacity: 0;
            transition: all 0.3s;
            pointer-events: none;
        }
        .copied.show {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">⚡</div>
        <h1>AntigravityHub</h1>
        <div class="subtitle">Remote Chat Viewer</div>
        
        <div class="qr-container">
            <img src="${qrDataUrl}" alt="QR Code" />
        </div>
        
        <div class="instruction">📱 Scan QR code with your phone</div>
        
        <div class="url-box" id="urlBox" title="Click to copy">${info.url}</div>
        
        <div class="status">
            <div class="status-dot"></div>
            <span>Server running on port ${info.port}</span>
        </div>
        
        <div class="tip">
            Open the URL on any device connected to the same network.<br/>
            The chat will be mirrored in real-time on your phone.
        </div>
    </div>
    
    <div class="copied" id="copiedToast">✅ URL copied!</div>
    
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('urlBox').addEventListener('click', () => {
            navigator.clipboard.writeText('${info.url}').then(() => {
                const toast = document.getElementById('copiedToast');
                toast.classList.add('show');
                setTimeout(() => toast.classList.remove('show'), 2000);
            });
        });
    </script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
