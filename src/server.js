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
  const raw = fs.readFileSync(path.resolve(process.cwd(), configPath), "utf8");
  return JSON.parse(raw);
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

    udpSockets.set(localPort, udpSocket);
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
        }
      } else if (msg.type === "UDP_FROM_AGENT") {
        const remote = remoteBySession.get(msg.sessionId);
        if (remote) {
          touchSession(msg.sessionId);
          const socketToUse = udpSockets.get(remote.localPort);
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
}

const config = loadConfig(process.argv[2]);
startServer(config);
