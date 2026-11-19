'use strict';
// Read-only experiment: how many text elements on the live site can be traced to one place in the
// source (a) by their words alone, (b) by the chain of tags and classes around them.
const fs = require('node:fs');
const path = require('node:path');
const [playwrightDir, repo, origin] = process.argv.slice(2);
const { chromium } = require(playwrightDir);
const ts = require(process.argv[5]);

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const words = (s) => String(s).split(/\s+/).filter(Boolean);

// ---------- source side ----------
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '__tests__', 'tests', 'e2e', 'test', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(tsx|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const CLASS_HELPERS = ['cn', 'clsx', 'cx', 'twMerge', 'classNames'];

// always: classes the element has every time. maybe: classes inside conditions.
function classTokens(attr) {
  const always = new Set();
  const maybe = new Set();
  const init = attr.initializer;
  if (!init) return { always, maybe, dynamic: false };
  const literal = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  if (literal(init)) { words(init.text).forEach((w) => always.add(w)); return { always, maybe, dynamic: false }; }
  const expr = init.expression;
  if (!expr) return { always, maybe, dynamic: true };
  if (literal(expr)) { words(expr.text).forEach((w) => always.add(w)); return { always, maybe, dynamic: false }; }
  const collect = (n, into) => {
    if (literal(n)) words(n.text).forEach((w) => into.add(w));
    else if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)];
      parts.forEach((p) => words(p.replace(/^\S+|\S+$/g, (edge, i) => (i === 0 && /^\s/.test(p) ? edge : (/\s$/.test(p) ? edge : ' ')))).forEach((w) => into.add(w)));
      n.templateSpans.forEach((s) => collect(s.expression, maybe));
    } else ts.forEachChild(n, (c) => collect(c, maybe));
  };
  if (ts.isCallExpression(expr) && CLASS_HELPERS.includes(expr.expression.getText())) {
    expr.arguments.forEach((a) => collect(a, literal(a) ? always : maybe));
  } else if (ts.isTemplateExpression(expr)) collect(expr, always);
  else collect(expr, maybe);
  return { always, maybe, dynamic: true };
}

function indexSource() {
  const elements = [];
  const texts = [];   // raw file texts, for the words-only method
  for (const file of sourceFiles(repo)) {
    const code = fs.readFileSync(file, 'utf8');
    texts.push({ file: path.relative(repo, file), code });
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node, parent) => {
      let me = parent;
      const opening = ts.isJsxElement(node) ? node.openingElement : (ts.isJsxSelfClosingElement(node) ? node : null);
      if (opening) {
        const tag = opening.tagName.getText();
        {
          const attr = opening.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === 'className');
          const tokens = attr ? classTokens(attr) : { always: new Set(), maybe: new Set(), dynamic: false };
          const kids = ts.isJsxElement(node) ? node.children : [];
          const text = squash(kids.filter((k) => ts.isJsxText(k)).map((k) => k.text).join(' '));
          const hasExpr = kids.some((k) => ts.isJsxExpression(k) && k.expression);
          me = elements.length;
          elements.push({
            file: path.relative(repo, file), tag: /^[a-z]/.test(tag) ? tag : '*', ...tokens, dynamic: tokens.dynamic || !/^[a-z]/.test(tag), text, hasExpr, parent,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          });
        }
      }
      ts.forEachChild(node, (c) => visit(c, me));
    };
    visit(sf, -1);
  }
  return { elements, texts };
}

// ---------- matching ----------
const subset = (set, list) => [...set].every((t) => list.includes(t));

function ownScore(s, d) {
  if (s.tag !== '*' && s.tag !== d.tag) return -1;
  if (s.tag === '*' && s.always.size === 0) return -1;
  if (!subset(s.always, d.classes)) return -1;
  if (d.classes.length === 0) return s.always.size === 0 && s.maybe.size === 0 ? 0.5 : -1;
  const hit = s.always.size + [...s.maybe].filter((t) => d.classes.includes(t)).length * 0.5;
  if (hit === 0) return -1;
  if (!s.dynamic && s.always.size !== d.classes.length) return -1;      // a fixed class list must be the whole list
  return hit;
}

function chainScore(elements, s, d) {
  let score = 0;
  let at = 0;                                  // index into d.chain (nearest ancestor first)
  for (let p = s.parent; p >= 0; p = elements[p].parent) {
    const anc = elements[p];
    if (anc.always.size === 0) continue;       // nothing to hold on to
    let found = -1;
    for (let i = at; i < d.chain.length; i += 1) {
      if ((anc.tag === '*' || d.chain[i].tag === anc.tag) && subset(anc.always, d.chain[i].classes)) { found = i; break; }
    }
    if (found < 0) return -1;                  // the source says this wrapper is always there; the page has none
    score += anc.always.size + 1;
    at = found + 1;
  }
  return score;
}

function byFingerprint(elements, d, useText) {
  const scored = [];
  for (const s of elements) {
    const own = ownScore(s, d);
    if (own < 0) continue;
    if (useText && s.text && !s.hasExpr && !squash(d.text).includes(s.text) && !s.text.includes(squash(d.text))) continue;
    const chain = chainScore(elements, s, d);
    if (chain < 0) continue;
    const textBonus = useText && s.text && (s.text === squash(d.text)) ? 100 : 0;
    scored.push({ s, score: own + chain + textBonus });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { kind: 'none' };
  if (scored.length > 1 && scored[1].score === scored[0].score) return { kind: 'many', n: scored.filter((x) => x.score === scored[0].score).length };
  return { kind: 'one', s: scored[0].s };
}

function byWords(texts, d) {
  const hits = [];
  for (const { file, code } of texts) {
    let i = code.indexOf(d.text);
    while (i >= 0 && hits.length < 3) { hits.push({ file, line: code.slice(0, i).split('\n').length }); i = code.indexOf(d.text, i + 1); }
  }
  if (!hits.length) return { kind: 'none' };
  return hits.length > 1 ? { kind: 'many', n: hits.length } : { kind: 'one', ...hits[0] };
}

// ---------- page side ----------
const grab = () => {
  const out = [];
  const seen = new Set();
  const classesOf = (el) => (typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : []);
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'].includes(el.tagName.toUpperCase())) continue;
    if (el.closest('svg')) continue;
    const direct = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    if (direct.length < 2) continue;
    const chain = [];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) chain.push({ tag: p.tagName.toLowerCase(), classes: classesOf(p) });
    const key = el.tagName + '|' + el.className + '|' + direct;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: direct, tag: el.tagName.toLowerCase(), classes: classesOf(el), chain });
  }
  return out;
};

