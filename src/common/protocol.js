/**
 * Protocol matching the Go example (kami/ngrok):
 *
 * CONTROL CHANNEL: Plain JSON, newline-delimited (one JSON object per line)
 *   Client → Server:  { type: "register", key, client_id, target, protocol }
 *   Server → Client:  { type: "registered", key, remote_port, protocol }
 *   Server → Client:  { type: "proxy", id }          (TCP)
 *   Server → Client:  { type: "udp_open", id, remote_addr, protocol }
 *   Server → Client:  { type: "udp_close", id }
 *   Client → Server:  { type: "ping" }
 *   Server → Client:  { type: "pong" }
 *   Client → Server:  { type: "proxy", key, client_id, id }  (on DATA conn)
 *
 * UDP DATA CHANNEL: Binary over UDP socket (same port as control TCP)
 *   Format:  [msgType 1B][keyLen 2B BE][key bytes][idLen 2B BE][id bytes][payload]
 *   Except for handshake: [msgType 1B][keyLen 2B BE][key bytes]  (no id field)
 *
 *   msgType values:
 *     1 = handshake
 *     2 = data
 *     3 = close
 *     4 = ping
 *     5 = pong
 */

const UDP_MSG = {
  HANDSHAKE: 1,
  DATA: 2,
  CLOSE: 3,
  PING: 4,
  PONG: 5,
};

/**
 * Encode a control-plane JSON message (newline-delimited).
 */
function encodeControl(obj) {
  return Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Build a UDP binary message.
 * For HANDSHAKE: no id field.
 * For others: id field present.
 */
function buildUDPMessage(msgType, key, id, payload) {
  const keyBuf = Buffer.from(key || '', 'utf8');
  const idBuf  = Buffer.from(id  || '', 'utf8');
  const hasId  = msgType !== UDP_MSG.HANDSHAKE;
  const payBuf = payload ? Buffer.from(payload) : Buffer.alloc(0);

  let total = 1 + 2 + keyBuf.length;
  if (hasId) total += 2 + idBuf.length;
  total += payBuf.length;

  const buf = Buffer.allocUnsafe(total);
  let off = 0;
  buf[off++] = msgType;
  buf.writeUInt16BE(keyBuf.length, off); off += 2;
  keyBuf.copy(buf, off); off += keyBuf.length;
  if (hasId) {
    buf.writeUInt16BE(idBuf.length, off); off += 2;
    idBuf.copy(buf, off); off += idBuf.length;
  }
  payBuf.copy(buf, off);
  return buf;
}

/**
 * Parse a UDP binary message.
 * Returns { msgType, key, id, payload } or null if invalid.
 */
function parseUDPMessage(buf) {
  if (buf.length < 3) return null;
  const msgType = buf[0];
  const keyLen  = buf.readUInt16BE(1);
  if (buf.length < 3 + keyLen) return null;
  const key = buf.slice(3, 3 + keyLen).toString('utf8');
  let off = 3 + keyLen;

  let id = '';
  if (msgType !== UDP_MSG.HANDSHAKE) {
    if (buf.length < off + 2) return null;
    const idLen = buf.readUInt16BE(off); off += 2;
    if (buf.length < off + idLen) return null;
    id = buf.slice(off, off + idLen).toString('utf8');
    off += idLen;
  }

  const payload = buf.slice(off);
  return { msgType, key, id, payload };
}

/**
 * Create a line-based JSON parser for a TCP stream.
 * Calls onMessage(obj) for each complete JSON line received.
 */
function createLineParser(onMessage, onError) {
  let buf = '';

  return (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onMessage(JSON.parse(trimmed));
      } catch (e) {
        // ignore bad JSON lines
      }
    }
  };
}

module.exports = {
  UDP_MSG,
  encodeControl,
  buildUDPMessage,
  parseUDPMessage,
  createLineParser,
};
