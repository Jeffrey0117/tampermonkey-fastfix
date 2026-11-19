'use strict';
// Drives the real userscript in a headless browser: edit, send, wait for a slow "deploy", see it land.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const [repoDir, playwrightDir, shotPath] = process.argv.slice(2);
const { chromium } = require(playwrightDir);
const { createServer } = require(path.join(repoDir, 'src', 'server'));
const TOKEN = 'e2e-token-0123456789abcdef';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));
  const site = path.join(base, 'code', 'demo-site');
  const live = path.join(base, 'live');           // what the "deployed" site serves
  const bare = path.join(base, 'demo-site.git');
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'),
    '<!doctype html><meta charset="utf-8"><body style="font:20px sans-serif;padding:60px">\n<h1 id="t">立即免費開始</h1>\n<p id="j"></p>\n<script src="/app.js"></script>\n');
  fs.writeFileSync(path.join(site, 'app.js'), 'document.getElementById("j").textContent = "馬上試試";\n');
  // the "deploy": six seconds later the live copy catches up with the source
  fs.writeFileSync(path.join(site, 'deploy.js'),
    'const fs=require("fs");setTimeout(()=>{for(const f of ["index.html","app.js"])fs.copyFileSync(f,"../../live/"+f)},6000);\n');
  for (const f of ['index.html', 'app.js']) fs.copyFileSync(path.join(site, f), path.join(live, f));
  git(site, 'init', '-q', '-b', 'main');
  git(site, 'config', 'user.email', 'e2e@example.com');
  git(site, 'config', 'user.name', 'e2e');
  git(site, 'add', '-A');
  git(site, 'commit', '-q', '-m', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(site, 'remote', 'add', 'origin', bare);
  git(site, 'push', '-q', '-u', 'origin', 'main');

  const web = http.createServer((req, res) => {
    const file = req.url.startsWith('/app.js') ? 'app.js' : 'index.html';
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(live, file)));
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${web.address().port}`;

  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sites: { [host]: site }, after: { [host]: { kind: 'command', command: 'node deploy.js' } } }));
  const drop = createServer({ token: TOKEN, stateDir, roots: [path.join(base, 'code')] });
  await new Promise((r) => drop.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${drop.address().port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  page.on('pageerror', (err) => process.stderr.write(`page error: ${err.message}\n`));
  await page.exposeFunction('__gmFetch', async ({ method, url, headers, data }) => {
    const res = await fetch(url, { method, headers, body: data });
    return { status: res.status, responseText: await res.text() };
  });
  await page.addInitScript(({ endpoint: ep, token, userscript }) => {
    const store = { endpoint: ep, token, hosts: JSON.stringify([location.host]) };
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { return attach.call(this, { ...init, mode: 'open' }); };
    window.GM_getValue = (k, d) => (k in store ? store[k] : d);
    window.GM_setValue = (k, v) => { store[k] = v; };
    window.GM_registerMenuCommand = () => {};
    window.GM_setClipboard = () => {};
    window.GM_xmlhttpRequest = (o) => window.__gmFetch({ method: o.method, url: o.url, headers: o.headers, data: o.data }).then(o.onload, o.onerror);
    document.addEventListener('DOMContentLoaded', () => { new Function(userscript)(); });
  }, { endpoint, token: TOKEN, userscript: fs.readFileSync(path.join(repoDir, 'fastfix.user.js'), 'utf8') });
  await page.goto(`http://${host}/`);

  const change = async (selector, to) => {
    await page.locator(selector).click({ modifiers: ['Alt'] });
    await page.locator('textarea').fill(to);
    await page.locator('textarea').press('Enter');
  };

  // two edits: one lives in the page, one in a script the page loads
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await change('#t', '先用再說');                 // Enter sends by itself
  await page.waitForFunction(() => document.getElementById('t').textContent === '先用再說' && /dashed/.test(document.getElementById('t').style.outline));   // new words at once, marked as not live
  assert.match(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), /立即免費開始/);
  await page.getByText('已送出，等網站更新').waitFor();
  // the second one is sent straight from the box
  await page.locator('#j').click({ modifiers: ['Alt'] });
  await page.locator('textarea').fill('現在就試');
  await page.locator('.box button.go').click();

  // send: the site is still the old one, so it waits and says so
  const sentBoth = () => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).deliveries[site].checks.length === 2; } catch (_) { return false; } };
  for (let i = 0; i < 100 && !sentBoth(); i += 1) await page.waitForTimeout(100);
  assert.ok(sentBoth(), 'the second edit was sent too');
  await page.getByText('已送出，等網站更新').waitFor();
  await page.screenshot({ path: shotPath });
  assert.match(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), /立即免費開始/, 'not deployed yet');
  assert.equal(loads, 0);

  // a reload in the middle picks the wait up again
  await page.reload();
  await page.getByText('已送出，等網站更新').waitFor();
  await page.waitForFunction(() => document.getElementById('t').textContent === '先用再說' && /dashed/.test(document.getElementById('t').style.outline));   // put back after the reload
  assert.match(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), /立即免費開始/, 'the site itself is still the old one');

  // the deploy lands: it notices, says so, and reloads by itself onto the new words
  const before = loads;
  await page.getByText('已上線 ✓').waitFor({ timeout: 30000 });
  await page.screenshot({ path: shotPath.replace('.png', '-live.png') });
  await page.waitForFunction(() => document.getElementById('t').style.outline === '' && document.getElementById('t').textContent === '先用再說' && document.getElementById('j').textContent === '現在就試', null, { timeout: 15000 });
  assert.ok(loads > before, 'reloaded by itself');
  await page.waitForTimeout(1500);
  assert.equal(await page.getByText('已送出').count(), 0, 'nothing left to wait for');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).deliveries[site].status, 'live');

  await browser.close();
  drop.close();
  web.close();
  process.stdout.write('E2E OK\n');
})().catch((err) => { process.stderr.write(`E2E FAILED: ${err.stack}\n`); process.exit(1); });
