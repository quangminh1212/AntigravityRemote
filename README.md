# AntigravityHub v2 - Remote Chat Viewer

📱 Remote access to Antigravity chat on your phone - scan QR code and use immediately.

Like TeamViewer/UltraViewer but specifically for Antigravity's chat interface.

## Quick Start

```bash
# Run
.\run.bat

# Or manually
npm install
node server.js
```

Scan the QR code shown in terminal with your phone → done!

## How It Works

1. **Server** starts on port 3000 and connects to Antigravity via Chrome DevTools Protocol (CDP)
2. **QR Code** is displayed in terminal - scan with your phone's camera
3. **Mobile UI** shows real-time chat view with ability to send messages, scroll, and click
4. **WebSocket** streams UI snapshots from Antigravity to your phone in real-time

## Features

- 📱 Mobile-first responsive design  
- 🔄 Real-time chat sync via WebSocket
- ⌨️ Send messages from phone
- 👆 Touch interactions (click, scroll)
- 🔒 Token-based authentication
- 📷 QR code for easy connection
- 🎨 Dark theme matching Antigravity

## Requirements

- Node.js 18+
- Antigravity running with debug port (9222)

## License

MIT
