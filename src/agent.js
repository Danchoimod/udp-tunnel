const fs = require("fs");
const net = require("net");
const dgram = require("dgram");
const path = require("path");
const { encodeMessage, createLineParser } = require("./common/protocol");

function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  return JSON.parse(raw);
}

function startAgent(config) {
  let controlSocket = null;
  let authenticated = false;
  let reconnectTimer = null;

  const localSocketsBySession = new Map();
  const sessionLastSeen = new Map();

  function touchSession(sessionId) {
    sessionLastSeen.set(sessionId, Date.now());
  }

  function closeLocalSession(sessionId) {
    const localSocket = localSocketsBySession.get(sessionId);
    if (!localSocket) {
      return;
    }
    try {
      localSocket.close();
    } catch (error) {
      console.error("Error closing local UDP socket:", error.message);
    }
    localSocketsBySession.delete(sessionId);
    sessionLastSeen.delete(sessionId);
  }

  function getOrCreateLocalSocket(sessionId) {
    let localSocket = localSocketsBySession.get(sessionId);
    if (localSocket) {
      return localSocket;
    }

    localSocket = dgram.createSocket("udp4");
    localSocket.on("message", (payload) => {
      if (!controlSocket || !authenticated) {
        return;
      }
      touchSession(sessionId);
      controlSocket.write(
        encodeMessage({
          type: "UDP_FROM_LOCAL",
          sessionId,
          payloadBase64: payload.toString("base64"),
        })
      );
    });
    localSocket.on("error", (error) => {
      console.error(`Local socket error (${sessionId}):`, error.message);
      closeLocalSession(sessionId);
    });

    localSocket.bind(0, "0.0.0.0", () => {
      // connect narrows packets to local minecraft service only
      localSocket.connect(config.localUdpPort, config.localUdpHost);
    });

    localSocketsBySession.set(sessionId, localSocket);
    return localSocket;
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectControl();
    }, config.reconnectMs || 3_000);
  }

  function connectControl() {
    authenticated = false;

    const socket = net.createConnection(
      {
        host: config.serverHost,
        port: config.serverControlPort,
      },
      () => {
        console.log("Connected to tunnel server");
        socket.setKeepAlive(true, 20_000);
        socket.write(
          encodeMessage({
            type: "AUTH",
            token: config.authToken,
            clientName: config.clientName || "bedrock-agent",
          })
        );
      }
    );

    controlSocket = socket;

    const parseChunk = createLineParser(
      (msg) => {
        if (!msg || typeof msg !== "object") {
          return;
        }

        if (msg.type === "AUTH_OK") {
          authenticated = true;
          console.log("Agent authenticated");
          return;
        }

        if (msg.type === "AUTH_FAIL") {
          console.error("Authentication failed:", msg.reason || "unknown");
          socket.destroy();
          return;
        }

        if (msg.type === "PING") {
          socket.write(encodeMessage({ type: "PONG", ts: Date.now() }));
          return;
        }

        if (msg.type === "UDP_TO_LOCAL") {
          if (!authenticated) {
            return;
          }
          const { sessionId, payloadBase64 } = msg;
          if (typeof sessionId !== "string" || typeof payloadBase64 !== "string") {
            return;
          }

          touchSession(sessionId);
          const localSocket = getOrCreateLocalSocket(sessionId);
          const payload = Buffer.from(payloadBase64, "base64");
          localSocket.send(payload);
        }
      },
      (error) => {
        console.error("Invalid control message:", error.message);
      }
    );

    socket.on("data", parseChunk);
    socket.on("error", (error) => {
      console.error("Control socket error:", error.message);
    });
    socket.on("close", () => {
      if (controlSocket === socket) {
        controlSocket = null;
        authenticated = false;
      }
      console.warn("Disconnected from tunnel server");
      scheduleReconnect();
    });
  }

  setInterval(() => {
    const now = Date.now();
    const staleMs = config.sessionIdleTimeoutMs || 60_000;
    for (const [sessionId, lastSeen] of sessionLastSeen.entries()) {
      if (now - lastSeen > staleMs) {
        closeLocalSession(sessionId);
      }
    }
  }, config.maintenanceIntervalMs || 10_000);

  connectControl();
}

function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node src/agent.js <config-path>");
    process.exit(1);
  }

  const config = loadConfig(configPath);
  startAgent(config);
}

main();
