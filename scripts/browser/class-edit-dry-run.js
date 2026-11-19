'use strict';
// Dry run of the class editing against real pages: nothing is written anywhere.
const fs = require('node:fs');
const path = require('node:path');
const [playwrightDir, fastfix, repo, origin] = process.argv.slice(2);
const { chromium } = require(playwrightDir);
const { parseMark, restyleByElement } = require(path.join(fastfix, 'src', 'fix', 'element'));

const files = [];
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(tsx?|jsx?)$/.test(e.name)) files.push({ file: path.relative(repo, f).split(path.sep).join('/'), code: fs.readFileSync(f, 'utf8') }); } })(repo);
function whereWords(text) {
  const hits = [];
  for (const { file, code } of files) { let i = code.indexOf(text); while (i >= 0 && hits.length < 2) { hits.push({ file, line: code.slice(0, i).split('\n').length }); i = code.indexOf(text, i + 1); } }
  return hits.length === 1 ? hits[0] : null;
}
const grab = () => {
  const out = []; const seen = new Set();
  const classesOf = (n) => (typeof n.className === 'string' ? n.className.split(/\s+/).filter(Boolean) : []);
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    const direct = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    if (direct.length < 2) continue;
    const key = el.tagName + '|' + el.className + '|' + direct; if (seen.has(key)) continue; seen.add(key);
    const chain = []; for (let p = el.parentElement; p && p !== document.documentElement && chain.length < 20; p = p.parentElement) chain.push({ tag: p.localName, classes: classesOf(p) });
    out.push({ text: direct, mark: { tag: el.localName, classes: classesOf(el), chain, width: innerWidth } });
  }
  return out;
};
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const tally = { done: 0, unsure: 0, cant: 0, noclass: 0 }; const times = []; const shown = [];
  for (const p of ['/', '/features', '/pricing', '/about', '/faq']) {
    await page.goto(origin + p, { waitUntil: 'networkidle' });
    for (const d of await page.evaluate(grab)) {
      const mark = parseMark(d.mark);
      if (!mark.classes.length) { tally.noclass += 1; continue; }
      const hit = whereWords(d.text);
      const t0 = Date.now();
      const r = restyleByElement(repo, mark, { fontSize: 20, fontWeight: 700 }, hit ? { text: d.text, ...hit } : { text: d.text });
      times.push(Date.now() - t0);
      if (!r) tally.unsure += 1; else if (r.reason) tally.cant += 1; else { tally.done += 1; if (shown.length < 6 && tally.done % 37 === 1) shown.push(`「${d.text.slice(0, 16)}」 ${mark.classes.join(' ').slice(0, 60)} → ${r.file} 加/換 ${r.classes.join(' ')}`); }
    }
  }
  await browser.close();
  times.sort((a, b) => a - b);
  process.stdout.write(JSON.stringify(tally) + `\n每次耗時 中位數 ${times[times.length >> 1]}ms 最慢 ${times[times.length - 1]}ms\n` + shown.join('\n') + '\n');
})().catch((e) => { process.stderr.write(e.stack + '\n'); process.exit(1); });
