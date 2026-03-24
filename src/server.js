const fs = require("fs");
const net = require("net");
const dgram = require("dgram");
const crypto = require("crypto");
const path = require("path");
const { encodeMessage, createLineParser } = require("./common/protocol");

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
  const controlServer = net.createServer();
  const udpSockets = new Map(); // localPort -> udpSocket

  let agentSocket = null;
  let agentAuthorized = false;
  let lastPongAt = Date.now();

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

  function touchSession(sessionId) {
    sessionLastSeen.set(sessionId, Date.now());
  }

  function sendToAgent(message) {
    if (!agentSocket || !agentAuthorized) return false;
    agentSocket.write(encodeMessage(message));
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
        sessionByRemote.set(key, sessionId);
        remoteBySession.set(sessionId, {
          address: remoteInfo.address,
          port: remoteInfo.port,
          localPort: localPort,
          publicPort: publicPort
        });
        console.log(`[UDP] New session ${sessionId} for ${key} (Public Port: ${publicPort})`);
      }

      touchSession(sessionId);
      sendToAgent({
        type: "UDP_TO_LOCAL",
        sessionId,
        localPort: localPort,
        payloadBase64: payload.toString("base64"),
      });
    });

    udpSocket.bind(publicPort, config.publicBindAddr || "0.0.0.0", () => {
      console.log(`[UDP] Listener active on port ${publicPort} -> Local ${localPort}`);
    });

    udpSockets.set(localPort, udpSocket);
  });

  function setupAgentSocket(socket) {
    if (agentSocket) agentSocket.destroy();
    agentSocket = socket;
    agentAuthorized = false;
    lastPongAt = Date.now();

    const parseChunk = createLineParser((msg) => {
      if (!agentAuthorized) {
        if (msg.type === "AUTH" && msg.token === config.authToken) {
          agentAuthorized = true;
          socket.write(encodeMessage({ type: "AUTH_OK" }));
          console.log("Agent authorized");
        } else {
          socket.write(encodeMessage({ type: "AUTH_FAIL", reason: "AUTH_FAILED" }));
          socket.destroy();
        }
        return;
      }

      if (msg.type === "PONG") {
        lastPongAt = Date.now();
      } else if (msg.type === "UDP_FROM_LOCAL") {
        const remote = remoteBySession.get(msg.sessionId);
        if (remote) {
          touchSession(msg.sessionId);
          const socketToUse = udpSockets.get(remote.localPort);
          if (socketToUse) {
            socketToUse.send(Buffer.from(msg.payloadBase64, "base64"), remote.port, remote.address);
          }
        }
      }
    }, (err) => console.error("Control error:", err.message));

    socket.on("data", parseChunk);
    socket.on("close", () => { if (agentSocket === socket) agentAuthorized = false; });
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
    if (agentSocket && agentAuthorized) {
      if (now - lastPongAt > (config.agentPongTimeoutMs || 45000)) {
        console.warn("Agent timeout");
        agentSocket.destroy();
      } else {
        sendToAgent({ type: "PING" });
      }
    }
  }, config.maintenanceIntervalMs || 10000);
}

const config = loadConfig(process.argv[2]);
startServer(config);
