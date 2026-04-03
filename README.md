# 🎮 Bedrock UDP Tunnel

> **UDP tunnel hiệu năng cao cho Minecraft Bedrock Edition**, lấy cảm hứng kiến trúc từ [frp](https://github.com/fatedier/frp) — cho phép host server Minecraft Bedrock ở mạng LAN không cần public IP.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)
![License](https://img.shields.io/badge/License-ISC-blue)
![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows%20%7C%20macOS-lightgrey)

---

## 📖 Tổng quan

Bedrock UDP Tunnel giải quyết vấn đề: **Minecraft Bedrock dùng UDP**, nhưng phần lớn người chơi không có public IP để mở server cho bạn bè vào.

Kiến trúc gồm hai thành phần chính:

| Thành phần | Vị trí | Vai trò |
|---|---|---|
| **Tunnel Server** | VPS / máy có public IP | Nhận kết nối UDP từ người chơi, relay qua kênh TCP đến Agent |
| **Tunnel Agent (Host)** | Máy LAN chạy Bedrock server | Kết nối ra Server, nhận/gửi gói tin UDP tới Bedrock local |

```
[Người chơi] --UDP--> [Tunnel Server (VPS)] --TCP Control--> [Tunnel Agent (LAN)]
                                                                        |
                                                               [Bedrock Server :19132]
```

---

## ✨ Tính năng

- 🔒 **Xác thực `authToken`** — chặn agent lạ kết nối vào server
- 🔄 **Tự động reconnect** — agent tự kết nối lại khi mất kết nối
- 🗺️ **Multi-client** — một server có thể phục vụ nhiều Bedrock host song song
- 📡 **Dynamic NAT support** — cập nhật địa chỉ UDP agent tự động
- 💓 **Heartbeat ping/pong** — phát hiện và dọn dẹp kết nối chết
- 🧹 **UDP session idle timeout** — tự dọn session không hoạt động sau 60 giây
- 📊 **Live Dashboard** — hiển thị trạng thái, traffic, uptime trên terminal
- 🔌 **TCP tunnel** — hỗ trợ thêm tunnel TCP nếu cần (tùy chọn)

---

## 🗂️ Cấu trúc dự án

```
udp-tunnel/
├── src/
│   ├── server.js          # Tunnel Server — chạy trên VPS
│   ├── host.js            # Tunnel Agent — chạy trên máy LAN
│   ├── client.js          # Simple UDP proxy client (chế độ client đơn giản)
│   └── common/
│       └── protocol.js    # Giao thức nhị phân UDP + JSON-lines TCP
├── configs/
│   ├── server.config.json # Cấu hình Server mẫu
│   ├── agent.config.json  # Cấu hình Agent mẫu
│   └── client.config.json # Cấu hình Client mẫu
├── index.js               # Entry point (launcher)
└── package.json
```

---

## ⚙️ Yêu cầu

- **Node.js 18+**
- Firewall cần mở:
  - **VPS/Server**: UDP + TCP port `controlPort` (mặc định `25284`), UDP `publicPort` của từng Bedrock host
  - **Máy LAN**: outbound TCP đến `serverHost:serverControlPort`

---

## 🚀 Cài đặt & Chạy nhanh

### 1. Clone và cài đặt

```bash
git clone https://github.com/Danchoimod/udp-tunnel.git
cd udp-tunnel
npm install
```

### 2. Cấu hình Server (trên VPS)

Chỉnh `configs/server.config.json`:

```json
{
  "publicBindAddr": "0.0.0.0",
  "controlBindAddr": "0.0.0.0",
  "controlPort": 25284,
  "pingIntervalMs": 20000,
  "pongTimeoutMs": 45000,
  "authToken": "THAY_BANG_TOKEN_MANH",
  "ports": [
    {
      "publicPort": 25294,
      "clientId": "bedrock-host-1",
      "protocol": "udp"
    },
    {
      "publicPort": 25296,
      "clientId": "bedrock-host-2",
      "protocol": "udp"
    }
  ]
}
```

| Trường | Mô tả |
|---|---|
| `controlPort` | Port TCP để Agent kết nối vào |
| `authToken` | Token xác thực (giống nhau ở Server và Agent) |
| `ports[].publicPort` | Port UDP mà người chơi kết nối vào |
| `ports[].clientId` | ID định danh Agent |

### 3. Cấu hình Agent (trên máy LAN)

Chỉnh `configs/agent.config.json`:

```json
{
  "serverHost": "your-vps-ip-or-domain",
  "serverControlPort": 25284,
  "clientId": "bedrock-host-1",
  "localHost": "127.0.0.1",
  "localUdpPort": 19132,
  "reconnectMs": 3000,
  "authToken": "THAY_BANG_TOKEN_MANH",
  "key": ""
}
```

| Trường | Mô tả |
|---|---|
| `serverHost` | IP hoặc domain của VPS chạy Server |
| `serverControlPort` | Phải trùng với `controlPort` của Server |
| `clientId` | Phải trùng với `clientId` trong cấu hình Server |
| `localUdpPort` | Port UDP của Bedrock server local (thường `19132`) |
| `authToken` | Phải trùng với Server |

### 4. Khởi động

**Trên VPS (Tunnel Server):**

```bash
npm run start:server
```

**Trên máy LAN (Tunnel Agent):**

```bash
npm run start:agent
```

**Người chơi kết nối vào:**
- Host: `<IP/domain VPS>`
- Port: `25294` (hoặc port bạn đã cấu hình)

---

## 📊 Terminal Dashboard

Sau khi khởi động, Server và Agent đều hiển thị dashboard live:

```
══════════════════════════════════════════════════════════════
         BEDROCK TUNNEL SERVER  (LFLauncher)
══════════════════════════════════════════════════════════════
 Uptime      : 0h 5m 12s
 Clients     : 1
 Pending TCP : 0
 UDP sessions: 3
──────────────────────────────────────────────────────────────
 [UDP :25294] ← client_id: bedrock-host-1  ONLINE
 [UDP :25296] ← client_id: bedrock-host-2  WAITING
──────────────────────────────────────────────────────────────
 ▲ Total Up  : 1.24 MB
 ▼ Total Down: 3.57 MB
══════════════════════════════════════════════════════════════
```

---

## 🔌 Giao thức kỹ thuật

### Kênh Control (TCP — JSON-lines)

```
Agent  → Server:  { "type": "register", "key": "", "client_id": "...", "token": "...", "protocol": "udp" }
Server → Agent:   { "type": "registered", "key": "<hex>", "remote_port": 25294 }
Server → Agent:   { "type": "udp_open", "id": "<session_id>", "remote_addr": "1.2.3.4:5678" }
Server → Agent:   { "type": "udp_close", "id": "<session_id>" }
Both:             { "type": "ping" } / { "type": "pong" }
```

### Kênh UDP Data (Binary)

```
[msgType 1B][keyLen 2B BE][key bytes][idLen 2B BE][id bytes][payload]
```

| msgType | Ý nghĩa |
|---|---|
| `1` | HANDSHAKE |
| `2` | DATA |
| `3` | CLOSE |
| `4` | PING |
| `5` | PONG |

---

## 🔒 Bảo mật & Vận hành

- **Đổi `authToken`** thành chuỗi mạnh, ngẫu nhiên — không commit token thật lên git
- **Mở đúng port firewall**: chỉ mở những port cần thiết trên VPS
- Tunnel này **chưa có** mã hóa end-to-end cho payload UDP — không nên dùng để truyền dữ liệu nhạy cảm
- Nếu cần chạy liên tục, dùng **PM2** hoặc **systemd**:

```bash
# PM2
npm install -g pm2
pm2 start "npm run start:server" --name bedrock-tunnel-server
pm2 start "npm run start:agent"  --name bedrock-tunnel-agent
pm2 save
```

---

## 📜 Scripts

| Lệnh | Mô tả |
|---|---|
| `npm run start:server` | Khởi động Tunnel Server |
| `npm run start:agent` | Khởi động Tunnel Agent |
| `npm run start:client` | Khởi động UDP proxy client đơn giản |

---

## 🙏 Credits

Lấy cảm hứng kiến trúc (server-client, auth, session mapping, keepalive) từ:
- [fatedier/frp](https://github.com/fatedier/frp) — Fast Reverse Proxy
