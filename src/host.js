const fs = require("fs");
const net = require("net");
const tls = require("tls");
const dgram = require("dgram");
const path = require("path");
const crypto = require("crypto");
const {
  encodeJson,
  encodeUdpFromAgent,
  encodeDataInit,
  createBinaryParser,
  PACKET_TYPES,
} = require("./common/protocol");

// CLI Params (Kami Style)
const cliPort = process.argv[3] ? parseInt(process.argv[3]) : 19132;
const cliProto = process.argv[4] || 'udp';
const cliHost = process.argv[5] || '127.0.0.1';

// NetherNet constant key
const NETHERNET_KEY = crypto.createHash('sha256').update(Buffer.from([0xEF, 0xBE, 0xAD, 0xDE, 0x00, 0x00, 0x00, 0x00])).digest();
const EXPLORER_GUID = crypto.randomBytes(8).readBigUInt64LE();

function loadConfig(configPath) {
  try {
    const fullPath = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(fullPath)) return { serverHost: "mbasic7.pikamc.vn", serverControlPort: 25284, authToken: "CHANGE_ME_STRONG_TOKEN" };
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (e) {
    return { serverHost: "mbasic7.pikamc.vn", serverControlPort: 25284, authToken: "CHANGE_ME_STRONG_TOKEN" };
  }
}

function startAgent(config) {
  let controlSocket = null;
  let authenticated = false;
  let reconnectTimer = null;

  const localSocketsBySession = new Map();
  const sessionLastSeen = new Map();
  const dataSocketsBySession = new Map();

  // --- PERSISTENT EXPLORER ---
  const explorer = dgram.createSocket("udp4");
  let worldActive = false;
  let lastWorldUpdate = 0;

  function sendDiscoveryPing() {
    try {
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00]), // ptype = 0 (Discovery Request)
        Buffer.alloc(8),           // guid placeholder
        Buffer.alloc(8)            // padding
      ]);
      body.writeBigUInt64LE(EXPLORER_GUID, 2);
      const raw = Buffer.concat([Buffer.from([0x14, 0x00]), body]);
      const hmac = crypto.createHmac('sha256', NETHERNET_KEY);
      const checksum = hmac.update(raw).digest();
      const cipher = crypto.createCipheriv('aes-256-ecb', NETHERNET_KEY, null);
      cipher.setAutoPadding(true);
      const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
      explorer.send(Buffer.concat([checksum, encrypted]), cliPort, cliHost);
    } catch (e) {}
  }

  explorer.on("message", (payload) => {
    if (payload.length < 34) return;
    try {
      const encrypted = payload.subarray(32);
      const decipher = crypto.createDecipheriv('aes-256-ecb', NETHERNET_KEY, null);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      if (decrypted.length >= 24 && decrypted.readUInt16LE(2) === 1) { 
          const innerLen = decrypted.readUInt32LE(20); 
          const inner = decrypted.subarray(24, 24 + innerLen);
          let pos = inner[0] < 32 ? 0 : 1; 
          const readStr = () => {
             if (pos >= inner.length) return "";
             const len = inner[pos++];
             const str = inner.subarray(pos, pos + len).toString('utf8');
             pos += len; return str;
          };
          const sName = readStr();
          const lName = readStr();
          if (pos + 7 > inner.length) return;
          pos++; // skip gameType
          const pCount = inner.readInt32LE(pos); pos += 4;
          const pMax = inner.readInt16LE(pos); pos += 2;
          if (sName && (!worldActive || Date.now() - lastWorldUpdate > 30000)) {
            console.log(`\n\x1b[35m[OMLET]\x1b[0m Hosting: \x1b[1m\x1b[32m${sName}\x1b[0m (\x1b[33m${pCount}/${pMax}\x1b[0m)`);
            worldActive = true;
            lastWorldUpdate = Date.now();
            if (controlSocket && authenticated) {
              controlSocket.write(encodeJson({ type: "WORLD_INFO", serverName: sName, levelName: lName, playerCount: pCount, maxPlayers: pMax }));
            }
          }
      }
    } catch (e) {}
  });

  setInterval(sendDiscoveryPing, 2000);
  
  function createDataConnection(sessionId, localPort) {
    const dataSocket = (config.useTLS ? tls : net).connect({ host: config.serverHost, port: config.serverControlPort }, () => {
      dataSocket.write(encodeDataInit(sessionId));
      console.log(`[DataConn] Session ${sessionId} opened.`);
    });
    
    dataSocketsBySession.set(sessionId, dataSocket);
    
    const parser = createBinaryParser((msg) => {
      if (msg.type === "UDP_TO_AGENT") {
        sessionLastSeen.set(sessionId, Date.now());
        const local = getOrCreateLocalSocket(sessionId, localPort);
        local.send(msg.payload, localPort, cliHost);
      }
    }, (err) => {
      dataSocket.destroy();
    });
    
    dataSocket.on("data", parser);
    dataSocket.on("close", () => {
      dataSocketsBySession.delete(sessionId);
      const local = localSocketsBySession.get(sessionId);
      if (local) {
        local.close();
        localSocketsBySession.delete(sessionId);
      }
    });
    
    return dataSocket;
  }

  function getOrCreateLocalSocket(sessionId, port) {
    let localSocket = localSocketsBySession.get(sessionId);
    if (localSocket) return localSocket;
    localSocket = dgram.createSocket("udp4");
    localSocket.on("message", (payload) => {
      const dataConn = dataSocketsBySession.get(sessionId);
      if (!dataConn) return;
      sessionLastSeen.set(sessionId, Date.now());
      dataConn.write(encodeUdpFromAgent(sessionId, payload));
    });
    localSocketsBySession.set(sessionId, localSocket);
    return localSocket;
  }

  function connectControl() {
    const socket = (config.useTLS ? tls : net).connect({ host: config.serverHost, port: config.serverControlPort }, () => {
      console.log(`\x1b[36mKami Tunnel Active\x1b[0m -> Routing to ${cliHost}:${cliPort} (${cliProto})`);
      socket.write(encodeJson({ type: "AUTH", token: config.authToken, clientName: config.clientName || "multi-host" }));
    });
    socket.on("error", () => {});
    controlSocket = socket;
    const parseChunk = createBinaryParser((msg) => {
      if (msg.type === "JSON") {
        if (msg.payload.type === "AUTH_OK") { authenticated = true; console.log("\x1b[32mTunnel Ready!\x1b[0m"); }
        if (msg.payload.type === "PING") socket.write(encodeJson({ type: "PONG" }));
      } else if (msg.type === "CONTROL_REQUEST_DATA") {
        if (!authenticated) return;
        createDataConnection(msg.sessionId, msg.localPort);
      } else if (msg.type === "UDP_TO_AGENT") {
        // Fallback for non-data connection multiplexing if server still sends it
        sessionLastSeen.set(msg.sessionId, Date.now());
        const local = getOrCreateLocalSocket(msg.sessionId, msg.localPort);
        local.send(msg.payload, msg.localPort, cliHost);
      }
    }, (err) => socket.destroy());
    socket.on("data", parseChunk);
    socket.on("close", () => {
      authenticated = false;
      setTimeout(connectControl, 3000);
    });
  }

  setInterval(() => {
    const now = Date.now();
    for (const [sid, last] of sessionLastSeen) {
      if (now - last > 60000) {
        const s = localSocketsBySession.get(sid);
        if (s) s.close();
        localSocketsBySession.delete(sid);
        sessionLastSeen.delete(sid);
      }
    }
  }, 10000);

  connectControl();
}

const config = loadConfig(process.argv[2] || "configs/agent.config.json");
startAgent(config);
