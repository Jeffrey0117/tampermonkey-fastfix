'use strict';
// Installs the shell into a real Tampermonkey (throwaway browser profile) and checks it runs. Read-only against the service.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [playwrightDir, extDir, shotDir, mode] = process.argv.slice(2);
const { chromium } = require(playwrightDir);
const say = (s) => process.stdout.write(s + '\n');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tm-'));
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: mode !== 'headed',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  say('browser ' + ctx.browser().version());
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  say('tampermonkey worker: ' + (sw ? sw.url() : 'none'));
  await new Promise((r) => setTimeout(r, 4000));

  const ext = await ctx.newPage();
  await ext.goto("chrome://extensions/");
  say("allow user scripts: " + await ext.evaluate(() => new Promise((res) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "dhdgffkkebhmkfjojejmpbldmpobfkfo", userScriptsAccess: true }, () => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : "on")))));
  await ext.waitForTimeout(3000);
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:4480/fastfix.user.js").catch((e) => say("goto: " + e.message.slice(0, 80)));
  let ask = null;
  for (let i = 0; i < 40 && !ask; i += 1) { ask = ctx.pages().find((p) => /ask.html/.test(p.url())); if (!ask) await page.waitForTimeout(500); }
  say("pages: " + ctx.pages().map((p) => p.url().slice(0, 70)).join(" | "));
  if (!ask) throw new Error("no install page");
  await ask.waitForLoadState('domcontentloaded').catch(() => {});
  await ask.waitForTimeout(3000);
  say('install page: ' + ask.url().slice(0, 90));
  await ask.screenshot({ path: path.join(shotDir, 'tm-ask.png') });
  const button = ask.locator('input[type=button], button').filter({ hasText: /install|安裝|安装/i }).first();
  const byValue = ask.locator('input[value*="nstall"], input[value*="安裝"], input[value*="安装"]').first();
  if (await byValue.count()) await byValue.click(); else await button.click({ timeout: 8000 });
  await ctx.pages()[0].waitForTimeout(3000);

  const w = ctx.serviceWorkers()[0];
  say("userScripts api: " + await w.evaluate(async () => { try { const l = await chrome.userScripts.getScripts(); return "ok, registered " + l.length; } catch (e) { return "blocked: " + e.message; } }));
  const site = await ctx.newPage();
  site.on('console', (m) => say('console: ' + m.text().slice(0, 300)));
  site.on('pageerror', (e) => say('pageerror: ' + e.message.slice(0, 300)));
  await site.goto('http://127.0.0.1:4480/setup');
  await site.waitForTimeout(6000);
  say('setup status: ' + await site.locator('#fastfix-status').textContent());
  await site.locator('h2').first().click({ modifiers: ['Alt'] });
  await site.waitForTimeout(2500);
  await site.screenshot({ path: path.join(shotDir, 'tm-setup.png') });
  await ctx.close();
})().catch((e) => { process.stderr.write('FAILED ' + e.stack + '\n'); process.exit(1); });
