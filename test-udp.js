/**
 * test-udp.js — Test xem UDP port 25294 trên server có nhận được packet không
 * Chạy: node test-udp.js
 */
const dgram = require('dgram');

const SERVER_HOST = 'mbasic7.pikamc.vn';
const SERVER_PORT = 25294;

const sock = dgram.createSocket('udp4');
const payload = Buffer.from('PING_TEST_FROM_CLIENT');

let replied = false;

sock.on('message', (msg, rinfo) => {
  replied = true;
  console.log(`✅ Nhận được reply từ ${rinfo.address}:${rinfo.port} — ${msg.length} bytes`);
  console.log(`   Raw: ${msg.toString('hex')}`);
  sock.close();
});

sock.on('error', (err) => {
  console.error('❌ UDP socket lỗi:', err.message);
  sock.close();
});

sock.bind(0, () => {
  console.log(`📤 Gửi UDP test tới ${SERVER_HOST}:${SERVER_PORT}...`);
  sock.send(payload, SERVER_PORT, SERVER_HOST, (err) => {
    if (err) {
      console.error('❌ Gửi thất bại:', err.message);
      sock.close();
    } else {
      console.log(`   Đã gửi ${payload.length} bytes`);
    }
  });
});

// Timeout sau 5 giây
setTimeout(() => {
  if (!replied) {
    console.log('⚠️  Không nhận được reply sau 5s');
    console.log('   → VPS firewall có thể đang block UDP 25294');
    console.log('   → Hoặc server chưa nhận được packet (kiểm tra log trên VPS)');
  }
  try { sock.close(); } catch (_) {}
  process.exit(0);
}, 5000);
