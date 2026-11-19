'use strict';
const { loadConfig } = require('./src/config');
const { createServer } = require('./src/server');

const config = loadConfig();
const server = createServer(config);

server.on('error', (err) => {
  process.stderr.write(`[fastfix] cannot listen on ${config.host}:${config.port}: ${err.message}\n`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`[fastfix] listening on http://${config.host}:${config.port}  →  ${config.roots.join(', ')}\n`);
});
