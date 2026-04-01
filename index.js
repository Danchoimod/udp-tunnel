const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const mode = args[0] || 'server'; 

if (mode === '-h' || mode === '--help' || (mode !== 'server' && mode !== 'host' && mode !== 'client')) {
    console.log("🚀 BEDROCK TUNNEL (Kami Style)");
    console.log("Usage:");
    console.log("  node index.js server [port]          (Mặc định port 25284)");
    console.log("  node index.js host <LOCAL_PORT>      (Ví dụ: node index.js host 19132)");
    console.log("\nOptions:");
    console.log("  --proto <tcp|udp>   Giao thức (Mặc định: udp)");
    console.log("  --host <ip>        Host nội bộ (Mặc định: 127.0.0.1)");
    process.exit(0);
}

// Xử lý tham số nhanh
let port = args[1] || (mode === 'server' ? '25284' : '19132');
let proto = 'udp';
let host = '127.0.0.1';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--proto') proto = args[i+1];
    if (args[i] === '--host') host = args[i+1];
}

const script = mode === 'server' ? 'src/server.js' : 'src/host.js';
const config = mode === 'server' ? 'configs/server.config.json' : 'configs/agent.config.json';

console.log(`\x1b[32m[STARTING]\x1b[0m BEDROCK ${mode.toUpperCase()} on Port ${port} (${proto}) -> ${host}`);

const child = spawn('node', [
    `"${path.join(__dirname, script)}"`, 
    `"${config}"`,
    port,
    proto,
    host
], {
    stdio: 'inherit',
    shell: true
});

child.on('exit', (code) => process.exit(code));
