'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// What happens once the edits are pushed, so the site really shows them.
// A setting per site (see settings.js):
//   nothing              the push deploys by itself
//   { kind: 'cloudpipe', id }      ask CloudPipe to deploy that project
//   { kind: 'command', command }   run a command in the project folder

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_COMMAND = 500;
const TRIGGER_TIMEOUT_MS = 15000;

function parseAfter(kind, value) {
  const text = String(value || '').trim();
  if (!kind || kind === 'push') return { after: null };
  if (kind === 'cloudpipe') {
    return PROJECT_ID.test(text) ? { after: { kind, id: text } } : { error: 'CloudPipe 的專案代號看不懂' };
  }
  if (kind === 'command') {
    return text && text.length <= MAX_COMMAND ? { after: { kind, command: text } } : { error: '要跑的指令沒填，或太長' };
  }
  return { error: '送出後要做什麼看不懂' };
}

function describeAfter(after) {
  if (!after) return 'push 就會自己部署';
  return after.kind === 'cloudpipe' ? `叫 CloudPipe 部署 ${after.id}` : `跑 ${after.command}`;
}

// The CloudPipe key: CLOUDPIPE_TOKEN, or the serviceToken in the file CLOUDPIPE_CONFIG points at.
function cloudpipeToken({ token, configFile }) {
  if (token) return token;
  if (!configFile) return '';
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^﻿/, '')).serviceToken || ''; } catch (_) { return ''; }
}

async function askCloudpipe(cloudpipe, id) {
  const token = cloudpipeToken(cloudpipe || {});
  if (!token) throw new Error('沒有 CloudPipe 的金鑰（.env 的 CLOUDPIPE_TOKEN 或 CLOUDPIPE_CONFIG）');
  let res;
  try {
    res = await fetch(`${cloudpipe.url}/api/_admin/deploy/projects/${encodeURIComponent(id)}/deploy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });
  } catch (_) {
    throw new Error('連不上 CloudPipe');
  }
  if (!res.ok) throw new Error(`CloudPipe 回了 ${res.status}`);
}

// Started and left alone: the command may restart this very service.
function runCommand(repo, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: repo, shell: true, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function runAfter(config, repo, after) {
  if (!after) return;
  if (after.kind === 'cloudpipe') await askCloudpipe(config.cloudpipe, after.id);
  else await runCommand(repo, after.command);
}

module.exports = { parseAfter, describeAfter, runAfter };
