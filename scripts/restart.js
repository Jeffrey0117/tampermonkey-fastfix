'use strict';
// Restarts the fastFix service: stops the one process listening on its port and
// starts it again with no window. If the code does not load, the running one is left alone.
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const WAIT_MS = 1000;      // lets a request that asked for this restart get its answer first

function listeningPids(port) {
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  const pids = out.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[3] === 'LISTENING' && cols[1] && cols[1].endsWith(`:${port}`))
    .map((cols) => cols[4]);
  return [...new Set(pids)].filter((pid) => /^\d+$/.test(pid) && pid !== '0');
}

function main() {
  if (process.platform !== 'win32') throw new Error('scripts/restart.js only knows Windows; restart the service your own way.');
  const { loadConfig } = require('../src/config');
  require('../src/server');                       // throws here when the code is broken
  const { port } = loadConfig();
  setTimeout(() => {
    for (const pid of listeningPids(port)) execFileSync('taskkill', ['/f', '/pid', pid], { stdio: 'ignore', windowsHide: true });
    spawn('wscript', [path.join(__dirname, 'start-hidden.vbs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }, WAIT_MS);
}

try { main(); } catch (err) {
  process.stderr.write(`[fastfix] restart: ${err.message}\n`);
  process.exitCode = 1;
}
