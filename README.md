# AntigravityHub 📱

Remote access Antigravity AI từ điện thoại của bạn qua trình duyệt web.

## Tính năng

- 🖥️ **Mirror màn hình** - Xem giao diện Antigravity real-time trên điện thoại
- 👆 **Touch controls** - Tap để click, swipe để scroll
- ⌨️ **Keyboard input** - Gõ text và gửi phím tắt từ mobile
- 📡 **Live streaming** - Chế độ stream liên tục với FPS tuỳ chỉnh
- 📱 **QR Code** - Scan QR để kết nối nhanh từ điện thoại
- 🌙 **Dark theme** - Giao diện tối giống Antigravity
- 🔍 **Auto-detect** - Tự tìm CDP port từ Antigravity

## Cách dùng

### Bước 1: Khởi chạy Antigravity với CDP

**Cách đơn giản:** Dùng script kèm theo
```bash
restart-antigravity.bat
```

**Cách thủ công:** Đóng Antigravity rồi mở lại với flag:
```bash
"C:\Users\<User>\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=9333
```

### Bước 2: Chạy server
```bash
# Cách 1: Script (tự cài dependencies)
start.bat

# Cách 2: npm
npm install
npm start
```

### Bước 3: Kết nối từ điện thoại
- Scan QR code hiện trên terminal
- Hoặc mở `http://<IP-máy-tính>:3000` trên trình duyệt điện thoại

## Controls trên Mobile

| Nút | Chức năng |
|---|---|
| 📹 Video | Bật/tắt live stream |
| ← Back | Phím Escape |
| 🏠 Home | Ctrl+Shift+P (Command Palette) |
| Tab | Phím Tab |
| Enter | Phím Enter |
| ↩ Undo | Ctrl+Z |
| ⌨️ Keyboard | Mở bàn phím ảo |

## Cấu hình

| Biến môi trường | Mặc định | Mô tả |
|---|---|---|
| `PORT` | 3000 | Port web server |
| `CDP_PORT` | Auto-detect | Port CDP (auto từ DevToolsActivePort) |
| `CDP_HOST` | localhost | Host CDP |
| `QUALITY` | 60 | Chất lượng ảnh JPEG (1-100) |
| `MAX_FPS` | 15 | FPS tối đa khi streaming |

## Kiến trúc

```
Phone Browser ←→ WebSocket ←→ Node.js Server ←→ CDP ←→ Antigravity
```

- **Server**: Express + WebSocket + chrome-remote-interface
- **Client**: HTML5 + Touch Events + Material Icons
- **Protocol**: Chrome DevTools Protocol (CDP)

## Lưu ý quan trọng

- Antigravity **phải** được khởi chạy với `--remote-debugging-port` để expose CDP
- Server tự auto-detect port từ file `%APPDATA%\Antigravity\DevToolsActivePort`
- Điện thoại và máy tính phải cùng mạng WiFi
