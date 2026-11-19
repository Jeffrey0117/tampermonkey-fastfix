'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');

const TOKEN = 'test-token-0123456789';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(root, name, files) {
  const dir = path.join(root, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content, 'utf8');
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// "plain" styles with CSS in the page; "tw" is a Tailwind project.
async function boot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fastfix-style-'));
  const roots = path.join(base, 'code');
  const plain = makeRepo(roots, 'plain', {
    'index.html': '<h1>大標題</h1>\n<p style="margin: 0; color: red">一段說明</p>\n<p>前面 <b>粗體</b> 後面的字</p>\n',
  });
  const tw = makeRepo(roots, 'tw', {
    'package.json': '{ "devDependencies": { "tailwindcss": "^3.4.0" } }\n',
    'app/page.tsx': [
      'export default function Page() {',
      '  return (',
      '    <main>',
      '      <h1 className="text-2xl font-bold text-center text-gray-900 dark:text-white">主標題</h1>',
      '      <p>沒有樣式的字</p>',
      '      <h2 className="text-lg md:text-3xl">會變大的字</h2>',
      '      <span className={cn("a", on && "b")}>組出來的</span>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  });
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sites: { 'plain.example.com': plain, 'tw.example.com': tw }, pending: {} }));
  const server = createServer({ token: TOKEN, stateDir, roots: [roots] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const style = async (site, text, look) => {
    const res = await fetch(`${url}/style`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, look, url: `https://${site}.example.com/` }),
    });
    return { status: res.status, json: await res.json() };
  };
  const read = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8');
  return { plain, tw, style, read, url, close: () => new Promise((r) => server.close(r)) };
}

test('style: Tailwind project, the size, weight and colour classes are swapped and the rest kept', async () => {
  const s = await boot();
  try {
    const r = await s.style('tw', '主標題', { fontSize: '30px', fontWeight: '800', color: '#E09A2E' });
    assert.equal(r.json.status, 'done');
    assert.equal(r.json.pending, 1);
    assert.match(s.read(s.tw, 'app/page.tsx'), /<h1 className="text-center dark:text-white text-3xl font-extrabold text-\[#e09a2e\]">主標題<\/h1>/);
  } finally { await s.close(); }
});

test('style: Tailwind project, an element with no classes gets a className; an odd size becomes an exact one', async () => {
  const s = await boot();
  try {
    assert.equal((await s.style('tw', '沒有樣式的字', { fontSize: '22px' })).json.status, 'done');
    assert.match(s.read(s.tw, 'app/page.tsx'), /<p className="text-\[22px\]">沒有樣式的字<\/p>/);
  } finally { await s.close(); }
});

test('style: Tailwind project, sizes that differ per screen width and built-up classes are refused in plain words', async () => {
  const s = await boot();
  try {
    const before = s.read(s.tw, 'app/page.tsx');
    const responsive = await s.style('tw', '會變大的字', { fontSize: '36px' });
    assert.equal(responsive.json.status, 'cant');
    assert.match(responsive.json.reason, /螢幕寬度/);
    const dynamic = await s.style('tw', '組出來的', { color: '#000000' });
    assert.equal(dynamic.json.status, 'cant');
    assert.equal(s.read(s.tw, 'app/page.tsx'), before);
    // weight has no per-screen variant on that element, so it can still be changed
    assert.equal((await s.style('tw', '會變大的字', { fontWeight: '700' })).json.status, 'done');
    assert.match(s.read(s.tw, 'app/page.tsx'), /<h2 className="text-lg md:text-3xl font-bold">會變大的字<\/h2>/);
  } finally { await s.close(); }
});

test('style: plain HTML project, a style attribute is added or updated on the element', async () => {
  const s = await boot();
  try {
    assert.equal((await s.style('plain', '大標題', { fontSize: '48px', fontWeight: '700' })).json.status, 'done');
    assert.equal((await s.style('plain', '一段說明', { color: '#112233' })).json.status, 'done');
    const html = s.read(s.plain, 'index.html');
    assert.match(html, /<h1 style="font-size: 48px; font-weight: 700">大標題<\/h1>/);
    assert.match(html, /<p style="margin: 0; color: #112233">一段說明<\/p>/);
  } finally { await s.close(); }
});

test('style: words that are not alone in an element, and bad values, are refused', async () => {
  const s = await boot();
  try {
    const before = s.read(s.plain, 'index.html');
    assert.equal((await s.style('plain', '後面的字', { fontSize: '20px' })).json.status, 'cant');
    assert.equal((await s.style('plain', '大標題', { color: 'red;}<script>' })).status, 400);
    assert.equal((await s.style('plain', '大標題', { fontSize: '20px; x' })).status, 400);
    assert.equal((await s.style('plain', '大標題', {})).status, 400);
    assert.equal(s.read(s.plain, 'index.html'), before);
  } finally { await s.close(); }
});
