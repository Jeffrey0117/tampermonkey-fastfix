'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');

const TOKEN = 'test-token-0123456789';
const KEY = 'cloudpipe-key';
const HOST = 'shop.example.test';          // "<project id>.<CloudPipe's domain>"
const PAGE = `https://${HOST}/`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function clone(base, bare, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(base, 'clone', '-q', '-c', 'core.autocrlf=false', bare, dir);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.autocrlf', 'false');
}

// A stand-in for CloudPipe: its settings, its projects, its deployments, and the deploys it was asked for.
async function fakeCloudpipe(base, bare, project = {}) {
  const cp = { deployments: [], asked: [], down: false };
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (cp.down) return send(503, {});
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, {});
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/_admin/config') return send(200, { domain: 'example.test' });
    if (pathname === '/api/_admin/deploy/projects') {
      return send(200, { projects: [{ id: 'shop', branch: 'main', repoUrl: bare, directory: '../workhub/shop', webhookId: 'hook-1', customDomains: ['www.shop.test'], ...project }] });
    }
    if (pathname === '/api/_admin/deploy/deployments') return send(200, { deployments: cp.deployments });
    if (req.method === 'POST' && pathname === '/api/_admin/deploy/projects/shop/deploy') { cp.asked.push(pathname); return send(200, { ok: true }); }
    return send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // CloudPipe's own folder: its config file sits here, and "../workhub/shop" is counted from here
  const configFile = path.join(base, 'cloudpipe', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ serviceToken: KEY }));
  cp.settings = { url: `http://127.0.0.1:${server.address().port}`, token: '', configFile };
  cp.close = () => new Promise((r) => server.close(r));
  return cp;
}

// A project CloudPipe deploys: the running copy in workhub/shop, the working copy in code/shop.
// Nothing is set on the fastFix settings page.
async function boot({ project, roots, devCopy = true, sites = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fastfix-cp-'));
  const bare = path.join(base, 'shop.git');
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  git(seed, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(seed, 'index.html'), '<h1>立即免費開始</h1>\n', 'utf8');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', '-u', 'origin', 'main');

  const running = path.join(base, 'workhub', 'shop');
  const dev = path.join(base, 'code', 'shop');
  clone(base, bare, running);
  if (devCopy) clone(base, bare, dev); else fs.mkdirSync(path.join(base, 'code'), { recursive: true });

  const cp = await fakeCloudpipe(base, bare, project);
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sites: Object.fromEntries(Object.entries(sites).map(([h, d]) => [h, path.join(base, d)])) }));
  const server = createServer({ token: TOKEN, stateDir, roots: (roots || ['code']).map((r) => path.join(base, r)), cloudpipe: cp.settings });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const res = await fetch(url + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const read = (dir) => fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  return { base, bare, running, dev, cp, url, call, read, close: async () => { await new Promise((r) => server.close(r)); await cp.close(); } };
}

const fix = (s, to = '先用再說', page = PAGE) => s.call('POST', '/fix', { text: '立即免費開始', to, url: page });

test('a site CloudPipe deploys needs no line on the settings page: its working copy is edited, the running copy is not', async () => {
  const s = await boot();
  try {
    const res = await fix(s);
    assert.equal(res.json.status, 'done', JSON.stringify(res.json));
    assert.match(s.read(s.dev), /先用再說/);
    assert.match(s.read(s.running), /立即免費開始/, 'the copy CloudPipe runs is left alone');
    assert.equal((await fix(s, '自訂網域也行', 'https://www.shop.test/')).json.status, 'done', 'a custom domain of the same project');
  } finally { await s.close(); }
});

test('when the only copy on this machine is the one CloudPipe runs, nothing is edited', async () => {
  const s = await boot({ devCopy: false, roots: ['code', 'workhub'] });
  try {
    const res = await fix(s);
    assert.equal(res.json.status, 'unset');
    assert.match(res.json.reason, /正在跑的那一份/);
    assert.match(s.read(s.running), /立即免費開始/);
    assert.equal(git(s.running, 'status', '--porcelain').trim(), '');
  } finally { await s.close(); }
});

test('with both copies in reach, the working copy is the one that is edited', async () => {
  const s = await boot({ roots: ['workhub', 'code'] });
  try {
    assert.equal((await fix(s)).json.status, 'done');
    assert.match(s.read(s.dev), /先用再說/);
    assert.match(s.read(s.running), /立即免費開始/);
  } finally { await s.close(); }
});

