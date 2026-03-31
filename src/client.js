const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
}

// Biến trạng thái để vẽ Dashboard
const stats = {
  up: 0,
  down: 0,
  totalUp: 0,
  totalDown: 0,
  sessions: 0,
  startTime: Date.now(),
  lastUpdate: Date.now()
};

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function renderDashboard(config) {
  const duration = Math.floor((Date.now() - stats.startTime) / 1000);
  const h = Math.floor(duration / 3600);
  const m = Math.floor((duration % 3600) / 60);
  const s = duration % 60;
  const timeStr = `${h}h ${m}m ${s}s`;

  // Tốc độ hiện tại (bytes per second)
  const now = Date.now();
  const delta = (now - stats.lastUpdate) / 1000;
  const upSpeed = stats.up / (delta || 1);
  const downSpeed = stats.down / (delta || 1);
  
  // Reset nến cho lần sau
  stats.up = 0;
  stats.down = 0;
  stats.lastUpdate = now;

  // Vẽ Dashboard bằng ANSI
  process.stdout.write("\x1b[H\x1b[2J"); // Clear screen
  console.log("\x1b[36m=====================================================\x1b[0m");
  console.log("\x1b[1m\x1b[33m           KAMI-STYLE TUNNEL DASHBOARD              \x1b[0m");
  console.log("\x1b[36m=====================================================\x1b[0m");
  console.log(` Status    : \x1b[32mONLINE\x1b[0m`);
  console.log(` Uptime    : ${timeStr}`);
  console.log(` Sessions  : \x1b[35m${stats.sessions}\x1b[0m active`);
  console.log("\x1b[36m-----------------------------------------------------\x1b[0m");
  
  config.ports.forEach(p => {
    console.log(` Local     : \x1b[33m127.0.0.1:${p.localPort}\x1b[0m`);
    console.log(` Remote    : \x1b[33m${config.serverHost}:${p.remotePort}\x1b[0m`);
  });

  console.log("\x1b[36m-----------------------------------------------------\x1b[0m");
  console.log(` Traffic ▲ : \x1b[32m${formatBytes(upSpeed)}/s\x1b[0m (Total: ${formatBytes(stats.totalUp)})`);
  console.log(` Traffic ▼ : \x1b[31m${formatBytes(downSpeed)}/s\x1b[0m (Total: ${formatBytes(stats.totalDown)})`);
  console.log("\x1b[36m=====================================================\x1b[0m");
  console.log(" Press Ctrl+C to exit...");
}

function startClientProxy(config) {
  config.ports.forEach(p => {
    const clientUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const serverSocketsByPlayer = new Map(); // playerKey -> { socket, lastSeen }
    const SESSION_TIMEOUT = 60000; // 60s idle clean up

    clientUdp.on("message", (msg, rinfo) => {
      const playerAddress = rinfo.address;
      const playerPort = rinfo.port;
      const key = `${playerAddress}:${playerPort}`;
      
      stats.up += msg.length;
      stats.totalUp += msg.length;

      let session = serverSocketsByPlayer.get(key);
      if (session) {
        session.lastSeen = Date.now();
        session.socket.send(msg, p.remotePort, config.serverHost);
        return;
      }

      const serverUdp = dgram.createSocket({ type: "udp4" });
      serverUdp.bind(0, () => {
        serverUdp.on("message", (reply) => {
          stats.down += reply.length;
          stats.totalDown += reply.length;
          clientUdp.send(reply, playerPort, playerAddress);
          const s = serverSocketsByPlayer.get(key);
          if (s) s.lastSeen = Date.now();
        });

        serverUdp.on("error", () => {
          try { serverUdp.close(); } catch (e) {}
          serverSocketsByPlayer.delete(key);
          stats.sessions = serverSocketsByPlayer.size;
        });

        session = { socket: serverUdp, lastSeen: Date.now() };
        serverSocketsByPlayer.set(key, session);
        stats.sessions = serverSocketsByPlayer.size;
        
        serverUdp.send(msg, p.remotePort, config.serverHost);
      });
    });

    clientUdp.on("error", (err) => {
      // dashboard handles showing the online/offline state
    });

    clientUdp.bind(p.localPort, "0.0.0.0", () => {
      // Initial render
      renderDashboard(config);
    });

    setInterval(() => {
      const now = Date.now();
      for (const [key, session] of serverSocketsByPlayer) {
        if (now - session.lastSeen > SESSION_TIMEOUT) {
          try { session.socket.close(); } catch (e) {}
          serverSocketsByPlayer.delete(key);
          stats.sessions = serverSocketsByPlayer.size;
        }
      }
    }, 10000);
  });

  // Cập nhật giao diện mỗi giây
  setInterval(() => renderDashboard(config), 1000);
}

const config = loadConfig(process.argv[2] || "configs/client.config.json");
startClientProxy(config);
