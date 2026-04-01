/**
 * host.js — Tunnel Agent (Host side)
 *
 * Mirrors the Go client (kami/ngrok/client/main.go) behavior:
 *
 * 1. CONTROL CHANNEL: connects TCP to server, sends "register" message.
 *    Receives "proxy" (TCP) or "udp_open" commands from server.
 *
 * 2. TCP PROXY: On "proxy" command, opens a new TCP conn to server + a conn
 *    to the local backend, then pipes them together.
 *
 * 3. UDP: On "udp_open", creates a local UDP socket dialing the local game port,
 *    and relays data through the UDP data channel (binary protocol).
 *    Sends UDP handshake to server and maintains keep-alive pings.
 *
 * 4. WORLD INFO: Sends NetherNet discovery pings to detect local Bedrock world
 *    and reports it to server as "world_info".
 */

const fs     = require('fs');
const net    = require('net');
const dgram  = require('dgram');
const crypto = require('crypto');
const path   = require('path');

const {
  UDP_MSG,
  encodeControl,
  buildUDPMessage,
  parseUDPMessage,
  createLineParser,
} = require('./common/protocol');

// ─── CLI / Config ─────────────────────────────────────────────────────────────

// index.js passes: <configPath> <localPort> <protocol> <localHost>
const cliLocalPort = process.argv[3] ? parseInt(process.argv[3], 10) : 19132;
const cliProto     = (process.argv[4] || 'udp').toLowerCase();
const cliLocalHost = process.argv[5] || '127.0.0.1';

function loadConfig(filePath) {
  try {
    const full = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(full)) {
      return { serverHost: 'mbasic7.pikamc.vn', serverControlPort: 25284, clientId: 'bedrock-multi-agent' };
    }
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    return { serverHost: 'mbasic7.pikamc.vn', serverControlPort: 25284, clientId: 'bedrock-multi-agent' };
  }
}

// ─── NetherNet (Bedrock LAN discovery) ──────────────────────────────────────

const NETHERNET_KEY = crypto.createHash('sha256')
  .update(Buffer.from([0xEF, 0xBE, 0xAD, 0xDE, 0x00, 0x00, 0x00, 0x00]))
  .digest();
const EXPLORER_GUID = BigInt('0x' + crypto.randomBytes(8).toString('hex'));

