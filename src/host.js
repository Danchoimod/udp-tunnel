const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const { createLineParser, encodeControl, buildUDPMessage, parseUDPMessage, UDP_MSG } = require('./common/protocol');

function loadConfig(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    process.exit(1);
  }
}

function startAgent(config) {
  const { serverHost, serverControlPort: serverPort, clientId, localHost, localUdpPort: localPort } = config;
  const reconnectMs = config.reconnectMs || 3000;
  let myKey = config.key || '';
  let authenticated = false;
  let udpCtrlConn = null;
  let udpReady = false;
  const udpSessions = new Map();

  // ── UDP Data Relay ───────────────────────────────────────────────────

  function setupUDPChannel() {
    if (udpCtrlConn) try { udpCtrlConn.close(); } catch (_) {}
    udpReady = false;

    // Use a high-performance UDP socket with DNS lookup disabled
    const sock = dgram.createSocket({ type: 'udp4', lookup: (hostname, options, cb) => cb(null, hostname, 4) });
    udpCtrlConn = sock;

    sock.on('message', (buf) => {
      const parsed = parseUDPMessage(buf);
      if (!parsed || parsed.key !== myKey) return;

      if (parsed.msgType === UDP_MSG.HANDSHAKE) {
        if (!udpReady) {
          udpReady = true;
          console.log('\x1b[32m[UDP Handshake]\x1b[0m Tunneling active.');
        }
      } else if (parsed.msgType === UDP_MSG.DATA) {
        const sess = udpSessions.get(parsed.id);
        if (sess && parsed.payload.length > 0) {
          // Relay DATA from Server to Game
          sess.send(parsed.payload, localPort, localHost);
        }
      } else if (parsed.msgType === UDP_MSG.CLOSE) {
        closeUDPSession(parsed.id);
      } else if (parsed.msgType === UDP_MSG.PING) {
        sock.send(buildUDPMessage(UDP_MSG.PONG, myKey, parsed.id, parsed.payload), serverPort, serverHost);
      }
    });

    const trigger = () => {
      if (udpCtrlConn === sock && !udpReady) {
        sock.send(buildUDPMessage(UDP_MSG.HANDSHAKE, myKey, '', null), serverPort, serverHost);
      }
    };
    setInterval(trigger, 1000);
    trigger();
  }

  function handleUDPOpen(msg) {
    if (udpSessions.has(msg.id)) closeUDPSession(msg.id);

    const sock = dgram.createSocket('udp4');
    
    // Relay DATA from Game to Server
    sock.on('message', (buf) => {
      if (udpCtrlConn && udpReady) {
        const pkt = buildUDPMessage(UDP_MSG.DATA, myKey, msg.id, buf);
        udpCtrlConn.send(pkt, serverPort, serverHost);
      }
    });

    sock.on('error', () => closeUDPSession(msg.id));

    sock.bind(0, () => {
      udpSessions.set(msg.id, sock);
      console.log(`\x1b[34m[Link]\x1b[0m Session \x1b[33m${msg.id}\x1b[0m: Player → Game (${localPort})`);
    });
  }

  function closeUDPSession(id) {
    const s = udpSessions.get(id);
    if (s) { try { s.close(); } catch (_) {} udpSessions.delete(id); }
  }

  // ── Control Connection ─────────────────────────────────────────────────

  function connectControl() {
    const socket = net.connect({ host: serverHost, port: serverPort }, () => {
      socket.setNoDelay(true);
      console.log(`\x1b[36m[Control]\x1b[0m Connected.`);
      socket.write(encodeControl({
        type: 'register', key: myKey, token: config.authToken || '', client_id: clientId, target: `localhost:${localPort}`, protocol: 'udp'
      }));
    });

    const parser = createLineParser((msg) => {
      switch (msg.type) {
        case 'registered':
          myKey = msg.key || myKey;
          authenticated = true;
          console.log(`\x1b[32m[Success]\x1b[0m Key: ${myKey.slice(0, 8)}...`);
          setupUDPChannel();
          break;
        case 'udp_open':
          if (authenticated) handleUDPOpen(msg);
          break;
        case 'udp_close':
          closeUDPSession(msg.id);
          break;
        case 'ping':
          socket.write(encodeControl({ type: 'pong' }));
          break;
      }
    }, () => socket.destroy());

    socket.on('data', parser);
    socket.on('close', () => {
      authenticated = false; udpReady = false;
      setTimeout(connectControl, reconnectMs);
    });
    socket.on('error', () => {});
  }

  connectControl();
}

startAgent(loadConfig(process.argv[2] || 'configs/agent.config.json'));
