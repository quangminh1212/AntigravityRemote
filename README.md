# AntigravityHub 📱

Remote access Antigravity AI từ điện thoại của bạn qua trình duyệt web.

## Tính năng

- 🖥️ **Mirror màn hình** - Xem giao diện Antigravity real-time trên điện thoại
- 👆 **Touch controls** - Tap để click, swipe để scroll
- ⌨️ **Keyboard input** - Gõ text và gửi phím tắt từ mobile
- 📡 **Live streaming** - Chế độ stream liên tục với FPS tuỳ chỉnh
- 📱 **QR Code** - Scan QR để kết nối nhanh từ điện thoại
- 🌙 **Dark theme** - Giao diện tối giống Antigravity

## Cách dùng

### 1. Khởi chạy Antigravity với CDP
```bash
antigravity --remote-debugging-port=9222
```

### 2. Chạy server
```bash
# Cách 1: Script
start.bat

# Cách 2: npm
npm install
npm start
```

### 3. Kết nối từ điện thoại
- Scan QR code hiện trên terminal
- Hoặc mở `http://<IP-máy-tính>:3000` trên trình duyệt điện thoại

## Cấu hình

| Biến môi trường | Mặc định | Mô tả |
|---|---|---|
| `PORT` | 3000 | Port web server |
| `CDP_PORT` | 9222 | Port CDP của Antigravity |
| `CDP_HOST` | localhost | Host CDP |
| `QUALITY` | 60 | Chất lượng ảnh (1-100) |
| `MAX_FPS` | 15 | FPS tối đa khi streaming |

## Kiến trúc

```
Phone Browser ←→ WebSocket ←→ Node.js Server ←→ CDP ←→ Antigravity
```

- **Server**: Express + WebSocket + chrome-remote-interface
- **Client**: HTML5 Canvas + Touch Events + Material Icons
- **Protocol**: Chrome DevTools Protocol (CDP)
