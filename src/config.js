'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '.env');

// Tiny .env reader (KEY=value per line). Real environment variables win.
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function loadConfig(env = process.env) {
  const merged = { ...readEnvFile(ENV_FILE), ...env };
  const token = merged.FASTFIX_TOKEN;
  if (!token || token.length < 20) {
    throw new Error('FASTFIX_TOKEN is missing or shorter than 20 characters. Run "npm run init" to create .env.');
  }
  const port = Number(merged.PORT || 4480);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT is not a valid port: ${merged.PORT}`);
  return {
    token,
    port,
    host: merged.HOST || '127.0.0.1',
    stateDir: merged.FASTFIX_HOME || path.join(os.homedir(), '.fastfix'),
    // Where your site repos live. Default: the folder this repo sits in.
    roots: (merged.FASTFIX_ROOTS || path.resolve(__dirname, '..', '..')).split(path.delimiter).filter(Boolean),
    // Only used by sites set to "ask CloudPipe to deploy". The key comes from CLOUDPIPE_TOKEN,
    // or from the serviceToken in the CloudPipe config file CLOUDPIPE_CONFIG points at.
    cloudpipe: {
      url: String(merged.CLOUDPIPE_URL || 'http://localhost:8787').replace(/\/+$/, ''),
      token: merged.CLOUDPIPE_TOKEN || '',
      configFile: merged.CLOUDPIPE_CONFIG || '',
    },
  };
}

module.exports = { loadConfig, ENV_FILE };