(async () => {
  const { elements, texts } = indexSource();
  process.stdout.write(`source: ${texts.length} files, ${elements.length} elements\n`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  const links = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => new URL(a.href, location.href)).filter((u) => u.origin === location.origin).map((u) => u.pathname))]);
  const picked = ['/', ...links.filter((p) => p !== '/' && !/login|signup|auth|admin|dashboard/.test(p))].slice(0, 9);
  const total = { n: 0, words: { one: 0, many: 0, none: 0 }, chain: { one: 0, many: 0, none: 0 }, both: { one: 0, many: 0, none: 0 }, agree: 0, disagree: 0, comparable: 0 };
  const samples = { disagree: [], chainOnly: [], nobody: [] };
  for (const p of picked) {
    try { await page.goto(origin + p, { waitUntil: 'networkidle', timeout: 30000 }); } catch (_) { continue; }
    const items = await page.evaluate(grab);
    const row = { words: 0, chain: 0, both: 0 };
    for (const d of items) {
      const w = byWords(texts, d);
      const c = byFingerprint(elements, d, false);
      const b = byFingerprint(elements, d, true);
      total.n += 1;
      const truth = elements.filter((e) => e.text && !e.hasExpr && e.text === squash(d.text));
      if (truth.length === 1) { total.known = (total.known || 0) + 1; if (c.kind === 'one') { if (c.s === truth[0]) total.right = (total.right || 0) + 1; else { total.wrong = (total.wrong || 0) + 1; if ((samples.wrong = samples.wrong || []).length < 8) samples.wrong.push(`「${d.text.slice(0, 20)}」 真正在 ${truth[0].file}:${truth[0].line} 鏈指到 ${c.s.file}:${c.s.line}`); } } else total['unsure_' + c.kind] = (total['unsure_' + c.kind] || 0) + 1; }
      total.words[w.kind] += 1; total.chain[c.kind] += 1; total.both[b.kind] += 1;
      if (w.kind === 'one') row.words += 1;
      if (c.kind === 'one') row.chain += 1;
      if (b.kind === 'one') row.both += 1;
      if (w.kind === 'one' && c.kind === 'one') {
        total.comparable += 1;
        const same = w.file === c.s.file && w.line >= c.s.line && w.line <= c.s.endLine;
        if (same) total.agree += 1; else { total.disagree += 1; if (samples.disagree.length < 8) samples.disagree.push(`「${d.text.slice(0, 24)}」 words→${w.file}:${w.line}  chain→${c.s.file}:${c.s.line}`); }
      }
      if (w.kind !== 'one' && b.kind === 'one' && samples.chainOnly.length < 10) samples.chainOnly.push(`「${d.text.slice(0, 24)}」 <${d.tag} ${d.classes.slice(0, 4).join(' ')}> words:${w.kind} → ${b.s.file}:${b.s.line}${b.s.hasExpr ? ' (字是變數)' : ''}`);
      if (w.kind !== 'one' && b.kind !== 'one' && samples.nobody.length < 10) samples.nobody.push(`「${d.text.slice(0, 24)}」 <${d.tag} ${d.classes.slice(0, 5).join(' ')}> words:${w.kind} chain:${b.kind}`);
    }
    process.stdout.write(`${p.padEnd(34)} ${String(items.length).padStart(4)} 段字 | 只靠字 ${row.words} | 只靠鏈 ${row.chain} | 兩者合用 ${row.both}\n`);
  }
  await browser.close();
  const pct = (x) => `${x} (${Math.round((x / total.n) * 100)}%)`;
  process.stdout.write(`\n共 ${total.n} 段字\n`);
  for (const [name, key] of [['只靠字（現在）', 'words'], ['只靠鏈', 'chain'], ['字＋鏈', 'both']]) {
    process.stdout.write(`${name.padEnd(10)} 唯一 ${pct(total[key].one)} | 多個候選 ${pct(total[key].many)} | 找不到 ${pct(total[key].none)}\n`);
  }
  process.stdout.write(`\n字和鏈都各自認出唯一的 ${total.comparable} 段裡：指到同一處 ${total.agree}、指到不同處 ${total.disagree}\n`);
  process.stdout.write(`
答案已知的 ${total.known} 段（字寫死在標籤裡、全專案只有一處）：只靠鏈 指對 ${total.right || 0}、指錯 ${total.wrong || 0}、多個候選 ${total.unsure_many || 0}、找不到 ${total.unsure_none || 0}
${(samples.wrong || []).join(' ; ')}
`);
  for (const [title, list] of [['指到不同處', samples.disagree], ['字認不出、字＋鏈認得出', samples.chainOnly], ['都認不出', samples.nobody]]) {
    process.stdout.write(`\n-- ${title}\n${list.join('\n')}\n`);
  }
})().catch((e) => { process.stderr.write(e.stack + '\n'); process.exit(1); });
