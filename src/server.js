const fs = require("fs");
const net = require("net");
const dgram = require("dgram");
const crypto = require("crypto");
const path = require("path");
const { encodeMessage, createLineParser } = require("./common/protocol");

function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  return JSON.parse(raw);
}

function sessionKey(address, port) {
  return `${address}:${port}`;
}

function randomSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

function startServer(config) {
  const udpSocket = dgram.createSocket("udp4");
  const controlServer = net.createServer();

  let agentSocket = null;
  let agentAuthorized = false;
  let lastPongAt = Date.now();
  let pingTimer = null;

  const sessionByRemote = new Map();
  const remoteBySession = new Map();
  const sessionLastSeen = new Map();

  function cleanupSession(sessionId) {
    const remote = remoteBySession.get(sessionId);
    if (!remote) {
      return;
    }
    sessionByRemote.delete(sessionKey(remote.address, remote.port));
    remoteBySession.delete(sessionId);
    sessionLastSeen.delete(sessionId);
  }

  function touchSession(sessionId) {
    sessionLastSeen.set(sessionId, Date.now());
  }

  function sendToAgent(message) {
    if (!agentSocket || !agentAuthorized) {
      return false;
    }
    agentSocket.write(encodeMessage(message));
    return true;
  }

  function closeAgent(reason) {
    if (!agentSocket) {
      return;
    }

    try {
      agentSocket.destroy();
    } catch (error) {
      console.error("Failed to close agent socket:", error.message);
    }

    agentSocket = null;
    agentAuthorized = false;
    console.warn(`Agent disconnected: ${reason}`);
  }

  function setupAgentSocket(socket) {
    if (agentSocket) {
      closeAgent("replaced by new connection");
    }

    agentSocket = socket;
    agentAuthorized = false;
    lastPongAt = Date.now();

    const parseChunk = createLineParser(
      (msg) => {
        if (!msg || typeof msg !== "object") {
          return;
        }

        if (!agentAuthorized) {
          if (msg.type !== "AUTH") {
            socket.write(encodeMessage({ type: "AUTH_FAIL", reason: "AUTH_REQUIRED" }));
            closeAgent("auth required");
            return;
          }

          if (msg.token !== config.authToken) {
            socket.write(encodeMessage({ type: "AUTH_FAIL", reason: "INVALID_TOKEN" }));
            closeAgent("invalid token");
            return;
          }

          agentAuthorized = true;
          socket.write(encodeMessage({ type: "AUTH_OK" }));
          console.log("Agent authorized");
          return;
        }

        if (msg.type === "PONG") {
          lastPongAt = Date.now();
          return;
        }

        if (msg.type === "UDP_FROM_LOCAL") {
          const { sessionId, payloadBase64 } = msg;
          const remote = remoteBySession.get(sessionId);
          if (!remote) {
            return;
          }
          if (typeof payloadBase64 !== "string") {
            return;
          }

          touchSession(sessionId);
          const payload = Buffer.from(payloadBase64, "base64");
          udpSocket.send(payload, remote.port, remote.address);
          return;
        }
      },
      (error) => {
        console.error("Invalid control message from agent:", error.message);
      }
    );

    socket.on("data", parseChunk);
    socket.on("close", () => {
      if (agentSocket === socket) {
        agentSocket = null;
        agentAuthorized = false;
        console.warn("Agent control connection closed");
      }
    });
    socket.on("error", (error) => {
      console.error("Agent control socket error:", error.message);
    });
  }

  controlServer.on("connection", (socket) => {
    socket.setKeepAlive(true, 20_000);
    console.log("New control connection:", socket.remoteAddress, socket.remotePort);
    setupAgentSocket(socket);
  });

  controlServer.on("error", (error) => {
    console.error("Control server error:", error.message);
  });

  udpSocket.on("message", (payload, remoteInfo) => {
    const key = sessionKey(remoteInfo.address, remoteInfo.port);
    let sessionId = sessionByRemote.get(key);

    if (!sessionId) {
      sessionId = randomSessionId();
      sessionByRemote.set(key, sessionId);
      remoteBySession.set(sessionId, {
        address: remoteInfo.address,
        port: remoteInfo.port,
      });
      console.log(`New UDP session ${sessionId} for ${key}`);
    }

    touchSession(sessionId);

    const sent = sendToAgent({
      type: "UDP_TO_LOCAL",
      sessionId,
      payloadBase64: payload.toString("base64"),
    });

    if (!sent) {
      console.warn("No authorized agent connected; dropping UDP packet");
    }
  });

  udpSocket.on("error", (error) => {
    console.error("UDP socket error:", error.message);
  });

  function startMaintenance() {
    pingTimer = setInterval(() => {
      const now = Date.now();
      const staleMs = config.sessionIdleTimeoutMs || 60_000;

      for (const [sessionId, lastSeen] of sessionLastSeen.entries()) {
        if (now - lastSeen > staleMs) {
          cleanupSession(sessionId);
        }
      }

      if (agentSocket && agentAuthorized) {
        const sinceLastPong = now - lastPongAt;
        if (sinceLastPong > (config.agentPongTimeoutMs || 45_000)) {
          closeAgent("pong timeout");
        } else {
          sendToAgent({ type: "PING", ts: now });
        }
      }
    }, config.maintenanceIntervalMs || 10_000);
  }

  udpSocket.bind(config.publicUdpPort, config.publicBindAddr, () => {
    console.log(
      `UDP tunnel listening on ${config.publicBindAddr}:${config.publicUdpPort}`
    );
  });

  controlServer.listen(config.controlPort, config.controlBindAddr, () => {
    console.log(
      `Control server listening on ${config.controlBindAddr}:${config.controlPort}`
    );
  });

  startMaintenance();
}

function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node src/server.js <config-path>");
    process.exit(1);
  }

  const config = loadConfig(configPath);
  startServer(config);
}

main();
