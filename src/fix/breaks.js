'use strict';
const path = require('node:path');
const { loadParser } = require('./element');

// A line break typed in the box (Shift+Enter). What has to be written for it
// depends on where the words live:
//   an article file (.md / .mdx)   an empty line: a new paragraph
//   text between backticks         a real line break, or an empty line when the text already uses those
//   text between quotes            the two characters \n
//   words inside the page's markup  a break there is a change to the page itself: not done here
// Returns { text } — what to write in place of the old words — or { reason }.

const ARTICLE = new Set(['.md', '.mdx']);
const PLAIN = new Set(['.txt']);
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const NOT_HERE = '這段字寫在版面程式裡，換行要動到版面，這裡做不了';

const linesOf = (to) => String(to).split(/\n+/).map((l) => l.trim()).filter(Boolean);

// How one more line is started in markdown, going by the line the words are on.
function articleJoin(lineStart) {
  if (/^\s*#{1,6}\s/.test(lineStart)) return { reason: '標題裡不能換行' };
  if (/^\s*\|/.test(lineStart)) return { reason: '表格裡不能換行' };
  const quote = /^(\s*>\s?)/.exec(lineStart);
  if (quote) return { join: `  \n${quote[1]}` };                       // same quote, next line
  const item = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(lineStart);
  if (item) return { join: `  \n${' '.repeat(item[0].length)}` };      // same list item, next line
  return { join: '\n\n' };
}

const insideFrontMatter = (content, index) => {
  if (!/^---\r?\n/.test(content)) return false;
  const end = content.indexOf('\n---', 3);
  return end > 0 && index < end;
};

const lineStartOf = (content, index) => content.slice(content.lastIndexOf('\n', index - 1) + 1, index);

// The innermost piece of code the words sit in.
function nodeAt(ts, file, content, index) {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : (/\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
  let found = sf;
  const visit = (n) => { if (n.getStart() <= index && index < n.getEnd()) { found = n; ts.forEachChild(n, visit); } };
  ts.forEachChild(sf, visit);
  return found;
}

function codeJoin(repo, file, content, match) {
  const ts = loadParser(repo);
  if (!ts) return { reason: NOT_HERE };
  const node = nodeAt(ts, file, content, match.index);
  const raw = content.slice(node.getStart(), node.getEnd());
  const backticks = ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
  if (backticks) {
    if (!/\n[ \t]*\r?\n/.test(raw)) return { join: '\n' };            // no empty lines in it: it is not written as paragraphs
    return articleJoin(lineStartOf(content, match.index));
  }
  if (ts.isStringLiteral(node)) return { join: raw.includes('\\n\\n') ? '\\n\\n' : '\\n' };
  return { reason: NOT_HERE };
}

function withBreaks(repo, file, content, match, to) {
  const lines = linesOf(to);
  if (lines.length < 2) return { text: lines[0] || '' };
  const ext = path.extname(file).toLowerCase();
  let how;
  if (ARTICLE.has(ext)) {
    how = insideFrontMatter(content, match.index) ? { reason: '這是文章開頭的設定欄位，不能換行' } : articleJoin(lineStartOf(content, match.index));
  } else if (PLAIN.has(ext)) how = { join: '\n' };
  else if (ext === '.json') how = { join: '\\n' };
  else if (CODE.has(ext)) how = codeJoin(repo, file, content, match);
  else how = { reason: NOT_HERE };
  if (how.reason) return how;
  const eol = how.join.includes('\\n') || !content.includes('\r\n') ? how.join : how.join.replace(/\n/g, '\r\n');
  return { text: lines.join(eol) };
}

module.exports = { withBreaks, linesOf };
