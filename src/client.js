const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
}

function startClientProxy(config) {
  // Config mẫu: ports: [{ local: 19132, remote: 19132 }, { local: 7551, remote: 7551 }]
  config.ports.forEach(p => {
    const clientUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const serverSocketsByPlayer = new Map(); // playerKey -> { socket, lastSeen }
    const SESSION_TIMEOUT = 60000; // 60s idle clean up

    clientUdp.on("message", (msg, rinfo) => {
      const playerAddress = rinfo.address;
      const playerPort = rinfo.port;
      const key = `${playerAddress}:${playerPort}`;
      
      let session = serverSocketsByPlayer.get(key);
      if (session) {
        session.lastSeen = Date.now();
        session.socket.send(msg, p.remotePort, config.serverHost);
        return;
      }

      const serverUdp = dgram.createSocket({ type: "udp4" });
      serverUdp.bind(0, () => {
        // Sau khi bind thành công mới bắt đầu lắng nghe và đưa vào Map
        serverUdp.on("message", (reply) => {
          clientUdp.send(reply, playerPort, playerAddress);
          const s = serverSocketsByPlayer.get(key);
          if (s) s.lastSeen = Date.now();
        });

        serverUdp.on("error", (err) => {
          console.error(`[Proxy] Server socket error for ${key}:`, err.message);
          try { serverUdp.close(); } catch (e) {}
          serverSocketsByPlayer.delete(key);
        });

        session = { socket: serverUdp, lastSeen: Date.now() };
        serverSocketsByPlayer.set(key, session);
        console.log(`[Proxy] New player session: ${key}`);
        
        serverUdp.send(msg, p.remotePort, config.serverHost);
      });
    });

    clientUdp.on("error", (err) => {
      console.error(`[Proxy] Client socket error on port ${p.localPort}:`, err.message);
    });

    clientUdp.bind(p.localPort, "0.0.0.0", () => {
      console.log(`[Proxy] Local ${p.localPort} <-> Remote ${config.serverHost}:${p.remotePort}`);
    });

    setInterval(() => {
      const now = Date.now();
      for (const [key, session] of serverSocketsByPlayer) {
        if (now - session.lastSeen > SESSION_TIMEOUT) {
          console.log(`[Proxy] Closing idle player session: ${key}`);
          try { session.socket.close(); } catch (e) {}
          serverSocketsByPlayer.delete(key);
        }
      }
    }, 10000);
  });
}

const config = loadConfig(process.argv[2] || "configs/client.config.json");
startClientProxy(config);
