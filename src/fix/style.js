'use strict';
const fs = require('node:fs');
const path = require('node:path');

// How the text looks: size, weight, colour. Written back onto the element that
// holds the text, in whatever way the project already styles things:
// utility classes in a Tailwind project, a style attribute otherwise.

const SIZE_TOKENS = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
const WEIGHT_TOKENS = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
const SIZE_RE = /^text-(xs|sm|base|lg|xl|[2-9]xl|\[[\d.]+(px|rem|em)\])$/;
const WEIGHT_RE = /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\])$/;
const TEXT_NOT_COLOR_RE = /^text-(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|opacity-.+)$/;
const SCREEN_VARIANT_RE = /^(sm|md|lg|xl|2xl|max-[a-z0-9]+):/;
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx', '.js', '.ts', '.mjs']);
const TAILWIND_CONFIGS = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'];

const isColorToken = (t) => /^text-/.test(t) && !SIZE_RE.test(t) && !TEXT_NOT_COLOR_RE.test(t);

function parseLook(input) {
  const look = {};
  if (!input || typeof input !== 'object') return null;
  if (input.fontSize !== undefined) {
    const m = /^(\d{1,3})px$/.exec(String(input.fontSize));
    if (!m || Number(m[1]) < 6) return null;
    look.fontSize = Number(m[1]);
  }
  if (input.fontWeight !== undefined) {
    if (!/^[1-9]00$/.test(String(input.fontWeight))) return null;
    look.fontWeight = Number(input.fontWeight);
  }
  if (input.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(input.color))) return null;
    look.color = String(input.color).toLowerCase();
  }
  return Object.keys(look).length ? look : null;
}

const describeLook = (look) => [
  look.fontSize && `大小 ${look.fontSize}px`,
  look.fontWeight && `粗細 ${look.fontWeight}`,
  look.color && `顏色 ${look.color}`,
].filter(Boolean).join('、');

function usesTailwind(repo) {
  if (TAILWIND_CONFIGS.some((name) => fs.existsSync(path.join(repo, name)))) return true;
  try { return fs.readFileSync(path.join(repo, 'package.json'), 'utf8').includes('"tailwindcss"'); } catch (_) { return false; }
}

// The opening tag the text sits directly inside: "<h1 class='x'>" right before it.
function openingTagBefore(content, index) {
  let end = index;
  while (end > 0 && /\s/.test(content[end - 1])) end -= 1;
  if (content[end - 1] !== '>' || content[end - 2] === '/') return null;
  const start = content.lastIndexOf('<', end - 1);
  if (start < 0) return null;
  const text = content.slice(start, end);
  if (!/^<[A-Za-z][\w.-]*[\s>]/.test(text)) return null;                 // a closing tag, a comment, not a tag
  const count = (ch) => text.split(ch).length - 1;
  if (count('{') !== count('}') || count('"') % 2 || count("'") % 2) return null;
  return { start, end, text };
}

const tagNameEnd = (tag) => /^<[A-Za-z][\w.-]*/.exec(tag)[0].length;

const staticAttr = (tag, names) => new RegExp(`\\s(${names})\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
const hasDynamicAttr = (tag, names) => new RegExp(`\\s:?(${names})\\s*=\\s*\\{|\\s:(${names})\\s*=`).test(tag);

function replaceToken(tokens, isKind, next) {
  const kept = tokens.filter((t) => !isKind(t));
  return [...kept, next];
}

function tailwindTokens(tokens, look) {
  let out = tokens;
  if (look.fontSize) {
    if (tokens.some((t) => SCREEN_VARIANT_RE.test(t) && SIZE_RE.test(t.replace(SCREEN_VARIANT_RE, '')))) {
      return { reason: '這段字在不同螢幕寬度有不同大小，這裡改不了大小' };
    }
    out = replaceToken(out, (t) => SIZE_RE.test(t), `text-${SIZE_TOKENS[look.fontSize] || `[${look.fontSize}px]`}`);
  }
  if (look.fontWeight) out = replaceToken(out, (t) => WEIGHT_RE.test(t), `font-${WEIGHT_TOKENS[look.fontWeight]}`);
  if (look.color) out = replaceToken(out, isColorToken, `text-[${look.color}]`);
  return { tokens: out };
}

function rewriteWithClasses(tag, look, jsx) {
  const attr = staticAttr(tag, 'class|className');
  if (!attr && hasDynamicAttr(tag, 'class|className')) return { reason: '這個元素的樣式是程式組出來的，這裡改不了' };
  const current = attr ? (attr[3] !== undefined ? attr[3] : attr[4]).split(/\s+/).filter(Boolean) : [];
  const result = tailwindTokens(current, look);
  if (result.reason) return result;
  const value = result.tokens.join(' ');
  if (!attr) {
    const at = tagNameEnd(tag);
    return { tag: `${tag.slice(0, at)} ${jsx ? 'className' : 'class'}="${value}"${tag.slice(at)}` };
  }
  const quote = attr[2][0];
  const replaced = ` ${attr[1]}=${quote}${value}${quote}`;
  return { tag: tag.slice(0, attr.index) + replaced + tag.slice(attr.index + attr[0].length) };
}

function rewriteWithStyle(tag, look, jsx) {
  if (jsx) return { reason: '這個專案的寫法這裡改不了樣式' };
  const attr = staticAttr(tag, 'style');
  if (!attr && hasDynamicAttr(tag, 'style')) return { reason: '這個元素的樣式是程式組出來的，這裡改不了' };
  const existing = attr ? (attr[3] !== undefined ? attr[3] : attr[4]) : '';
  const wanted = {
    ...(look.fontSize ? { 'font-size': `${look.fontSize}px` } : {}),
    ...(look.fontWeight ? { 'font-weight': String(look.fontWeight) } : {}),
    ...(look.color ? { color: look.color } : {}),
  };
  const kept = existing.split(';').map((d) => d.trim()).filter(Boolean)
    .filter((d) => !(d.split(':')[0].trim().toLowerCase() in wanted));
  const value = [...kept, ...Object.entries(wanted).map(([k, v]) => `${k}: ${v}`)].join('; ');
  if (!attr) {
    const at = tagNameEnd(tag);
    return { tag: `${tag.slice(0, at)} style="${value}"${tag.slice(at)}` };
  }
  const quote = attr[2][0];
  return { tag: `${tag.slice(0, attr.index)} style=${quote}${value}${quote}${tag.slice(attr.index + attr[0].length)}` };
}

// Returns { content } with the look applied to the element holding the text at
// match.index, or { reason } in plain words when it cannot be done here.
function applyLook({ repo, file, content, match, look }) {
  const tag = openingTagBefore(content, match.index);
  if (!tag) return { reason: '這段字不是單獨放在一個元素裡，這裡改不了樣式' };
  const jsx = JSX_EXTENSIONS.has(path.extname(file).toLowerCase());
  const result = usesTailwind(repo) ? rewriteWithClasses(tag.text, look, jsx) : rewriteWithStyle(tag.text, look, jsx);
  if (result.reason) return result;
  return { content: content.slice(0, tag.start) + result.tag + content.slice(tag.end) };
}

module.exports = { parseLook, describeLook, applyLook };
