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
    '<!doctype html><meta charset="utf-8"><body style="font:20px sans-serif;padding:60px">\n<h1 id="t">立即免費開始</h1>\n<p id="dup">先用再說</p>\n<p id="s">樣式這段</p>\n<p id="j"></p>\n<script src="/app.js"></script>\n');
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

  let loads = 0;
  page.on('load', () => { loads += 1; });
  const liveHtml = () => fs.readFileSync(path.join(live, 'index.html'), 'utf8');
  const outline = (sel) => page.locator(sel).evaluate((n) => n.style.outline);

  // 1. the new words are already somewhere else on the page: that must not count as live
  await change('#t', '先用再說');
  await page.getByText('已送出，等網站更新').waitFor();
  await page.waitForTimeout(3000);
  assert.match(liveHtml(), /立即免費開始/, 'not deployed yet');
  assert.equal(loads, 0, 'did not take the other 先用再說 for the change');
  assert.equal(await page.getByText('已上線').count(), 0);

  // 2. F5 in the middle: the change that is on its way is put back, outline and all
  await page.reload();
  await page.waitForFunction(() => document.getElementById('t').textContent === '先用再說' && /dashed/.test(document.getElementById('t').style.outline), null, { timeout: 10000 });
  assert.equal(await outline('#dup'), '', 'only the changed spot is marked');
  assert.match(liveHtml(), /立即免費開始/, 'still not deployed: what is shown was put back by the script');

  // the deploy lands: reload by itself, no outline left
  let before = loads;
  await page.getByText('已上線 ✓').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('t').style.outline === '' && document.getElementById('t').textContent === '先用再說', null, { timeout: 15000 });
  assert.ok(loads > before, 'reloaded by itself');
  await page.waitForTimeout(1500);

  // 3. a change of look only: it is checked at its spot too
  await page.locator('#s').click({ modifiers: ['Alt'] });
  await page.locator('.box button', { hasText: 'A+' }).click();
  await page.locator('.box button', { hasText: '粗' }).click();
  await page.locator('textarea').press('Enter');
  await page.getByText('已送出，等網站更新').waitFor();
  assert.equal(await page.getByText('沒辦法自動確認').count(), 0);
  assert.doesNotMatch(liveHtml(), /id="s"[^>]*style=|style=[^>]*id="s"/, 'look not deployed yet');
  await page.screenshot({ path: shotPath });
  await page.reload();                                   // F5: the look comes back as well
  await page.waitForFunction(() => document.getElementById('s').style.fontSize !== '' && /dashed/.test(document.getElementById('s').style.outline), null, { timeout: 10000 });
  before = loads;
  await page.getByText('已上線 ✓').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('s').style.outline === '' && document.getElementById('s').style.fontSize !== '', null, { timeout: 15000 });
  assert.ok(loads > before, 'reloaded by itself after the look went live');
  assert.match(liveHtml(), /<p style="[^"]*font-size[^"]*" id="s">|<p id="s" style="[^"]*font-size/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).deliveries[site].status, 'live');

  await browser.close();
  drop.close();
  web.close();
  process.stdout.write('E2E OK\n');
})().catch((err) => { process.stderr.write(`E2E FAILED: ${err.stack}\n`); process.exit(1); });
