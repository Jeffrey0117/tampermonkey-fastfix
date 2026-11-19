'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { SIZE_TOKENS, WEIGHT_TOKENS, splitToken, tokenFamily } = require('./style');

// Finds the element that was clicked in a Tailwind + JSX project, and changes
// its classes. The page already tells which element it is: its tag and classes,
// and the tags and classes of everything around it, are the same strings the
// source was written with. Nothing has to be added to the site for this.

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage', '__tests__', 'e2e', 'tests', 'test', 'playwright-report', 'test-results']);
const CLASS_HELPERS = new Set(['cn', 'clsx', 'cx', 'twMerge', 'classNames']);
const SCREENS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };
const MAX_FILES = 4000;
const TAG_OK = /^[a-z][a-z0-9-]{0,30}$/;
const TOKEN_OK = /^[^\s"'`<>{}]{1,80}$/;

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const words = (s) => String(s).split(/\s+/).filter(Boolean);

// The project's own TypeScript reads its files best; ours is the fallback.
function loadParser(repo) {
  for (const from of [path.join(repo, 'node_modules', 'typescript'), 'typescript']) {
    // TypeScript 7 has no parser to call from JavaScript; such a copy is skipped
    try { const ts = require(from); if (typeof ts.createSourceFile === 'function') return ts; } catch (_) { /* try the next one */ }
  }
  return null;
}

const cleanClasses = (value) => (Array.isArray(value) ? value.filter((t) => typeof t === 'string' && TOKEN_OK.test(t)).slice(0, 80) : []);

// What the userscript says about the clicked element. Anything odd is dropped.
function parseMark(input) {
  if (!input || typeof input !== 'object') return null;
  const tag = String(input.tag || '').toLowerCase();
  if (!TAG_OK.test(tag)) return null;
  const chain = (Array.isArray(input.chain) ? input.chain : []).slice(0, 20)
    .map((c) => ({ tag: String((c && c.tag) || '').toLowerCase(), classes: cleanClasses(c && c.classes) }))
    .filter((c) => TAG_OK.test(c.tag));
  const width = Number(input.width);
  return { tag, classes: cleanClasses(input.classes), chain, width: width > 0 && width < 10000 ? width : 1280 };
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out); }
    else if (/\.(tsx|jsx)$/.test(entry.name) && !/\.(test|spec|stories)\./.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

// always: classes the element carries every time. maybe: classes inside a condition.
// literals: the quoted pieces of the className, with where their text sits in the file.
function readClassName(ts, attr) {
  const out = { always: new Set(), maybe: new Set(), dynamic: false, literals: [] };
  const init = attr && attr.initializer;
  if (!init) return out;
  const isLiteral = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  const take = (n, sure) => {
    words(n.text).forEach((w) => (sure ? out.always : out.maybe).add(w));
    out.literals.push({ start: n.getStart() + 1, end: n.getEnd() - 1, sure });
  };
  const walk = (n) => {
    if (isLiteral(n)) take(n, false);
    else ts.forEachChild(n, walk);
  };
  if (isLiteral(init)) { take(init, true); return out; }
  const expr = init.expression;
  out.dynamic = true;
  if (!expr) return out;
  if (isLiteral(expr)) { take(expr, true); out.dynamic = false; return out; }
  if (ts.isCallExpression(expr) && CLASS_HELPERS.has(expr.expression.getText())) {
    expr.arguments.forEach((a) => (isLiteral(a) ? take(a, true) : walk(a)));
  } else walk(expr);
  return out;
}

function indexFile(ts, file, code) {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node, parent) => {
    let me = parent;
    const opening = ts.isJsxElement(node) ? node.openingElement : (ts.isJsxSelfClosingElement(node) ? node : null);
    if (opening) {
      const name = opening.tagName.getText();
      const intrinsic = /^[a-z]/.test(name);
      const attr = opening.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === 'className');
      const cls = readClassName(ts, attr);
      const kids = ts.isJsxElement(node) ? node.children : [];
      me = elements.length;
      elements.push({
        ...cls,
        tag: intrinsic ? name : '*',
        dynamic: cls.dynamic || !intrinsic,
        hasAttr: Boolean(attr),
        nameEnd: opening.tagName.getEnd(),
        text: squash(kids.filter((k) => ts.isJsxText(k)).map((k) => k.text).join(' ')),
        hasExpr: kids.some((k) => ts.isJsxExpression(k) && k.expression),
        parent,
        line: lineOf(node.getStart()),
        endLine: lineOf(node.getEnd()),
      });
    }
    ts.forEachChild(node, (c) => visit(c, me));
  };
  visit(sf, -1);
  return elements;
}

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

