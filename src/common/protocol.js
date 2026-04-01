const MAGIC = Buffer.from("LB"); // LFLauncher Binary protocol
const MAGIC_LEN = MAGIC.length; // 2

const PACKET_TYPES = {
  JSON: 0x01,
  UDP_TO_AGENT: 0x02,
  UDP_FROM_AGENT: 0x03,
  CONTROL_REQUEST_DATA: 0x04,
  DATA_INIT: 0x05,
};

function encodeJson(message) {
  const jsonStr = JSON.stringify(message);
  const jsonBuf = Buffer.from(jsonStr, "utf8");
  const packet = Buffer.allocUnsafe(MAGIC_LEN + 4 + 1 + jsonBuf.length);
  
  MAGIC.copy(packet, 0);
  packet.writeUInt32BE(jsonBuf.length + 1, MAGIC_LEN);
  packet.writeUInt8(PACKET_TYPES.JSON, MAGIC_LEN + 4);
  jsonBuf.copy(packet, MAGIC_LEN + 4 + 1);
  return packet;
}

function encodeUdpToAgent(sessionIdHex, localPort, payload) {
  const sessionBuf = Buffer.from(sessionIdHex, "hex");
  const headerLen = sessionBuf.length + 2;
  const packet = Buffer.allocUnsafe(MAGIC_LEN + 4 + 1 + headerLen + payload.length);

  MAGIC.copy(packet, 0);
  packet.writeUInt32BE(1 + headerLen + payload.length, MAGIC_LEN);
  packet.writeUInt8(PACKET_TYPES.UDP_TO_AGENT, MAGIC_LEN + 4);
  sessionBuf.copy(packet, MAGIC_LEN + 4 + 1);
  packet.writeUInt16BE(localPort, MAGIC_LEN + 4 + 1 + sessionBuf.length);
  payload.copy(packet, MAGIC_LEN + 4 + 1 + sessionBuf.length + 2);
  return packet;
}

function encodeControlRequest(sessionIdHex, localPort) {
  const sessionBuf = Buffer.from(sessionIdHex, "hex");
  const packet = Buffer.allocUnsafe(MAGIC_LEN + 4 + 1 + sessionBuf.length + 2);
  MAGIC.copy(packet, 0);
  packet.writeUInt32BE(1 + sessionBuf.length + 2, MAGIC_LEN);
  packet.writeUInt8(PACKET_TYPES.CONTROL_REQUEST_DATA, MAGIC_LEN + 4);
  sessionBuf.copy(packet, MAGIC_LEN + 4 + 1);
  packet.writeUInt16BE(localPort, MAGIC_LEN + 4 + 1 + sessionBuf.length);
  return packet;
}

function encodeDataInit(sessionIdHex) {
  const sessionBuf = Buffer.from(sessionIdHex, "hex");
  const packet = Buffer.allocUnsafe(MAGIC_LEN + 4 + 1 + sessionBuf.length);
  MAGIC.copy(packet, 0);
  packet.writeUInt32BE(1 + sessionBuf.length, MAGIC_LEN);
  packet.writeUInt8(PACKET_TYPES.DATA_INIT, MAGIC_LEN + 4);
  sessionBuf.copy(packet, MAGIC_LEN + 4 + 1);
  return packet;
}

function encodeUdpFromAgent(sessionIdHex, payload) {
  const sessionBuf = Buffer.from(sessionIdHex, "hex");
  const headerLen = sessionBuf.length;
  const packet = Buffer.allocUnsafe(MAGIC_LEN + 4 + 1 + headerLen + payload.length);

  MAGIC.copy(packet, 0);
  packet.writeUInt32BE(1 + headerLen + payload.length, MAGIC_LEN);
  packet.writeUInt8(PACKET_TYPES.UDP_FROM_AGENT, MAGIC_LEN + 4);
  sessionBuf.copy(packet, MAGIC_LEN + 4 + 1);
  payload.copy(packet, MAGIC_LEN + 4 + 1 + sessionBuf.length);
  return packet;
}

function createBinaryParser(onMessage, onError) {
  const MAX_BUFFER = 2 * 1024 * 1024; // 2MB accumulated buffer
  const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB per packet payload limit
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BUFFER) {
      buffer = Buffer.alloc(0);
      onError(new Error("Buffer overflow, closing connection"));
      return;
    }

    while (buffer.length >= MAGIC_LEN + 4 + 1) {
      // Fast byte-by-byte magic check
      if (buffer[0] !== 0x4c || buffer[1] !== 0x42) {
        // Find next magic
        const nextMagic = buffer.indexOf(MAGIC, 1);
        if (nextMagic === -1) {
          buffer = Buffer.alloc(0);
          return;
        }
        buffer = buffer.slice(nextMagic);
        continue;
      }

      const payloadLen = buffer.readUInt32BE(MAGIC_LEN);
      if (payloadLen > MAX_PAYLOAD_SIZE) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Oversized packet: ${payloadLen} bytes`));
        return;
      }

      const totalPacketLen = MAGIC_LEN + 4 + payloadLen;

      if (buffer.length < totalPacketLen) break;

      const packet = buffer.slice(MAGIC_LEN + 4, totalPacketLen);
      buffer = buffer.slice(totalPacketLen);

      const type = packet.readUInt8(0);
      const data = packet.slice(1);

      try {
        if (type === PACKET_TYPES.JSON) {
          onMessage({ type: 'JSON', payload: JSON.parse(data.toString('utf8')) });
        } else if (type === PACKET_TYPES.UDP_TO_AGENT) {
          onMessage({
            type: 'UDP_TO_AGENT',
            sessionId: data.slice(0, 8).toString('hex'),
            localPort: data.readUInt16BE(8),
            payload: data.slice(10),
          });
        } else if (type === PACKET_TYPES.UDP_FROM_AGENT) {
          onMessage({
            type: 'UDP_FROM_AGENT',
            sessionId: data.slice(0, 8).toString('hex'),
            payload: data.slice(8),
          });
        } else if (type === PACKET_TYPES.CONTROL_REQUEST_DATA) {
          onMessage({
            type: 'CONTROL_REQUEST_DATA',
            sessionId: data.slice(0, 8).toString('hex'),
            localPort: data.readUInt16BE(8),
          });
        } else if (type === PACKET_TYPES.DATA_INIT) {
          onMessage({
            type: 'DATA_INIT',
            sessionId: data.slice(0, 8).toString('hex'),
          });
        }
      } catch (err) {
        onError(err);
      }
    }
  };
}

module.exports = {
  PACKET_TYPES,
  encodeJson,
  encodeUdpToAgent,
  encodeUdpFromAgent,
  encodeControlRequest,
  encodeDataInit,
  createBinaryParser,
};
