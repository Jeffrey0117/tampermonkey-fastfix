'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');

const TOKEN = 'test-token-0123456789';
const HOST = 'shop.example.com';
const PAGE = `https://${HOST}/`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const PAGE_TSX = `import { cn } from '@/lib/utils';

const items = ['線上課程', '數位商品'];

export default function Page({ title }: { title: string }) {
  return (
    <main className="mx-auto max-w-5xl">
      <h1 className="text-4xl md:text-6xl font-bold text-stone-900">立即免費開始</h1>
      <ul className="flex gap-4">
        {items.map((item) => (
          <li key={item} className={cn('px-10 text-sm', item === '數位商品' && 'font-bold')}>{item}</li>
        ))}
      </ul>
      <p className="text-base text-muted-foreground">{title}</p>
      <span className="badge">{title}</span>
      <span className="badge">{title}</span>
    </main>
  );
}
`;

// A Tailwind + TSX site that pushes to a bare remote, already set for shop.example.com.
async function boot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fastfix-el-'));
  const shop = path.join(base, 'code', 'shop');
  const bare = path.join(base, 'shop.git');
  fs.mkdirSync(path.join(shop, 'app'), { recursive: true });
  git(shop, 'init', '-q', '-b', 'main');
  git(shop, 'config', 'user.email', 'test@example.com');
  git(shop, 'config', 'user.name', 'test');
  git(shop, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(shop, 'tailwind.config.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(shop, 'app', 'page.tsx'), PAGE_TSX, 'utf8');
  git(shop, 'add', '-A');
  git(shop, 'commit', '-q', '-m', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(shop, 'remote', 'add', 'origin', bare);
  git(shop, 'push', '-q', '-u', 'origin', 'main');

  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sites: { [HOST]: shop } }));
  const server = createServer({ token: TOKEN, stateDir, roots: [path.join(base, 'code')] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const res = await fetch(url + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const source = () => fs.readFileSync(path.join(shop, 'app', 'page.tsx'), 'utf8');
  return { base, shop, bare, call, source, close: () => new Promise((r) => server.close(r)) };
}

test('a project that another machine pushed to is brought up to date before it is touched', async () => {
  const s = await boot();
  try {
    const other = path.join(s.base, 'other');
    git(s.base, 'clone', '-q', s.bare, other);
    git(other, 'config', 'user.email', 'other@example.com');
    git(other, 'config', 'user.name', 'other');
    const file = path.join(other, 'app', 'page.tsx');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('立即免費開始', '立即免費開始</h1>\n      <h2>別台電腦加的字</h2><h1>'), 'utf8');
    git(other, 'commit', '-q', '-am', 'from another machine');
    git(other, 'push', '-q');

    const res = await s.call('POST', '/fix', { text: '別台電腦加的字', to: '現在改得到', url: PAGE });
    assert.equal(res.json.status, 'done', 'words that only exist online are found');
    const sent = await s.call('POST', '/submit', { url: PAGE });
    assert.equal(sent.json.ok, true, 'and the push is accepted');
    assert.match(git(s.bare, 'show', 'main:app/page.tsx'), /現在改得到/);
  } finally { await s.close(); }
});

test('a project that cannot be brought up to date says so instead of editing an old copy', async () => {
  const s = await boot();
  try {
    const other = path.join(s.base, 'other');
    git(s.base, 'clone', '-q', s.bare, other);
    git(other, 'config', 'user.email', 'other@example.com');
    git(other, 'config', 'user.name', 'other');
    fs.appendFileSync(path.join(other, 'app', 'page.tsx'), '// theirs\n');
    git(other, 'commit', '-q', '-am', 'theirs');
    git(other, 'push', '-q');
    fs.appendFileSync(path.join(s.shop, 'tailwind.config.js'), '// ours\n');
    git(s.shop, 'commit', '-q', '-am', 'ours, never pushed');

    const before = s.source();
    const res = await s.call('POST', '/fix', { text: '立即免費開始', to: 'x', url: PAGE });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /比線上的舊/);
    assert.equal(s.source(), before);
  } finally { await s.close(); }
});

// A site written the pagetext-kit way: the page holds no words, its text file does.
test('a page that keeps its words in a text file: the words are changed in the text file, the page is left alone', async () => {
  const s = await boot();
  try {
    const dir = path.join(s.shop, 'app', 'pricing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.text.ts'), "export const text = {\n  hero: { title: '一個價錢，全部功能', lead: '先用，喜歡再付' },\n  plans: [{ name: '免費' }, { name: '專業' }],\n} as const;\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'page.tsx'), "import { text as t } from './page.text';\n\nexport default function Page() {\n  return (\n    <section className=\"py-20\">\n      <h2 className=\"text-3xl font-semibold\">{t.hero.title}</h2>\n      <p className=\"text-lg text-stone-600\">{t.hero.lead}</p>\n    </section>\n  );\n}\n", 'utf8');
    git(s.shop, 'add', '-A');
    git(s.shop, 'commit', '-q', '-m', 'pricing page');
    git(s.shop, 'push', '-q');
    const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
    const url = `${PAGE}pricing`;

    const fixed = await s.call('POST', '/fix', { text: '一個價錢，全部功能', to: '一個價錢，什麼都有', url });
    assert.equal(fixed.json.status, 'done');
    assert.match(read('page.text.ts'), /title: '一個價錢，什麼都有'/);
    assert.match(read('page.tsx'), /\{t\.hero\.title\}/, 'the page itself is untouched');
  } finally { await s.close(); }
});
