/**
 * test-local-game.js — Kiểm tra xem Minecraft Bedrock có đang lắng nghe trên 127.0.0.1:19132 không
 * Gửi một RakNet UNCONNECTED_PING (0x01) đến game và chờ UNCONNECTED_PONG (0x1c)
 * Chạy: node test-local-game.js
 */
const dgram = require('dgram');

const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 19132;

// RakNet Unconnected Ping packet (0x01)
// [0x01][timeMS 8B][RAKNET_MAGIC 16B][clientGUID 8B]
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
function buildPing() {
  const buf = Buffer.allocUnsafe(1 + 8 + 16);
  buf[0] = 0x01; // ID_UNCONNECTED_PING
  buf.writeBigInt64BE(BigInt(Date.now()), 1);
  RAKNET_MAGIC.copy(buf, 9);
  return buf;
}

const sock = dgram.createSocket('udp4');
const ping = buildPing();
let replied = false;

sock.on('message', (msg, rinfo) => {
  replied = true;
  console.log(`✅ Game đang ONLINE tại ${rinfo.address}:${rinfo.port}`);
  if (msg[0] === 0x1c) {
    // Parse UNCONNECTED_PONG để lấy server name
    const motdStart = 35; // after header
    const motdLen   = msg.readUInt16BE(33);
    const motd = msg.slice(motdStart, motdStart + motdLen).toString('utf8');
    console.log(`   MOTD: ${motd}`);
  } else {
    console.log(`   Raw (${msg.length}B): ${msg.slice(0, 20).toString('hex')}...`);
  }
  sock.close();
});

sock.on('error', (err) => {
  console.error('❌ Socket lỗi:', err.message);
  sock.close();
});

sock.bind(0, () => {
  console.log(`📤 Gửi RakNet Ping tới ${LOCAL_HOST}:${LOCAL_PORT}...`);
  sock.send(ping, LOCAL_PORT, LOCAL_HOST);
});

setTimeout(() => {
  if (!replied) {
    console.log('❌ Game KHÔNG phản hồi sau 3s');
    console.log('   Nguyên nhân có thể:');
    console.log('   1. Minecraft Bedrock chưa mở / chưa vào World');
    console.log('   2. Game không lắng nghe trên port 19132');
    console.log('   3. Windows Firewall chặn node.js gửi UDP nội bộ');
    console.log('');
    console.log('   Thử thêm: node test-local-game.js 7551');
  }
  try { sock.close(); } catch (_) {}
}, 3000);

// Hỗ trợ port tuỳ chỉnh qua CLI
const testPort = parseInt(process.argv[2] || '19132', 10);
if (testPort !== 19132) {
  console.log(`Testing port ${testPort} instead...`);
  sock.removeAllListeners('message');
  // Re-add
  sock.on('message', (msg, rinfo) => {
    replied = true;
    console.log(`✅ Something listening at ${rinfo.address}:${rinfo.port} (${msg.length}B)`);
    sock.close();
  });
  sock.send(ping, testPort, LOCAL_HOST, () => {
    console.log(`📤 Gửi tới ${LOCAL_HOST}:${testPort}`);
  });
}
