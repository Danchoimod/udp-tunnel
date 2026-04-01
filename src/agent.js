const fs = require("fs");
const net = require("net");
const tls = require("tls");
const dgram = require("dgram");
const path = require("path");
const crypto = require("crypto");
const {
  encodeJson,
  encodeUdpFromAgent,
  createBinaryParser,
} = require("./common/protocol");

// NetherNet constant key
const NETHERNET_KEY = crypto.createHash('sha256').update(Buffer.from([0xEF, 0xBE, 0xAD, 0xDE, 0x00, 0x00, 0x00, 0x00])).digest();

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
    // Prioritize port sent from server over local config
    localSocket.targetPort = localPort || config.localUdpPort || 19132;
    localSocket.targetHost = host;
    localSocket.sessionId = sessionId; // Store for logging

    localSocket.on("message", (payload) => {
      if (!controlSocket || !authenticated) return;
      touchSession(sessionId);

      // --- Báo cáo trạng thái kết nối thế giới ---
      if (!localSocket.worldReady) {
        localSocket.worldReady = true;
        console.log(`\x1b[32m[WORLD]\x1b[0m Connection to Bedrock host world established!`);
        controlSocket.write(encodeJson({ type: "STATUS", status: "WORLD_OK", sessionId: sessionId }));
      }
      
      // --- Bedrock Discovery Sniffer (Full NetherNet Decoder) ---
      if (payload.length > 34) {
        try {
          const encrypted = payload.subarray(32);
          if (encrypted.length % 16 === 0) {
            const decipher = crypto.createDecipheriv('aes-256-ecb', NETHERNET_KEY, null);
            decipher.setAutoPadding(false);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            
            if (decrypted.length >= 20) {
              const ptype = decrypted.readUInt16LE(2);
              if (ptype === 1) { // Discovery Response (Pong)
                let pos = 20; // Skip 20 bytes header
                const inner = decrypted.subarray(pos);
                
                // Helper để đọc string kiểu Bedrock: [1 byte len][data]
                let offset = 0;
                const version = inner[offset++];
                
                const readStr = () => {
                   const len = inner[offset++];
                   const str = inner.subarray(offset, offset + len).toString('utf8');
                   offset += len;
                   return str;
                };

                const serverName = readStr();
                const levelName = readStr();
                const gameType = inner[offset++];
                const playerCount = inner.readInt32LE(offset); offset += 4;
                const maxPlayerCount = inner.readInt16LE(offset); offset += 2;

                console.log("\n\x1b[35m" + "=" .repeat(45));
                console.log("\x1b[1m\x1b[33m           TÌM THẤY BEDROCK WORLD!          \x1b[0m");
                console.log("\x1b[35m" + "=" .repeat(45));
                console.log(` \x1b[32m>\x1b[0m Tên Server     : \x1b[1m${serverName}\x1b[0m`);
                console.log(` \x1b[32m>\x1b[0m Thế giới       : \x1b[36m${levelName}\x1b[0m`);
                console.log(` \x1b[32m>\x1b[0m Chế độ chơi    : ${gameType === 1 ? "Creative" : "Survival"}`);
                console.log(` \x1b[32m>\x1b[0m Người chơi     : \x1b[33m${playerCount}/${maxPlayerCount}\x1b[0m`);
                console.log(` \x1b[32m>\x1b[0m Bedrock ID (Pt): \x1b[35m${decrypted.slice(4, 12).toString('hex')}\x1b[0m`); // Log the actual NetherNet GUID
                console.log(` \x1b[32m>\x1b[0m Tunnel Session : ${sessionId.substring(0,8)}`);
                console.log("\x1b[35m" + "=" .repeat(45) + "\x1b[0m\n");
              }
            }
          }
        } catch (e) {}
      }

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
            console.log(`[UDP] New session ${sessionId.substring(0,8)}... -> sending to ${localSocket.targetHost}:${localSocket.targetPort}`);
            localSocket.logged = true;
          }
          localSocket.send(payload, localSocket.targetPort, localSocket.targetHost, (err) => {
            if (err) console.error(`[UDP] Error sending to local (${localSocket.targetHost}:${localSocket.targetPort}):`, err.message);
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
