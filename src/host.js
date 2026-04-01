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
const EXPLORER_GUID = crypto.randomBytes(8).readBigUInt64LE();

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

  // --- AUTO-DISCOVERY (KAMI/OMLET STYLE) ---
  const explorer = dgram.createSocket("udp4");
  let worldActive = false;

  function sendDiscoveryPing() {
    try {
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00]), // ptype = 0 (Discovery Request)
        Buffer.alloc(8),           // guid placeholder
        Buffer.alloc(8)            // padding
      ]);
      body.writeBigUInt64LE(EXPLORER_GUID, 2);
      
      const raw = Buffer.concat([
        Buffer.from([0x14, 0x00]), // Length = 20 (LE)
        body
      ]);
      
      const hmac = crypto.createHmac('sha256', NETHERNET_KEY);
      const checksum = hmac.update(raw).digest();
      const cipher = crypto.createCipheriv('aes-256-ecb', NETHERNET_KEY, null);
      cipher.setAutoPadding(true);
      const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
      const packet = Buffer.concat([checksum, encrypted]);

      explorer.send(packet, config.localUdpPort || 7551, config.localHost || "127.0.0.1");
    } catch (e) {}
  }

  explorer.on("message", (payload) => {
    if (payload.length < 34) return;
    try {
      const encrypted = payload.subarray(32);
      const decipher = crypto.createDecipheriv('aes-256-ecb', NETHERNET_KEY, null);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      
      if (decrypted.length >= 20 && decrypted.readUInt16LE(2) === 1) { 
          let offset = 24; // Skip header and length prefix (4 bytes)
          const inner = decrypted.subarray(offset);
          let pos = 1; // skip version
          
          const readStr = () => {
             const len = inner[pos++];
             const str = inner.subarray(pos, pos + len).toString('utf8');
             pos += len;
             return str;
          };

          const serverName = readStr();
          const levelName = readStr();
          const gameType = inner[pos++];
          const playerCount = inner.readInt32LE(pos); pos += 4;
          const maxPlayers = inner.readInt16LE(pos); pos += 2;

          if (!worldActive) {
            console.log(`\n\x1b[1m\x1b[35m[OMLET] Found Minecraft World: \x1b[32m${serverName}\x1b[0m \x1b[33m(${playerCount}/${maxPlayers})\x1b[0m`);
            worldActive = true;
          }

          if (controlSocket && authenticated) {
            controlSocket.write(encodeJson({ 
              type: "WORLD_INFO", 
              serverName, levelName, playerCount, maxPlayers 
            }));
          }
      }
    } catch (e) {}
  });

  setInterval(sendDiscoveryPing, 2000);

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

    const host = config.localUdpHost || config.localHost || "127.0.0.1";
    localSocket = dgram.createSocket("udp4");
    localSocket.targetPort = localPort || config.localUdpPort || 19132;
    localSocket.targetHost = host;

    localSocket.on("message", (payload) => {
      if (!controlSocket || !authenticated) return;
      touchSession(sessionId);
      controlSocket.write(encodeUdpFromAgent(sessionId, payload));
    });

    localSocket.on("error", (error) => {
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
      console.log(`\x1b[36mConnected to VPS (${config.useTLS ? "TLS" : "TCP"})\x1b[0m`);
      socket.write(encodeJson({
        type: "AUTH",
        token: config.authToken,
        clientName: config.clientName || "multi-host",
      }));
    });

    controlSocket = socket;

    const parseChunk = createBinaryParser((msg) => {
      if (msg.type === "JSON") {
        const payload = msg.payload;
        if (payload.type === "AUTH_OK") { 
          authenticated = true; 
          console.log("\x1b[32mAuthorized & Ready to host\x1b[0m"); 
        } else if (payload.type === "PING") { 
          socket.write(encodeJson({ type: "PONG" })); 
        }
      } else if (msg.type === "UDP_TO_AGENT") {
        if (!authenticated) return;
        touchSession(msg.sessionId);
        const localSocket = getOrCreateLocalSocket(msg.sessionId, msg.localPort);
        if (localSocket) {
          localSocket.send(msg.payload, localSocket.targetPort, localSocket.targetHost);
        }
      }
    }, (err) => {
      socket.destroy();
    });

    socket.on("data", parseChunk);
    socket.on("close", () => {
      controlSocket = null;
      authenticated = false;
      console.warn("Disconnected, retrying in 3s...");
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