test('no working copy on this machine: it says so', async () => {
  const s = await boot({ devCopy: false });
  try {
    const res = await fix(s);
    assert.equal(res.json.status, 'unset');
    assert.match(res.json.reason, /找不到 shop 開發用的資料夾/);
  } finally { await s.close(); }
});

test('a working copy on another branch, or one that pushes somewhere else, is not used', async () => {
  const s = await boot();
  try {
    git(s.dev, 'checkout', '-q', '-b', 'experiment');
    const branch = await fix(s);
    assert.equal(branch.json.status, 'unset');
    assert.match(branch.json.reason, /experiment 分支.*main/);
    git(s.dev, 'checkout', '-q', 'main');
    git(s.dev, 'remote', 'set-url', 'origin', path.join(s.base, 'somewhere-else.git'));
    const origin = await fix(s);
    assert.equal(origin.json.status, 'unset');
    assert.match(origin.json.reason, /不是 CloudPipe 部署的那個 repo/);
    assert.match(s.read(s.dev), /立即免費開始/);
  } finally { await s.close(); }
});

test('a line on the settings page wins over CloudPipe', async () => {
  const s = await boot({ sites: { [HOST]: 'seed' } });
  try {
    assert.equal((await fix(s)).json.status, 'done');
    assert.match(s.read(path.join(s.base, 'seed')), /先用再說/);
    assert.match(s.read(s.dev), /立即免費開始/);
  } finally { await s.close(); }
});

test('a project that hides its default domain is only reached by its custom one', async () => {
  const s = await boot({ project: { hideDefaultDomain: true } });
  try {
    assert.equal((await fix(s)).json.status, 'unset');
    assert.equal((await fix(s, '先用再說', 'https://www.shop.test/')).json.status, 'done');
  } finally { await s.close(); }
});

test('CloudPipe cannot be reached: the site is simply not known, nothing breaks', async () => {
  const s = await boot();
  try {
    s.cp.down = true;
    const res = await fix(s);
    assert.deepEqual([res.status, res.json.status, res.json.reason], [200, 'unset', undefined]);
    assert.equal((await s.call('GET', `/pending?host=${HOST}`)).json.count, 0);
  } finally { await s.close(); }
});

test('send: a push to a project with a webhook deploys by itself; the deploy is followed, and a failed one can be asked for again', async () => {
  const s = await boot();
  try {
    await fix(s);
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.json.delivery.status, 'waiting');
    assert.deepEqual(s.cp.asked, [], 'the push is what starts the deploy');
    assert.match(git(s.bare, 'show', 'main:index.html'), /先用再說/);

    const pending = () => s.call('GET', `/pending?host=${HOST}`).then((r) => r.json.delivery);
    assert.equal((await pending()).stage, undefined, 'CloudPipe has not started on it yet');

    const commit = sent.json.commit;
    s.cp.deployments = [
      { projectId: 'shop', commit: 'aaaaaaa', status: 'failed', error: 'an older deploy', startedAt: '2026-01-01T00:00:00Z' },
      { projectId: 'shop', commit, status: 'building', startedAt: '2026-01-02T00:00:00Z' },
    ];
    assert.deepEqual([(await pending()).status, (await pending()).stage], ['waiting', 'building']);

    s.cp.deployments = [{ projectId: 'shop', commit, status: 'failed', error: 'npm run build 失敗', startedAt: '2026-01-02T00:00:00Z' }];
    const failed = await pending();
    assert.deepEqual([failed.status, failed.error], ['failed', 'CloudPipe 部署失敗：npm run build 失敗']);
    assert.deepEqual(failed.checks.map((c) => c.to), ['先用再說'], 'still knows what to look for');

    const again = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(again.json.delivery.status, 'waiting');
    assert.equal(s.cp.asked.length, 1, 'trying again asks CloudPipe for the deploy');
    assert.equal(git(s.dev, 'rev-list', '--count', 'HEAD').trim(), '2', 'no second commit');
  } finally { await s.close(); }
});

test('send: a project without a webhook gets its deploy asked for after the push', async () => {
  const s = await boot({ project: { webhookId: undefined } });
  try {
    await fix(s);
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.json.delivery.status, 'waiting');
    assert.equal(s.cp.asked.length, 1);
  } finally { await s.close(); }
});

test('settings page: lists the sites that come from CloudPipe and the folder each one edits', async () => {
  const s = await boot();
  try {
    const html = await (await fetch(`${s.url}/setup`)).text();
    assert.match(html, /CloudPipe 上的站/);
    assert.match(html, /<td>shop\.example\.test<\/td>\s*<td>shop<\/td>/);
    assert.match(html, /<td>www\.shop\.test<\/td>/);
  } finally { await s.close(); }
});
