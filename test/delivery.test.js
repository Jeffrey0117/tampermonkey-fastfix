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
const HOST = 'shop.example.com';
const PAGE = `https://${HOST}/pricing`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// One site repo that pushes to a bare remote, already set for shop.example.com.
async function boot({ after, cloudpipe } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fastfix-'));
  const shop = path.join(base, 'code', 'shop');
  const bare = path.join(base, 'shop.git');
  fs.mkdirSync(shop, { recursive: true });
  git(shop, 'init', '-q', '-b', 'main');
  git(shop, 'config', 'user.email', 'test@example.com');
  git(shop, 'config', 'user.name', 'test');
  git(shop, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(shop, 'index.html'), '<h1>立即免費開始</h1>\n<p>了解方案</p>\n', 'utf8');
  git(shop, 'add', '-A');
  git(shop, 'commit', '-q', '-m', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(shop, 'remote', 'add', 'origin', bare);
  git(shop, 'push', '-q', '-u', 'origin', 'main');

  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ sites: { [HOST]: shop }, after: after ? { [HOST]: after } : {} }));
  const server = createServer({ token: TOKEN, stateDir, roots: [path.join(base, 'code')], cloudpipe });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const res = await fetch(url + pathname, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  const form = (pathname, fields) => fetch(url + pathname, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN, ...fields }),
  });
  const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return { shop, base, url, call, form, state, close: () => new Promise((r) => server.close(r)) };
}

// Stands in for CloudPipe: remembers what it was asked.
async function fakeCloudpipe(status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const waitFor = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('send: leaves a delivery that waits until the page is seen with the new words', async () => {
  const s = await boot();
  try {
    await s.call('POST', '/fix', { text: '立即免費開始', to: '先用再說', url: `${PAGE}#top` });
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.status, 200);
    assert.deepEqual({ status: sent.json.delivery.status, checks: sent.json.delivery.checks },
      { status: 'waiting', checks: [{ page: PAGE, to: '先用再說' }] });

    const open = await s.call('GET', `/pending?host=${HOST}`);
    assert.equal(open.json.count, 0);
    assert.equal(open.json.delivery.status, 'waiting', 'a reloaded page picks the wait up again');

    assert.equal((await s.call('POST', '/landed', { url: PAGE, result: 'nonsense' })).status, 400);
    assert.equal((await s.call('POST', '/landed', { url: PAGE, result: 'live' })).status, 200);
    assert.equal((await s.call('GET', `/pending?host=${HOST}`)).json.delivery, undefined);
    assert.equal(s.state().deliveries[s.shop].status, 'live');
  } finally { await s.close(); }
});

test('send: words changed twice are only looked for in their last form; look-only edits have nothing to look for', async () => {
  const s = await boot();
  try {
    await s.call('POST', '/fix', { text: '立即免費開始', to: '先用再說', url: PAGE });
    await s.call('POST', '/fix', { text: '先用再說', to: '馬上開始', url: PAGE });
    await s.call('POST', '/style', { text: '了解方案', look: { fontWeight: '700' }, url: PAGE });
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.json.count, 3);
    assert.deepEqual(sent.json.delivery.checks, [{ page: PAGE, to: '馬上開始' }]);
  } finally { await s.close(); }
});

test('send: a site set to "ask CloudPipe" gets its deploy asked for after the push', async () => {
  const cp = await fakeCloudpipe();
  const s = await boot({ after: { kind: 'cloudpipe', id: 'shop-site' }, cloudpipe: { url: cp.url, token: 'cloudpipe-key', configFile: '' } });
  try {
    await s.call('POST', '/fix', { text: '立即免費開始', to: '先用再說', url: PAGE });
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.json.delivery.status, 'waiting');
    assert.deepEqual(cp.seen, [{ method: 'POST', url: '/api/_admin/deploy/projects/shop-site/deploy', auth: 'Bearer cloudpipe-key' }]);
    assert.match(git(path.join(s.base, 'shop.git'), 'log', '-1', '--format=%s'), /網頁改字 1 處/, 'pushed before the deploy was asked for');
  } finally { await s.close(); await cp.close(); }
});

test('send: when asking for the deploy fails the delivery says so, and sending again retries only the deploy', async () => {
  const down = await fakeCloudpipe(500);
  const s = await boot({ after: { kind: 'cloudpipe', id: 'shop-site' }, cloudpipe: { url: down.url, token: 'cloudpipe-key', configFile: '' } });
  try {
    await s.call('POST', '/fix', { text: '立即免費開始', to: '先用再說', url: PAGE });
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.status, 200, 'the push itself worked');
    assert.deepEqual([sent.json.delivery.status, sent.json.delivery.error], ['failed', '叫部署失敗：CloudPipe 回了 500']);
    assert.equal((await s.call('GET', `/pending?host=${HOST}`)).json.delivery.status, 'failed');

    const again = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(again.status, 200);
    assert.equal(down.seen.length, 2);
    assert.deepEqual(again.json.delivery.checks, [{ page: PAGE, to: '先用再說' }], 'still knows what to look for');
    assert.equal(git(s.shop, 'rev-list', '--count', 'HEAD').trim(), '2', 'no second commit');
  } finally { await s.close(); await down.close(); }
});

test('send: a site set to "run a command" runs it in the project folder', async () => {
  const s = await boot({ after: { kind: 'command', command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',process.cwd())"' } });
  try {
    await s.call('POST', '/fix', { text: '立即免費開始', to: '先用再說', url: PAGE });
    assert.equal((await s.call('POST', '/submit', { url: PAGE })).json.delivery.status, 'waiting');
    const marker = path.join(s.shop, 'ran.txt');
    assert.ok(await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8')), 'the command ran');
    assert.equal(fs.realpathSync(fs.readFileSync(marker, 'utf8')), fs.realpathSync(s.shop));
  } finally { await s.close(); }
});

test('send: with nothing pending and nothing failed there is nothing to send', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('POST', '/submit', { url: PAGE })).status, 400);
  } finally { await s.close(); }
});

test('settings: what happens after a send is saved with the site and shown on the page', async () => {
  const s = await boot();
  try {
    assert.equal((await s.form('/setup/sites', { host: HOST, project: 'shop', after: 'cloudpipe', afterValue: 'shop-site' })).status, 303);
    assert.deepEqual(s.state().after, { [HOST]: { kind: 'cloudpipe', id: 'shop-site' } });
    assert.match(await (await fetch(`${s.url}/setup`)).text(), /叫 CloudPipe 部署 shop-site/);

    const bad = await s.form('/setup/sites', { host: HOST, project: 'shop', after: 'cloudpipe', afterValue: '../x y' });
    assert.match(decodeURIComponent(bad.headers.get('location')), /專案代號看不懂/);
    assert.deepEqual(s.state().after[HOST], { kind: 'cloudpipe', id: 'shop-site' }, 'a refused change leaves the setting alone');

    await s.form('/setup/sites', { host: HOST, project: 'shop', after: 'push', afterValue: '' });
    assert.deepEqual(s.state().after, {});
    assert.match(await (await fetch(`${s.url}/setup`)).text(), /push 就會自己部署/);
  } finally { await s.close(); }
});

test('setup page: opens when reached by a link from another page, but its content is not handed to other pages', async () => {
  const s = await boot();
  try {
    const get = (headers) => fetch(`${s.url}/setup`, { headers }).then((r) => r.status);
    assert.equal(await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), 200, 'a clicked link or a reload of one');
    assert.equal(await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), 403, 'a script on another page');
    assert.equal(await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }), 403, 'framed by another page');
  } finally { await s.close(); }
});
