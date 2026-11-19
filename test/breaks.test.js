'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');

const TOKEN = 'test-token-0123456789';
const HOST = 'blog.example.com';
const PAGE = `https://${HOST}/`;
const NL = '\n';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const FILES = {
  'posts/hello.md': ['---', 'title: 開頭設定的標題', '---', '', '# 文章大標題', '', '第一句話接著第二句話。', '', '- 買菜然後洗碗', '', '> 引用的話還有後半', '', '| 欄位甲 | 欄位乙 |', ''].join(NL),
  'app/articles.ts': [
    'export const articles = [',
    '  {',
    '    body: `',
    '開場白寫在這裡後面還有。',
    '',
    '第二段。',
    '`,',
    "    note: `只有一行的說明文字`,",
    "    summary: '摘要的前半摘要的後半',",
    '  },',
    '];',
    '',
  ].join(NL),
  'app/page.tsx': ['export default function Page() {', '  return <h1 className="big">版面裡的標題字</h1>;', '}', ''].join(NL),
};

async function boot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fastfix-br-'));
  const repo = path.join(base, 'code', 'blog');
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content, 'utf8');
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sites: { [HOST]: repo } }));
  const server = createServer({ token: TOKEN, stateDir, roots: [path.join(base, 'code')] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const fix = async (text, to) => {
    const res = await fetch(`${url}/fix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ text, to, url: PAGE }),
    });
    return { status: res.status, json: await res.json() };
  };
  const read = (name) => fs.readFileSync(path.join(repo, name), 'utf8');
  return { fix, read, stateDir, close: () => new Promise((r) => server.close(r)) };
}

test('a line break in an article becomes a new paragraph', async () => {
  const s = await boot();
  try {
    const res = await s.fix('第一句話接著第二句話。', `第一句話${NL}接著第二句話。`);
    assert.equal(res.json.status, 'done');
    assert.ok(s.read('posts/hello.md').includes(`${NL}第一句話${NL}${NL}接著第二句話。${NL}`));
  } finally { await s.close(); }
});

test('in a list item or a quote the next line stays inside it', async () => {
  const s = await boot();
  try {
    assert.equal((await s.fix('買菜然後洗碗', `買菜${NL}然後洗碗`)).json.status, 'done');
    assert.equal((await s.fix('引用的話還有後半', `引用的話${NL}還有後半`)).json.status, 'done');
    const md = s.read('posts/hello.md');
    assert.ok(md.includes(`- 買菜  ${NL}  然後洗碗${NL}`), 'two spaces end the line; the next one is indented under the item');
    assert.ok(md.includes(`> 引用的話  ${NL}> 還有後半${NL}`));
  } finally { await s.close(); }
});

test('a heading, a table and the settings at the top of an article cannot take a line break', async () => {
  const s = await boot();
  try {
    const before = s.read('posts/hello.md');
    for (const [text, to] of [['文章大標題', `文章${NL}大標題`], ['欄位甲', `欄位${NL}甲`], ['開頭設定的標題', `開頭設定${NL}的標題`]]) {
      const res = await s.fix(text, to);
      assert.equal(res.json.status, 'cant', text);
      assert.match(res.json.reason, /不能換行/);
    }
    assert.equal(s.read('posts/hello.md'), before);
  } finally { await s.close(); }
});

test('article text kept in code: paragraphs between backticks, the two characters \\n between quotes', async () => {
  const s = await boot();
  try {
    assert.equal((await s.fix('開場白寫在這裡後面還有。', `開場白寫在這裡${NL}後面還有。`)).json.status, 'done');
    assert.equal((await s.fix('只有一行的說明文字', `只有一行${NL}的說明文字`)).json.status, 'done');
    assert.equal((await s.fix('摘要的前半摘要的後半', `摘要的前半${NL}摘要的後半`)).json.status, 'done');
    const code = s.read('app/articles.ts');
    assert.ok(code.includes(`${NL}開場白寫在這裡${NL}${NL}後面還有。${NL}`), 'this text is written as paragraphs: an empty line');
    assert.ok(code.includes(`note: \`只有一行${NL}的說明文字\``), 'this one is not: a plain line break');
    assert.ok(code.includes(String.raw`summary: '摘要的前半\n摘要的後半',`), 'between quotes a real line break would break the file');
    const articles = new Function(`${code.replace('export const articles =', 'const articles =')}; return articles;`)();
    assert.equal(articles[0].summary, `摘要的前半${NL}摘要的後半`, 'the file still runs, and the text has its line break');
  } finally { await s.close(); }
});

test('words in the page markup cannot take a line break, and the file is left alone', async () => {
  const s = await boot();
  try {
    const before = s.read('app/page.tsx');
    const res = await s.fix('版面裡的標題字', `版面裡的${NL}標題字`);
    assert.equal(res.json.status, 'cant');
    assert.equal(s.read('app/page.tsx'), before);
  } finally { await s.close(); }
});

test('other symbols that can break code are still refused; empty lines and stray spaces are tidied', async () => {
  const s = await boot();
  try {
    const bad = await s.fix('第一句話接著第二句話。', '第一句話<b>');
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, /可能弄壞程式的符號/);
    assert.doesNotMatch(bad.json.error, /\\n/);
    assert.equal((await s.fix('第一句話接著第二句話。', `第一句話  \r\n\r\n\r\n  接著第二句話。`)).json.status, 'done');
    assert.ok(s.read('posts/hello.md').includes(`${NL}第一句話${NL}${NL}接著第二句話。${NL}`));
    const state = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'state.json'), 'utf8'));
    assert.ok(JSON.stringify(state).includes(String.raw`第一句話\n接著第二句話。`), 'what to look for on the page keeps the line break');
  } finally { await s.close(); }
});
