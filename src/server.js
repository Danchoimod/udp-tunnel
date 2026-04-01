const fs = require("fs");
const net = require("net");
const tls = require("tls");
const dgram = require("dgram");
const crypto = require("crypto");
const path = require("path");
const {
  encodeJson,
  encodeUdpToAgent,
  createBinaryParser,
  PACKET_TYPES,
} = require("./common/protocol");

function loadConfig(configPath) {
  try {
    const fullPath = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`ERROR: Config file not found at: ${fullPath}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (e) {
    console.error(`ERROR loading config: ${e.message}`);
    process.exit(1);
  }
}

// --- Trạng thái ---
const stats = {
  totalRequests: 0,
  activeSessions: 0,
  totalUp: 0,
  totalDown: 0,
  startTime: Date.now()
};

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function renderDashboard(config, agents, sessionByRemote) {
  const duration = Math.floor((Date.now() - stats.startTime) / 1000);
  const timeStr = `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m ${duration % 60}s`;

  process.stdout.write("\x1b[H\x1b[2J");
  console.log("\x1b[36m=====================================================\x1b[0m");
  console.log("\x1b[1m\x1b[35m            BEDROCK TUNNEL SERVER DASHBOARD          \x1b[0m");
  console.log("\x1b[36m=====================================================\x1b[0m");
  console.log(` Status      : \x1b[32mRUNNING\x1b[0m`);
  console.log(` Host        : \x1b[33m${config.publicIP || "localhost"}\x1b[0m`);
  console.log(` Uptime      : ${timeStr}`);
  console.log(` Agents      : \x1b[33m${agents.size}\x1b[0m online`);
  console.log(` Sessions    : \x1b[33m${sessionByRemote.size}\x1b[0m`);
  console.log("\x1b[36m-----------------------------------------------------\x1b[0m");

  console.log(` Control Port: \x1b[32m${config.controlPort}\x1b[0m`);
  config.ports.forEach(p => {
    console.log(` UDP Port    : \x1b[33m${p.publicPort}\x1b[0m (Public) -> Local :${p.localPort}`);
  });

  console.log("\x1b[36m-----------------------------------------------------\x1b[0m");
  console.log(` Total Upload  : \x1b[32m${formatBytes(stats.totalUp)}\x1b[0m (from Agent)`);
  console.log(` Total Download: \x1b[31m${formatBytes(stats.totalDown)}\x1b[0m (from Remote)`);
  console.log("\x1b[36m=====================================================\x1b[0m");
}

function sessionKey(address, port, localPort) {
  return `${address}:${port}:${localPort}`;
}

function randomSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

function startServer(config) {
  let controlServer;
  
  if (config.sslKey && config.sslCert) {
    const options = {
      key: fs.readFileSync(path.resolve(process.cwd(), config.sslKey)),
      cert: fs.readFileSync(path.resolve(process.cwd(), config.sslCert)),
    };
    controlServer = tls.createServer(options);
    console.log("[CONTROL] Using TLS encryption");
  } else {
    controlServer = net.createServer();
    console.log("[CONTROL] Using unencrypted TCP (NOT RECOMMENDED)");
  }
  
  const udpSockets = new Map(); // localPort -> udpSocket

  const agents = new Map(); // clientName -> { socket, lastPongAt }
  
  const sessionByRemote = new Map();
  const remoteBySession = new Map();
  const sessionLastSeen = new Map();

  function cleanupSession(sessionId) {
    const remote = remoteBySession.get(sessionId);
    if (!remote) return;
    sessionByRemote.delete(sessionKey(remote.address, remote.port, remote.localPort));
    remoteBySession.delete(sessionId);
    sessionLastSeen.delete(sessionId);
  }

  function cleanupAgentSessions(agentName) {
    for (const [sid, remote] of remoteBySession) {
      if (remote.agentName === agentName) {
        cleanupSession(sid);
      }
    }
  }

  function touchSession(sessionId) {
    sessionLastSeen.set(sessionId, Date.now());
  }

  function sendToAgent(agentName, message) {
    const agent = agents.get(agentName);
    if (!agent) return false;
    agent.socket.write(encodeJson(message));
    return true;
  }

  // Khởi tạo các cổng UDP dựa trên danh sách mapping
  config.ports.forEach(portMapping => {
    const udpSocket = dgram.createSocket("udp4");
    const publicPort = portMapping.publicPort;
    const localPort = portMapping.localPort;

    udpSocket.on("message", (payload, remoteInfo) => {
      const key = sessionKey(remoteInfo.address, remoteInfo.port, localPort);
      let sessionId = sessionByRemote.get(key);

      if (!sessionId) {
        sessionId = randomSessionId();
        const targetAgentName = portMapping.agentName || "default";
        
        sessionByRemote.set(key, sessionId);
        remoteBySession.set(sessionId, {
          address: remoteInfo.address,
          port: remoteInfo.port,
          localPort: localPort,
          publicPort: publicPort,
          agentName: targetAgentName
        });
        console.log(`[UDP] New session ${sessionId} for ${key} (Public Port: ${publicPort})`);
      }

      stats.totalDown += payload.length;

      touchSession(sessionId);
      
      const targetName = portMapping.agentName || "default";
      const agent = agents.get(targetName);
      if (agent) {
        agent.socket.write(encodeUdpToAgent(sessionId, localPort, payload));
      }
    });

    udpSocket.on("error", (err) => {
      console.error(`[UDP ${publicPort}] error:`, err.message);
    });

    udpSocket.bind(publicPort, config.publicBindAddr || "0.0.0.0", () => {
      console.log(`[UDP] Listener active on port ${publicPort} -> Local ${localPort}`);
    });

    // FIX: Use publicPort as key to avoid conflicts when multiple public ports map to the same localPort
    udpSockets.set(publicPort, udpSocket);
  });

  function setupAgentSocket(socket) {
    const parseChunk = createBinaryParser((msg) => {
      if (msg.type === "JSON") {
        const payload = msg.payload;
        if (!socket.agentName) {
          if (payload.type === "AUTH" && payload.token === config.authToken) {
            const clientName = payload.clientName || "default";
            const existing = agents.get(clientName);
            if (existing) {
              console.log(`Replacing existing agent connection: ${clientName}`);
              existing.socket._replaced = true;
              existing.socket.destroy();
            }
            
            socket.agentName = clientName;
            agents.set(clientName, {
              socket: socket,
              lastPongAt: Date.now()
            });
            
            socket.write(encodeJson({ type: "AUTH_OK" }));
            console.log(`Agent "${clientName}" authorized`);
          } else {
            socket.write(encodeJson({ type: "AUTH_FAIL", reason: "AUTH_FAILED" }));
            socket.destroy();
          }
          return;
        }

        if (payload.type === "PONG") {
          const agent = agents.get(socket.agentName);
          if (agent) agent.lastPongAt = Date.now();
        } else if (payload.type === "STATUS" && payload.status === "WORLD_OK") {
          console.log(`\x1b[32m[WORLD]\x1b[0m Bedrock world connection confirmed from agent "${socket.agentName}" (Session: ${payload.sessionId})`);
        }
      } else if (msg.type === "UDP_FROM_AGENT") {
        const remote = remoteBySession.get(msg.sessionId);
        if (remote) {
          touchSession(msg.sessionId);
          stats.totalUp += msg.payload.length;
          // FIX: Look up by publicPort instead of localPort
          const socketToUse = udpSockets.get(remote.publicPort);
          if (socketToUse) {
            socketToUse.send(msg.payload, remote.port, remote.address);
          }
        }
      }
    }, (err) => {
      console.error("Control error:", err.message);
      socket.destroy();
    });

    socket.on("data", parseChunk);
    socket.on("error", (err) => {
      console.error(`Agent socket error ("${socket.agentName || 'unauthorized'}"):`, err.message);
    });
    socket.on("close", () => {
      if (socket._replaced) return;
      if (socket.agentName && agents.get(socket.agentName)?.socket === socket) {
        const agentName = socket.agentName;
        agents.delete(agentName);
        cleanupAgentSessions(agentName);
        console.warn(`Agent "${agentName}" disconnected, sessions cleared`);
      }
    });
  }

  controlServer.listen(config.controlPort, config.controlBindAddr || "0.0.0.0", () => {
    console.log(`[CONTROL] Server active on port ${config.controlPort}`);
  });

  controlServer.on("connection", setupAgentSocket);

  // Bảo trì session
  setInterval(() => {
    const now = Date.now();
    for (const [sid, last] of sessionLastSeen) {
      if (now - last > (config.sessionIdleTimeoutMs || 60000)) cleanupSession(sid);
    }
    for (const [name, agent] of agents) {
      if (now - agent.lastPongAt > (config.agentPongTimeoutMs || 45000)) {
        console.warn(`Agent "${name}" timeout`);
        agent.socket.destroy();
      } else {
        sendToAgent(name, { type: "PING" });
      }
    }
  }, config.maintenanceIntervalMs || 10000);

  setInterval(() => renderDashboard(config, agents, sessionByRemote), 1000);
}

const configFilePath = process.argv[2] || "configs/server.config.json";
const config = loadConfig(configFilePath);
startServer(config);
