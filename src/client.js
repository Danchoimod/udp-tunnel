const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  return JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
}

function startClientProxy(config) {
  // Config mẫu: ports: [{ local: 19132, remote: 19132 }, { local: 7551, remote: 7551 }]
  config.ports.forEach(p => {
    const clientUdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    
    let lastPlayerAddress = null;
    let lastPlayerPort = null;

    clientUdp.on("message", (msg, rinfo) => {
      // Nếu gói từ Server A -> Trả về Minecraft
      if (rinfo.address === config.serverHost && rinfo.port === p.remotePort) {
        if (lastPlayerAddress && lastPlayerPort) {
          clientUdp.send(msg, lastPlayerPort, lastPlayerAddress);
        }
      } 
      // Nếu gói từ Minecraft local -> Gửi lên Server A
      else {
        lastPlayerAddress = rinfo.address;
        lastPlayerPort = rinfo.port;
        clientUdp.send(msg, p.remotePort, config.serverHost);
      }
    });

    clientUdp.bind(p.localPort, "0.0.0.0", () => {
      console.log(`[Proxy] Local ${p.localPort} <-> Remote ${config.serverHost}:${p.remotePort}`);
    });
  });
}

const config = loadConfig(process.argv[2] || "configs/client.config.json");
startClientProxy(config);