function buildDiscoveryPing() {
  const body = Buffer.alloc(18);
  body.writeUInt16LE(0, 0);      // ptype = 0 (Discovery Request)
  body.writeBigUInt64LE(EXPLORER_GUID, 2);
  // last 8 bytes = 0 padding
  const raw  = Buffer.concat([Buffer.from([0x12, 0x00]), body]); // length prefix 0x12 = 18
  const hmac = crypto.createHmac('sha256', NETHERNET_KEY).update(raw).digest();
  const cipher = crypto.createCipheriv('aes-256-ecb', NETHERNET_KEY, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([hmac, cipher.update(raw), cipher.final()]);
}

function parseDiscoveryResponse(buf) {
  try {
    if (buf.length < 34) return null;
    const enc    = buf.slice(32);
    const cipher = crypto.createDecipheriv('aes-256-ecb', NETHERNET_KEY, null);
    cipher.setAutoPadding(true);
    const dec = Buffer.concat([cipher.update(enc), cipher.final()]);
    if (dec.length < 24 || dec.readUInt16LE(2) !== 1) return null;
    const innerLen = dec.readUInt32LE(20);
    const inner    = dec.slice(24, 24 + innerLen);
    let pos = (inner[0] < 32) ? 0 : 1;
    const readStr = () => {
      if (pos >= inner.length) return '';
      const len = inner[pos++];
      const s   = inner.slice(pos, pos + len).toString('utf8');
      pos += len;
      return s;
    };
    const serverName = readStr();
    const levelName  = readStr();
    if (pos + 7 > inner.length) return null;
    pos++; // gameType
    const playerCount = inner.readInt32LE(pos); pos += 4;
    const maxPlayers  = inner.readInt16LE(pos);
    if (!serverName) return null;
    return { serverName, levelName, playerCount, maxPlayers };
  } catch (_) { return null; }
}

// ─── Agent ───────────────────────────────────────────────────────────────────

function startAgent(config) {
  const localHost = config.localHost   || cliLocalHost;
  const localPort = config.localUdpPort || cliLocalPort;
  const clientId  = config.clientId    || config.clientName || 'bedrock-multi-agent';
  const serverHost = config.serverHost  || 'mbasic7.pikamc.vn';
  const serverPort = config.serverControlPort || 25284;
  const reconnectMs = config.reconnectMs || 3000;

  // State
  let controlSocket  = null;
  let authenticated  = false;
  let myKey          = config.key || '';
  let myRemotePort   = null;
  let reconnectTimer = null;

  // UDP sessions: sessionId → localUdpSocket
  const udpSessions   = new Map();
  // UDP control channel socket (same server addr, server port)
  let udpCtrlConn = null;
  let udpReady    = false;
  let udpPingTimer = null;

  // ── NetherNet explorer ────────────────────────────────────────────────
  const explorer = dgram.createSocket('udp4');
  let worldActive = false;
  let lastWorldUpdate = 0;

  explorer.on('message', (buf) => {
    const info = parseDiscoveryResponse(buf);
    if (!info) return;
    if (!worldActive || Date.now() - lastWorldUpdate > 30000) {
      worldActive     = true;
      lastWorldUpdate = Date.now();
      console.log(`\n\x1b[35m[World]\x1b[0m \x1b[1m\x1b[32m${info.serverName}\x1b[0m (\x1b[33m${info.playerCount}/${info.maxPlayers}\x1b[0m)`);
      if (controlSocket && authenticated) {
        controlSocket.write(encodeControl({
          type: 'world_info',
          serverName: info.serverName,
          levelName:  info.levelName,
          playerCount: info.playerCount,
          maxPlayers:  info.maxPlayers,
        }));
      }
    }
  });
  explorer.on('error', () => {});

  function sendDiscoveryPing() {
    try { explorer.send(buildDiscoveryPing(), localPort, localHost); } catch (_) {}
  }
  setInterval(sendDiscoveryPing, 2000);

  // ── UDP Control Channel ───────────────────────────────────────────────

  function setupUDPChannel() {
    if (udpCtrlConn) {
      try { udpCtrlConn.close(); } catch (_) {}
    }
    udpReady = false;

    const sock = dgram.createSocket('udp4');
    udpCtrlConn = sock;

    sock.on('message', (buf) => {
      const parsed = parseUDPMessage(buf);
      if (!parsed || parsed.key !== myKey) return;

      switch (parsed.msgType) {
        case UDP_MSG.HANDSHAKE:
          if (!udpReady) {
            udpReady = true;
            console.log('\x1b[32m[UDP]\x1b[0m Control channel handshake OK');
            startUDPPing();
          }
          break;
        case UDP_MSG.DATA: {
          // Server → host: forward to local game via the session socket
          const sess = udpSessions.get(parsed.id);
          if (sess && parsed.payload.length > 0) {
            // send() from the session's bound port so game replies come back here
            sess.send(parsed.payload, localPort, localHost);
          }
          break;
        }
        case UDP_MSG.CLOSE:
          closeUDPSession(parsed.id);
          break;
        case UDP_MSG.PING:
          sock.send(
            buildUDPMessage(UDP_MSG.PONG, myKey, parsed.id, parsed.payload),
            serverPort, serverHost
          );
          break;
        case UDP_MSG.PONG:
          // just keep-alive received
          break;
      }
    });
    sock.on('error', () => {});

    // Send handshake bursts
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (udpCtrlConn !== sock) return;
        sock.send(buildUDPMessage(UDP_MSG.HANDSHAKE, myKey, '', null), serverPort, serverHost);
      }, i * 50);
    }

    // Retry handshake if not acked
    let retries = 0;
    const retryTimer = setInterval(() => {
      if (udpReady || udpCtrlConn !== sock) { clearInterval(retryTimer); return; }
      if (++retries > 20) {
        clearInterval(retryTimer);
        console.warn('\x1b[31m[UDP]\x1b[0m Handshake timeout after 20 retries');
        return;
      }
      sock.send(buildUDPMessage(UDP_MSG.HANDSHAKE, myKey, '', null), serverPort, serverHost);
    }, 500);
  }

  function startUDPPing() {
    if (udpPingTimer) clearInterval(udpPingTimer);
    udpPingTimer = setInterval(() => {
      if (!udpCtrlConn || !myKey) return;
      const ts = Buffer.allocUnsafe(8);
      ts.writeBigInt64BE(BigInt(Date.now()), 0);
      udpCtrlConn.send(
        buildUDPMessage(UDP_MSG.PING, myKey, '', ts),
        serverPort, serverHost
      );
    }, 3000);
  }

  // ── UDP session per player (udp_open) ─────────────────────────────────
  // Each session gets its own UDP socket bound to a random local port, then
  // "connected" to the local game. This mirrors Go's net.DialUDP() semantics:
  // the socket has a fixed source port so the game always knows where to respond.

  function handleUDPOpen(msg) {
    if (udpSessions.has(msg.id)) closeUDPSession(msg.id);

    const sock = dgram.createSocket({ type: 'udp4' });

    sock.on('message', (buf) => {
      // Reply from local game → forward back to server via UDP control channel
      if (!udpCtrlConn || !udpReady) return;
      udpCtrlConn.send(
        buildUDPMessage(UDP_MSG.DATA, myKey, msg.id, buf),
        serverPort, serverHost
      );
    });

    sock.on('error', () => closeUDPSession(msg.id));

    // Bug 3 fix: explicitly bind to port 0 so the OS assigns a real local port.
    // Without this, dgram may not consistently receive replies from the game.
    sock.bind(0, localHost, () => {
      udpSessions.set(msg.id, sock);
      console.log(`\x1b[34m[UDP Open]\x1b[0m Session \x1b[33m${msg.id}\x1b[0m from ${msg.remote_addr} → local bound :${sock.address().port}`);
    });
  }

  function closeUDPSession(id) {
    const sock = udpSessions.get(id);
    if (sock) {
      try { sock.close(); } catch (_) {}
      udpSessions.delete(id);
      console.log(`\x1b[31m[UDP Close]\x1b[0m Session ${id}`);
    }
  }

  // ── TCP proxy (handleProxy) ───────────────────────────────────────────

  function handleProxy(id) {
    // Open new TCP conn to server with proxy handshake
    const srvConn = net.connect({ host: serverHost, port: serverPort }, () => {
      srvConn.setNoDelay(true);
      srvConn.write(encodeControl({
        type: 'proxy',
        key: myKey,
        client_id: clientId,
        id,
      }));

      // Open conn to local backend
      const localConn = net.connect({ host: localHost, port: localPort }, () => {
        localConn.setNoDelay(true);
        srvConn.pipe(localConn);
        localConn.pipe(srvConn);
        srvConn.on('close', () => localConn.destroy());
        localConn.on('close', () => srvConn.destroy());
        srvConn.on('error', () => localConn.destroy());
        localConn.on('error', () => srvConn.destroy());
      });
      localConn.on('error', (e) => {
        console.error(`\x1b[31m[TCP]\x1b[0m Local connect failed: ${e.message}`);
        srvConn.destroy();
      });
    });
    srvConn.on('error', (e) => {
      console.error(`\x1b[31m[TCP]\x1b[0m Server data-conn failed: ${e.message}`);
    });
  }

  // ── Control Connection ────────────────────────────────────────────────

  function connectControl() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const socket = net.connect({ host: serverHost, port: serverPort }, () => {
      socket.setNoDelay(true);
      console.log(`\x1b[36m[Control]\x1b[0m Connected → ${serverHost}:${serverPort}`);

      // Send register
      socket.write(encodeControl({
        type:      'register',
        key:       myKey,
        token:     config.authToken || '',   // Bug 5 fix: send auth token
        client_id: clientId,
        target:    `${localHost}:${localPort}`,
        protocol:  cliProto,
      }));
    });

    controlSocket = socket;

    const parser = createLineParser((msg) => {
      switch (msg.type) {
        case 'registered':
          myKey         = msg.key || myKey;
          myRemotePort  = msg.remote_port;
          authenticated = true;
          console.log(`\x1b[32m[Registered]\x1b[0m key=${myKey} remote_port=${myRemotePort} proto=${msg.protocol}`);
          // Start UDP channel after registration
          if (msg.protocol === 'udp' || cliProto === 'udp') {
            setupUDPChannel();
          }
          break;

        case 'proxy':
          if (!authenticated) break;
          console.log(`\x1b[34m[Proxy]\x1b[0m ${msg.id}`);
          handleProxy(msg.id);
          break;

        case 'udp_open':
          if (!authenticated) break;
          handleUDPOpen(msg);
          break;

        case 'udp_close':
          closeUDPSession(msg.id);
          break;

        case 'ping':
          socket.write(encodeControl({ type: 'pong' }));
          break;

        case 'pong':
          break;

        case 'error':
          console.error(`\x1b[31m[Server Error]\x1b[0m ${msg.error}`);
          break;

        default:
          console.log(`[Control? Unknown] ${JSON.stringify(msg)}`);
      }
    }, (err) => socket.destroy());

    socket.on('data', parser);

    socket.on('close', () => {
      authenticated = false;
      udpReady      = false;
      if (udpPingTimer) { clearInterval(udpPingTimer); udpPingTimer = null; }
      if (udpCtrlConn) { try { udpCtrlConn.close(); } catch (_) {} udpCtrlConn = null; }
      console.log('\x1b[31m[Control]\x1b[0m Disconnected. Reconnecting...');
      reconnectTimer = setTimeout(connectControl, reconnectMs);
    });

    socket.on('error', () => {});
  }

  connectControl();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
const configPath = process.argv[2] || 'configs/agent.config.json';
const config     = loadConfig(configPath);
startAgent(config);
