const fs = require("fs");
const net = require("net");
const dgram = require("dgram");
const path = require("path");
const { encodeMessage, createLineParser } = require("./common/protocol");

function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
}

function startAgent(config) {
  let controlSocket = null;
  let authenticated = false;
  let reconnectTimer = null;

  const localSocketsBySession = new Map();
  const sessionLastSeen = new Map();
  const sessionErrorCooldown = new Map();

  function touchSession(sessionId) {
    sessionLastSeen.set(sessionId, Date.now());
  }

  function closeLocalSession(sessionId) {
    const localSocket = localSocketsBySession.get(sessionId);
    if (!localSocket) return;
    try { localSocket.close(); } catch (e) {}
    localSocketsBySession.delete(sessionId);
    sessionLastSeen.delete(sessionId);
  }

  function getOrCreateLocalSocket(sessionId, localPort) {
    let localSocket = localSocketsBySession.get(sessionId);
    if (localSocket) return localSocket;

    const lastError = sessionErrorCooldown.get(sessionId);
    if (lastError && Date.now() - lastError < 5000) return null;

    if (localSocketsBySession.size > 200) {
      console.warn("[Agent] Too many sessions");
      return null;
    }

    const host = config.localHost || "127.0.0.1";
    localSocket = dgram.createSocket("udp4");
    localSocket.targetPort = localPort;
    localSocket.targetHost = host;

    localSocket.on("message", (payload) => {
      if (!controlSocket || !authenticated) return;
      touchSession(sessionId);
      controlSocket.write(encodeMessage({
        type: "UDP_FROM_LOCAL",
        sessionId,
        payloadBase64: payload.toString("base64"),
      }));
    });

    localSocket.on("error", (error) => {
      console.error(`[UDP ${localPort}] error:`, error.message);
      sessionErrorCooldown.set(sessionId, Date.now());
      closeLocalSession(sessionId);
    });

    localSocketsBySession.set(sessionId, localSocket);
    return localSocket;
  }

  function connectControl() {
    authenticated = false;
    const socket = net.createConnection({
      host: config.serverHost,
      port: config.serverControlPort,
    }, () => {
      console.log("Connected to tunnel server");
      socket.write(encodeMessage({
        type: "AUTH",
        token: config.authToken,
        clientName: config.clientName || "multi-port-agent",
      }));
    });

    controlSocket = socket;

    const parseChunk = createLineParser((msg) => {
      if (msg.type === "AUTH_OK") { authenticated = true; console.log("Authorized"); }
      else if (msg.type === "PING") { socket.write(encodeMessage({ type: "PONG" })); }
      else if (msg.type === "UDP_TO_LOCAL") {
        if (!authenticated) return;
        const { sessionId, localPort, payloadBase64 } = msg;
        touchSession(sessionId);
        const localSocket = getOrCreateLocalSocket(sessionId, localPort);
        if (localSocket) {
          localSocket.send(Buffer.from(payloadBase64, "base64"), localSocket.targetPort, localSocket.targetHost);
        }
      }
    }, (err) => console.error("Control error:", err.message));

    socket.on("data", parseChunk);
    socket.on("error", (err) => console.error("Control error:", err.message));
    socket.on("close", () => {
      controlSocket = null;
      authenticated = false;
      console.warn("Disconnected");
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connectControl(); }, 3000);
    });
  }

  setInterval(() => {
    const now = Date.now();
    for (const [sid, last] of sessionLastSeen) {
      if (now - last > (config.sessionIdleTimeoutMs || 60000)) closeLocalSession(sid);
    }
  }, config.maintenanceIntervalMs || 10000);

  connectControl();
}

const config = loadConfig(process.argv[2]);
startAgent(config);
