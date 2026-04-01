const { spawn } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'server'; 
const configFile = process.argv[3];

if (mode !== 'server' && mode !== 'host' && mode !== 'client' && mode !== 'agent') {
    console.log("Usage: node index.js [server|host|client] [config_path]");
    console.log("Example:");
    console.log("  node index.js server configs/server.config.json");
    console.log("  node index.js host configs/agent.config.json");
    process.exit(1);
}

const script = mode === 'server' ? 'src/server.js' : (mode === 'host' || mode === 'agent' ? 'src/host.js' : 'src/client.js');
const defaultConfig = mode === 'server' ? 'configs/server.config.json' : (mode === 'host' || mode === 'agent' ? 'configs/agent.config.json' : 'configs/client.config.json');
const config = configFile || defaultConfig;

console.log(`Starting BEDROCK ${mode.toUpperCase()} with config: ${config}...`);

const child = spawn('node', [`"${path.join(__dirname, script)}"`, `"${config}"`], {
    stdio: 'inherit',
    shell: true
});

child.on('exit', (code) => {
    process.exit(code);
});
