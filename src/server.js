/**
 * server.js — Tunnel Server
 *
 * Implements the same server-side protocol as the Go "kami/ngrok" example:
 *
 * CONTROL CHANNEL (TCP, port = config.controlPort):
 *   Client → Server: { type:"register", key, client_id, target, protocol }
 *   Server → Client: { type:"registered", key, remote_port, protocol }
 *   Server → Client: { type:"proxy", id }          (TCP tunnel request)
 *   Server → Client: { type:"udp_open", id, remote_addr, protocol:"udp" }
 *   Server → Client: { type:"udp_close", id }
 *   Both directions: { type:"ping" } / { type:"pong" }
 *
 * DATA CHANNEL (same TCP port):
 *   Client → Server: { type:"proxy", key, client_id, id }  (first line on new conn)
 *   Then raw pipe between the waiting public connection and this socket.
 *
 * UDP DATA (same TCP port, but UDP socket):
 *   Binary:  [msgType 1B][keyLen 2B BE][key][idLen 2B BE][id][payload]
 *   Handshake: [1][keyLen][key]  (no id)
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

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig(filePath) {
  try {
    const full = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(full)) { console.error('Config not found:', full); process.exit(1); }
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    console.error('Config error:', e.message); process.exit(1);
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

const stats = { totalUp: 0, totalDown: 0, startTime: Date.now() };

function fmtBytes(n) {
  if (n === 0) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return (n / Math.pow(k, i)).toFixed(2) + ' ' + s[i];
}

function renderDashboard(config, clients, pendingTcp, udpSessions) {
  const dur = Math.floor((Date.now() - stats.startTime) / 1000);
  const t   = `${Math.floor(dur/3600)}h ${Math.floor(dur%3600/60)}m ${dur%60}s`;
  process.stdout.write('\x1b[H\x1b[2J');
  console.log('\x1b[36m' + '═'.repeat(62) + '\x1b[0m');
  console.log('\x1b[1m\x1b[35m         BEDROCK TUNNEL SERVER  (LFLauncher)         \x1b[0m');
  console.log('\x1b[36m' + '═'.repeat(62) + '\x1b[0m');
  console.log(` Uptime      : ${t}`);
  console.log(` Clients     : \x1b[33m${clients.size}\x1b[0m`);
  console.log(` Pending TCP : \x1b[33m${pendingTcp.size}\x1b[0m`);
  console.log(` UDP sessions: \x1b[33m${udpSessions.size}\x1b[0m`);
  console.log('\x1b[36m' + '─'.repeat(62) + '\x1b[0m');
  config.ports.forEach(p => {
    const c = clients.get(p.clientId);
    const status = c ? '\x1b[32mONLINE\x1b[0m' : '\x1b[31mWAITING\x1b[0m';
    console.log(` \x1b[33m[UDP :${p.publicPort}]\x1b[0m ← client_id: \x1b[36m${p.clientId}\x1b[0m  ${status}`);
  });
  console.log('\x1b[36m' + '─'.repeat(62) + '\x1b[0m');
  console.log(` ▲ Total Up  : \x1b[32m${fmtBytes(stats.totalUp)}\x1b[0m`);
  console.log(` ▼ Total Down: \x1b[31m${fmtBytes(stats.totalDown)}\x1b[0m`);
  console.log('\x1b[36m' + '═'.repeat(62) + '\x1b[0m');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function startServer(config) {
  // clientId → { socket, key, protocol, portMapping }
  const clients    = new Map();
  // requestId → { socket (waiting public conn), timer }
  const pendingTcp = new Map();
  // sessionId → { clientId, remoteAddr (ip:port) }
  const udpSessions = new Map();

  // ── UDP public sockets ──────────────────────────────────────────────────
  const udpPublicSockets = new Map(); // publicPort → dgram.Socket

  config.ports.forEach(portMapping => {
    if (portMapping.protocol && portMapping.protocol !== 'udp') return; // only UDP for Bedrock

    const publicPort = portMapping.publicPort;
    const sock       = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => {
      const remoteAddr = `${rinfo.address}:${rinfo.port}`;
      console.log(`\x1b[33m[UDP :${publicPort}]\x1b[0m Packet from ${remoteAddr} (${msg.length}B)`);
      const client = clients.get(portMapping.clientId);
      if (!client) {
        console.warn(`\x1b[31m[UDP :${publicPort}]\x1b[0m No agent for client_id: ${portMapping.clientId}`);
        return;
      }
      if (!client.udpConn) {
        console.warn(`\x1b[31m[UDP :${publicPort}]\x1b[0m Agent has no UDP channel yet (handshake pending?)`);
        return;
      }

      // Find existing session for this remoteAddr+port
      let sessionId = null;
      for (const [id, sess] of udpSessions) {
        if (sess.clientId === portMapping.clientId && sess.remoteAddr === remoteAddr) {
          sessionId = id;
          break;
        }
      }

      if (!sessionId) {
        // New player → create session, notify client via control
        sessionId = crypto.randomBytes(8).toString('hex');
        udpSessions.set(sessionId, { clientId: portMapping.clientId, remoteAddr, publicPort });
        client.socket.write(encodeControl({
          type: 'udp_open',
          id: sessionId,
          remote_addr: remoteAddr,
          protocol: 'udp',
        }));
        console.log(`\x1b[35m[UDP Open]\x1b[0m Session \x1b[33m${sessionId}\x1b[0m from ${remoteAddr}`);
      }

      // Forward to client via UDP data channel
      stats.totalDown += msg.length;
      const udpPkt = buildUDPMessage(UDP_MSG.DATA, client.key, sessionId, msg);
      client.udpConn && client.udpConn.send(udpPkt, client.udpPort, client.udpAddr);
    });

    sock.on('error', (err) => console.error(`[UDP :${publicPort}] Error:`, err.message));
    sock.bind(publicPort, config.publicBindAddr || '0.0.0.0', () => {
      console.log(`\x1b[32m[UDP Ready]\x1b[0m Port ${publicPort} (client_id: ${portMapping.clientId})`);
    });

    udpPublicSockets.set(publicPort, sock);
  });

  // ── UDP control socket (same port as TCP control, but UDP) ──────────────
  const udpCtrl = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpCtrl.on('message', (buf, rinfo) => {
    const parsed = parseUDPMessage(buf);
    if (!parsed) return;

    // Find client by key
    let foundClient = null;
    let foundId     = null;
    for (const [id, c] of clients) {
      if (c.key === parsed.key) { foundClient = c; foundId = id; break; }
    }
    if (!foundClient) return;

    // Track client UDP address
    foundClient.udpAddr = rinfo.address;
    foundClient.udpPort = rinfo.port;
    foundClient.udpConn = udpCtrl;

    switch (parsed.msgType) {
      case UDP_MSG.HANDSHAKE:
        // Reply with handshake to confirm
        udpCtrl.send(
          buildUDPMessage(UDP_MSG.HANDSHAKE, parsed.key, '', null),
          rinfo.port, rinfo.address
        );
        console.log(`\x1b[34m[UDP Handshake]\x1b[0m Client ${foundId} from ${rinfo.address}:${rinfo.port}`);
        break;

      case UDP_MSG.DATA: {
        // Data FROM client → forward to public player
        const sess = udpSessions.get(parsed.id);
        if (!sess) break;
        const publicSock = udpPublicSockets.get(sess.publicPort);
        if (!publicSock) break;
        const [peerIp, peerPortStr] = sess.remoteAddr.split(':');
        const peerPort = parseInt(peerPortStr, 10);
        stats.totalUp += parsed.payload.length;
        publicSock.send(parsed.payload, peerPort, peerIp);
        break;
      }

      case UDP_MSG.CLOSE: {
        const sess = udpSessions.get(parsed.id);
        if (sess) {
          udpSessions.delete(parsed.id);
          console.log(`\x1b[31m[UDP Close]\x1b[0m Session ${parsed.id}`);
        }
        break;
      }

      case UDP_MSG.PING:
        // Pong back
        udpCtrl.send(
          buildUDPMessage(UDP_MSG.PONG, parsed.key, parsed.id, parsed.payload),
          rinfo.port, rinfo.address
        );
        break;

      case UDP_MSG.PONG:
        // client pong — nothing to do
        break;
    }
  });

  udpCtrl.bind(config.controlPort, config.controlBindAddr || '0.0.0.0', () => {
    console.log(`\x1b[32m[UDP Ctrl]\x1b[0m Listening on port ${config.controlPort} (for UDP handshake)`);
  });

  // ── TCP control server ──────────────────────────────────────────────────
  const tcpServer = net.createServer();

  tcpServer.on('connection', (socket) => {
    socket.setNoDelay(true);
    let registered = false;
    let client = null;
    let clientId = null;

    const parser = createLineParser((msg) => {
      // ── DATA CONN: first message is "proxy" ─────────────────────────────
      if (!registered && msg.type === 'proxy') {
        // This is a data connection for a pending TCP proxy request
        const pendingEntry = pendingTcp.get(msg.id);
        if (!pendingEntry) {
          socket.destroy();
          return;
        }
        clearTimeout(pendingEntry.timer);
        pendingTcp.delete(msg.id);

        const publicConn = pendingEntry.socket;
        console.log(`\x1b[32m[TCP Pipe]\x1b[0m Proxy ${msg.id} connected`);

        // Pipe publicConn ↔ socket
        publicConn.pipe(socket);
        socket.pipe(publicConn);

        publicConn.on('close', () => socket.destroy());
        socket.on('close', () => publicConn.destroy());
        publicConn.on('error', () => socket.destroy());
        socket.on('error', () => publicConn.destroy());

        // Count traffic
        publicConn.on('data', (d) => { stats.totalDown += d.length; });
        socket.on('data', (d)    => { stats.totalUp   += d.length; });
        return;
      }

      // ── CONTROL CONN: first message is "register" ───────────────────────
      if (!registered && msg.type === 'register') {
        clientId = msg.client_id || 'default';

        // Replace old connection for same clientId
        const old = clients.get(clientId);
        if (old) {
          try { old.socket.destroy(); } catch (_) {}
        }

        const key = (msg.key && msg.key.trim())
          ? msg.key.trim()
          : crypto.randomBytes(16).toString('hex');

        const portMapping = config.ports.find(p => p.clientId === clientId);
        if (!portMapping) {
          socket.write(encodeControl({ type: 'error', error: `no port mapping for client_id: ${clientId}` }));
          socket.destroy();
          return;
        }

        client = {
          socket,
          key,
          protocol: msg.protocol || 'tcp',
          portMapping,
          lastPong: Date.now(),
          udpAddr: null, udpPort: null, udpConn: null,
        };
        clients.set(clientId, client);
        registered = true;

        socket.write(encodeControl({
          type: 'registered',
          key,
          remote_port: portMapping.publicPort,
          protocol: msg.protocol || 'tcp',
        }));

        console.log(`\x1b[32m[Register]\x1b[0m client_id=\x1b[33m${clientId}\x1b[0m key=${key} port=${portMapping.publicPort} proto=${msg.protocol || 'tcp'}`);
        return;
      }

      // ── Already registered: handle control messages ─────────────────────
      if (!registered) { socket.destroy(); return; }

      if (msg.type === 'ping') {
        socket.write(encodeControl({ type: 'pong' }));
      } else if (msg.type === 'pong') {
        if (client) client.lastPong = Date.now();
      } else if (msg.type === 'world_info') {
        if (client) client.worldInfo = msg;
      } else if (msg.type === 'udp_close') {
        if (msg.id) udpSessions.delete(msg.id);
      } else if (msg.type === 'udp_idle') {
        if (msg.id) udpSessions.delete(msg.id);
      }

    }, (err) => {
      socket.destroy();
    });

    socket.on('data', parser);

    socket.on('close', () => {
      if (clientId && clients.get(clientId)?.socket === socket) {
        clients.delete(clientId);
        console.log(`\x1b[31m[Disconnect]\x1b[0m client_id=${clientId}`);
        // Clean up UDP sessions for this client
        for (const [id, sess] of udpSessions) {
          if (sess.clientId === clientId) udpSessions.delete(id);
        }
      }
    });

    socket.on('error', () => {});
  });

  // ── TCP public ports (for TCP tunnels if needed) ────────────────────────
  config.ports.forEach(portMapping => {
    if (portMapping.protocol === 'udp') return; // skip, handled by UDP socket
    if (!portMapping.tcpPublicPort) return;

    const pubServer = net.createServer();
    pubServer.on('connection', (publicConn) => {
      publicConn.setNoDelay(true);
      const clientEntry = clients.get(portMapping.clientId);
      if (!clientEntry) { publicConn.destroy(); return; }

      const reqId = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        publicConn.destroy();
        pendingTcp.delete(reqId);
        console.log(`\x1b[31m[TCP Timeout]\x1b[0m Proxy ${reqId} expired`);
      }, config.proxyTimeoutMs || 10000);

      pendingTcp.set(reqId, { socket: publicConn, timer });
      clientEntry.socket.write(encodeControl({ type: 'proxy', id: reqId }));
      console.log(`\x1b[34m[TCP Proxy]\x1b[0m Requesting proxy ${reqId} for client ${portMapping.clientId}`);
    });

    pubServer.listen(portMapping.tcpPublicPort, config.publicBindAddr || '0.0.0.0', () => {
      console.log(`\x1b[32m[TCP Public]\x1b[0m Port ${portMapping.tcpPublicPort} (client_id: ${portMapping.clientId})`);
    });
  });

  tcpServer.listen(config.controlPort, config.controlBindAddr || '0.0.0.0', () => {
    console.log(`\x1b[32m[Control]\x1b[0m TCP listening on port ${config.controlPort}`);
  });

  // ── Heartbeat ──────────────────────────────────────────────────────────
  const pingIntervalMs = config.pingIntervalMs || 20000;
  const pongTimeoutMs  = config.pongTimeoutMs  || 45000;

  setInterval(() => {
    const now = Date.now();
    for (const [id, c] of clients) {
      if (now - c.lastPong > pongTimeoutMs) {
        console.log(`\x1b[31m[Timeout]\x1b[0m client_id=${id} pong timeout`);
        c.socket.destroy();
      } else {
        c.socket.write(encodeControl({ type: 'ping' }));
      }
    }
    // Clean up expired UDP sessions (60s idle)
    for (const [id, sess] of udpSessions) {
      if (!clients.has(sess.clientId)) udpSessions.delete(id);
    }
  }, pingIntervalMs);

  // Dashboard (disabled temporarily for debug — re-enable after confirming tunnel works)
  // setInterval(() => renderDashboard(config, clients, pendingTcp, udpSessions), 1000);
  console.log('\x1b[32m[Server Ready]\x1b[0m Debug mode: watching for UDP packets...');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
const configPath = process.argv[2] || 'configs/server.config.json';
const config     = loadConfig(configPath);
startServer(config);
