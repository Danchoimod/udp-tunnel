# Minecraft Bedrock UDP Tunnel (Node.js)

Backend tunnel UDP cho Minecraft Bedrock, lấy ý tưởng kiến trúc từ `frp`:

- **Tunnel Server**: chạy trên máy có public IP.
- **Tunnel Agent**: chạy cùng mạng LAN với Bedrock server.
- Người chơi gửi UDP tới public server, server forward qua kênh control tới agent, agent đẩy vào Bedrock local và trả ngược lại.

## Luong du lieu

1. Player -> `publicUdpPort` trên server.
2. Server map session theo `player_ip:player_port`.
3. Server gui goi UDP qua ket noi TCP control den agent.
4. Agent gui den Bedrock local (`localUdpHost:localUdpPort`).
5. Response tu Bedrock duoc agent gui nguoc lai server.
6. Server tra lai dung player session.

## Cau truc

- `src/server.js`: tunnel backend cong khai (UDP ingress + TCP control).
- `src/agent.js`: client agent noi bo.
- `src/common/protocol.js`: JSON-lines protocol.
- `configs/server.config.json`: config server mau.
- `configs/agent.config.json`: config agent mau.

## Yeu cau

- Node.js 18+.
- Mo firewall:
  - VPS/server: UDP `publicUdpPort`, TCP `controlPort`.
  - LAN machine: outbound TCP den `serverHost:serverControlPort`.

## Cau hinh nhanh

1. Sua `configs/server.config.json`:
   - `publicUdpPort`: cong public cho Minecraft BE (thuong `19132`).
   - `controlPort`: cong control cho agent.
   - `authToken`: token xac thuc chung.

2. Sua `configs/agent.config.json`:
   - `serverHost`: IP/domain cua tunnel server.
   - `serverControlPort`: trung `controlPort`.
   - `authToken`: trung voi server.
   - `localUdpHost/localUdpPort`: Bedrock server noi bo (thuong `127.0.0.1:19132`).

## Chay

### Tren public server

```bash
npm run start:server
```

### Tren may LAN co Bedrock server

```bash
npm run start:agent
```

Nguoi choi ket noi den:

- Host: IP/domain public server
- Port: `publicUdpPort` (vd `19132`)

## Ghi chu bao mat va van hanh

- Doi `authToken` manh va khong commit token that.
- Dat tunnel server sau firewall, chi mo port can thiet.
- Day la UDP tunnel can ban, chua co:
  - ma hoa end-to-end packet payload,
  - dashboard/metrics,
  - multi-agent load balancing.

## Lien he voi frp

Project nay hoc theo mo hinh frp (server-client, auth, mapping session, keepalive), nhung duoc toi gian hoa de phuc vu rieng Minecraft Bedrock UDP.

- frp repo: [fatedier/frp](https://github.com/fatedier/frp)