// Every wrapper the source always renders around it must be around it on the page too, in order.
function chainScore(elements, s, d) {
  let score = 0;
  let at = 0;
  for (let p = s.parent; p >= 0; p = elements[p].parent) {
    const anc = elements[p];
    if (anc.always.size === 0) continue;
    let found = -1;
    for (let i = at; i < d.chain.length && found < 0; i += 1) {
      if ((anc.tag === '*' || d.chain[i].tag === anc.tag) && subset(anc.always, d.chain[i].classes)) found = i;
    }
    if (found < 0) return -1;
    score += anc.always.size + 1;
    at = found + 1;
  }
  return score;
}

// The one element in the project that matches, or null when it is not clear-cut.
// hint: { text, file, line } — the clicked words, and where they were found (if they were).
function findElement(ts, repo, mark, hint) {
  if (!mark.classes.length) return null;
  const need = Math.ceil(mark.classes.length / 2);
  const text = squash(hint.text || '');
  const scored = [];
  for (const full of sourceFiles(repo)) {
    const code = fs.readFileSync(full, 'utf8');
    if (mark.classes.filter((t) => code.includes(t)).length < need) continue;
    const file = path.relative(repo, full).split(path.sep).join('/');
    const elements = indexFile(ts, full, code);
    for (const s of elements) {
      const own = ownScore(s, mark);
      if (own < 0) continue;
      const related = s.text && text && (s.text.includes(text) || text.includes(s.text));
      if (!related && !s.hasExpr) continue;                 // it shows other words, or none at all
      const chain = chainScore(elements, s, mark);
      if (chain < 0) continue;
      const sameFile = hint.file === file;
      const bonus = (s.text === text ? 50 : 0) + (sameFile ? 3 : 0) + (sameFile && hint.line >= s.line && hint.line <= s.endLine ? 100 : 0);
      scored.push({ s, file, code, score: own + chain + bonus });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || (scored.length > 1 && scored[1].score === scored[0].score)) return null;
  return scored[0];
}

const screenOf = (variants) => (variants.length === 0 ? 0 : (variants.length === 1 && SCREENS[variants[0]]) || -1);

// The class that decides this family (size, weight, colour) at the width the person is looking at.
function activeToken(el, code, family, width) {
  let best = null;
  for (const lit of el.literals) {
    const textOf = code.slice(lit.start, lit.end);
    for (const m of textOf.matchAll(/\S+/g)) {
      const { variants, base } = splitToken(m[0]);
      const screen = screenOf(variants);
      if (screen < 0 || screen > width || tokenFamily(base) !== family) continue;
      if (!best || screen > best.screen) best = { screen, start: lit.start + m.index, end: lit.start + m.index + m[0].length, prefix: variants.map((v) => `${v}:`).join('') };
    }
  }
  return best;
}

function wantedTokens(look) {
  return [
    look.fontSize && ['size', `text-${SIZE_TOKENS[look.fontSize] || `[${look.fontSize}px]`}`],
    look.fontWeight && ['weight', `font-${WEIGHT_TOKENS[look.fontWeight]}`],
    look.color && ['color', `text-[${look.color}]`],
  ].filter(Boolean);
}

// Returns { content, classes } or { reason }.
function editClasses(el, code, look, width) {
  const edits = [];
  const classes = [];
  const home = el.literals.find((l) => l.sure) || el.literals[0];
  for (const [family, base] of wantedTokens(look)) {
    const active = activeToken(el, code, family, width);
    if (active) {
      edits.push({ start: active.start, end: active.end, text: active.prefix + base });
      classes.push(active.prefix + base);
    } else if (home) {
      edits.push({ start: home.end, end: home.end, text: (home.end > home.start ? ' ' : '') + base, order: edits.length });
      classes.push(base);
    } else if (!el.hasAttr && el.tag !== '*') {
      edits.push({ start: el.nameEnd, end: el.nameEnd, text: edits.some((e) => e.attr) ? '' : ` className="${base}"`, attr: true, base });
      classes.push(base);
    } else {
      return { reason: '這個元素的樣式是程式組出來的，這裡改不了' };
    }
  }
  // several new classes on an element that had no className: one attribute holding all of them
  const fresh = edits.filter((e) => e.attr);
  if (fresh.length > 1) fresh[0].text = ` className="${fresh.map((e) => e.base).join(' ')}"`;
  const ordered = [...edits].sort((a, b) => (b.start - a.start) || ((b.order || 0) - (a.order || 0)));
  const content = ordered.reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), code);
  return { content, classes };
}

// null: could not tell which element it is (the caller falls back to the old way).
function restyleByElement(repo, mark, look, hint) {
  const ts = loadParser(repo);
  if (!ts) return null;
  const found = findElement(ts, repo, mark, hint);
  if (!found) return null;
  const result = editClasses(found.s, found.code, look, mark.width);
  return result.reason ? result : { file: found.file, ...result };
}

module.exports = { parseMark, restyleByElement };
