'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { askCloudpipe } = require('./cloudpipe');

// What happens once the edits are pushed, so the site really shows them.
// A setting per site (see settings.js):
//   nothing              the push deploys by itself
//   { kind: 'cloudpipe', id }      ask CloudPipe to deploy that project
//   { kind: 'command', command }   run a command in the project folder

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_COMMAND = 500;

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

// Started and left alone: the command may restart this very service.
// On Windows a detached shell opens a black window of its own, so the command goes
// through a windowless script host instead (scripts/run-hidden.vbs).
const RUN_HIDDEN = path.join(__dirname, '..', '..', 'scripts', 'run-hidden.vbs');
function runCommand(repo, command) {
  return new Promise((resolve, reject) => {
    const base = { cwd: repo, detached: true, stdio: 'ignore', windowsHide: true };
    const child = process.platform === 'win32'
      ? spawn('wscript', ['//B', '//Nologo', RUN_HIDDEN], { ...base, env: { ...process.env, FASTFIX_RUN: command } })
      : spawn(command, { ...base, shell: true });
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
