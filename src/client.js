const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

/**
 * Tunnel Client Proxy - For Players (C, D, E, F, ...)
 * Lắng nghe tại máy người chơi (localhost:19132) và chuyển tiếp tới Tunnel Server (A)
 */

function loadConfig(configPath) {
  try {
    const resolvedPath = path.resolve(process.cwd(), configPath);
    return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (err) {
    console.error("Lỗi đọc config:", err.message);
    process.exit(1);
  }
}

function startClientProxy(config) {
  const clientUdp = dgram.createSocket("udp4");
  
  // Lưu trữ địa chỉ của người chơi vừa gửi gói tin tới (thường là 127.0.0.1)
  let lastPlayerAddress = null;
  let lastPlayerPort = null;

  clientUdp.on("message", (msg, rinfo) => {
    // 1. Nếu gói đến từ máy A (Backend) -> Gửi trả lại cho Minecraft local
    if (rinfo.address === config.serverHost || rinfo.port === config.serverUdpPort) {
      if (lastPlayerAddress && lastPlayerPort) {
        clientUdp.send(msg, lastPlayerPort, lastPlayerAddress);
      }
    } 
    // 2. Nếu gói đến từ Minecraft local -> Gửi lên máy A
    else {
      lastPlayerAddress = rinfo.address;
      lastPlayerPort = rinfo.port;
      clientUdp.send(msg, config.serverUdpPort, config.serverHost);
    }
  });

  clientUdp.on("error", (err) => {
    console.error("Lỗi UDP Client:", err.message);
  });

  clientUdp.bind(19132, "0.0.0.0", () => {
    console.log(`\n====================================================`);
    console.log(`[CLIENT PROXY] Đang giả lập LAN tại: 127.0.0.1:19132`);
    console.log(`[INFO] Đang chuyển tiếp tới Máy A: ${config.serverHost}:${config.serverUdpPort}`);
    console.log(`====================================================\n`);
  });
}

const configPath = process.argv[2] || "configs/client.config.json";
const config = loadConfig(configPath);
startClientProxy(config);
