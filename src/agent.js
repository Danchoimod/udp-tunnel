const fs = require("fs");
const net = require("net");
const tls = require("tls");
const dgram = require("dgram");
const path = require("path");
const {
  encodeJson,
  encodeUdpFromAgent,
  createBinaryParser,
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

    const host = config.localUdpHost || config.localHost || "127.0.0.1";
    localSocket = dgram.createSocket("udp4");
    localSocket.targetPort = config.localUdpPort || localPort;
    localSocket.targetHost = host;

    localSocket.on("message", (payload) => {
      if (!controlSocket || !authenticated) return;
      touchSession(sessionId);
      controlSocket.write(encodeUdpFromAgent(sessionId, payload));
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
    
    const options = {
      host: config.serverHost,
      port: config.serverControlPort,
      rejectUnauthorized: config.sslRejectUnauthorized !== undefined ? config.sslRejectUnauthorized : false,
    };

    const socketToUse = config.useTLS ? tls : net;
    const socket = socketToUse.connect(options, () => {
      console.log(`Connected to tunnel server (${config.useTLS ? "TLS" : "TCP"})`);
      socket.write(encodeJson({
        type: "AUTH",
        token: config.authToken,
        clientName: config.clientName || "multi-port-agent",
      }));
    });

    controlSocket = socket;

    const parseChunk = createBinaryParser((msg) => {
      if (msg.type === "JSON") {
        const payload = msg.payload;
        if (payload.type === "AUTH_OK") { 
          authenticated = true; 
          console.log("Authorized"); 
        } else if (payload.type === "PING") { 
          socket.write(encodeJson({ type: "PONG" })); 
        }
      } else if (msg.type === "UDP_TO_AGENT") {
        if (!authenticated) return;
        const { sessionId, localPort, payload } = msg;
        touchSession(sessionId);
        const localSocket = getOrCreateLocalSocket(sessionId, localPort);
        if (localSocket) {
          if (!localSocket.logged) {
            console.log(`[UDP] New session ${sessionId.substring(0,8)}... for port ${localSocket.targetPort}`);
            localSocket.logged = true;
          }
          localSocket.send(payload, localSocket.targetPort, localSocket.targetHost, (err) => {
            if (err) console.error(`[UDP] Error sending to local:`, err.message);
          });
        }
      }
    }, (err) => {
      console.error("Protocol error:", err.message);
      socket.destroy();
    });

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

const configFilePath = process.argv[2] || "configs/agent.config.json";
const config = loadConfig(configFilePath);
startAgent(config);
