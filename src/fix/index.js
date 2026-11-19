'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDirty, commitFiles, push } = require('./git');
const { matchesInRepo } = require('./search');
const { newRiskyChars, replaceAt, contextScore } = require('./match');
const { readState, writeState, repoPending, withPending } = require('./store');

const MAX_CHOICES = 12;
const MAX_TEXT = 2000;
const SUMMARY_MAX = 60;

const reply = (status, body) => ({ status, body });
const refuse = (status, error) => reply(status, { ok: false, error });

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

const pendingCount = (state, repo) => {
  const p = repoPending(state, repo);
  return p.edits.length + p.unpushed.length;
};

// The project for a site is a setting (see settings.js); nothing here guesses it.
function projectFor(state, host) {
  const repo = state.sites[host];
  return repo && fs.existsSync(repo) ? repo : null;
}

const publicMatch = ({ file, nth, line, context }) => ({ file, nth, line, context });

// Same words in several places: the one whose surroundings look most like the
// page wins. A tie is left for the person to settle.
function clearWinner(matches, repo, hints) {
  if (matches.length === 1) return matches[0];
  const contents = new Map();
  const scored = matches.map((m) => {
    if (!contents.has(m.file)) contents.set(m.file, fs.readFileSync(path.join(repo, m.file), 'utf8'));
    return { m, score: contextScore(contents.get(m.file), m, hints) };
  }).sort((a, b) => b.score - a.score);
  return scored[0].score > scored[1].score ? scored[0].m : null;
}

async function applyEdit({ stateDir, state, repo, match, from, to }) {
  const { file } = match;
  const pending = repoPending(state, repo);
  const ours = [...pending.edits, ...pending.unpushed].some((e) => e.file === file);
  if (!ours && await isDirty(repo, file)) {
    return refuse(409, `${file} 有還沒 commit 的修改，先處理完再改`);
  }
  const full = path.join(repo, file);
  const content = fs.readFileSync(full, 'utf8');
  fs.writeFileSync(full, replaceAt(content, match.index, match.length, to), 'utf8');
  const edit = { file, from, to, at: new Date().toISOString() };
  const next = withPending(state, repo, { ...pending, edits: [...pending.edits, edit] });
  writeState(stateDir, next);
  return reply(200, { ok: true, status: 'done', repoName: path.basename(repo), file, line: match.line, pending: pendingCount(next, repo) });
}

async function edit({ stateDir }, input) {
  const from = typeof input.text === 'string' ? input.text.trim() : '';
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const host = hostOf(input.url);
  if (!from || !to) return refuse(400, '沒有內容');
  if (from.length > MAX_TEXT || to.length > MAX_TEXT) return refuse(400, '這段字太長');
  if (from === to) return refuse(400, '沒有改任何字');
  if (!host) return refuse(400, '不知道是哪個網站');
  const risky = newRiskyChars(from, to);
  if (risky.length) return refuse(422, `新的字裡有可能弄壞程式的符號：${risky.map((c) => JSON.stringify(c)).join(' ')}`);

  const state = readState(stateDir);
  const repo = projectFor(state, host);
  if (!repo) return reply(200, { ok: true, status: 'unset', host });

  const matches = await matchesInRepo(repo, from);
  if (!matches.length) return reply(200, { ok: true, status: 'notfound', repoName: path.basename(repo) });

  const pick = input.pick && typeof input.pick === 'object' ? input.pick : null;
  const hints = { before: typeof input.before === 'string' ? input.before : '', after: typeof input.after === 'string' ? input.after : '' };
  const chosen = pick
    ? matches.find((m) => m.file === pick.file && m.nth === pick.nth)
    : clearWinner(matches, repo, hints);
  if (pick && !chosen) return refuse(409, '那個位置已經變了，再試一次');
  if (chosen) return applyEdit({ stateDir, state, repo, match: chosen, from, to });
  if (matches.length > MAX_CHOICES) return reply(200, { ok: true, status: 'toomany', count: matches.length });
  return reply(200, { ok: true, status: 'choose', repoName: path.basename(repo), matches: matches.map(publicMatch) });
}

function pending({ stateDir }, input) {
  const state = readState(stateDir);
  const repo = projectFor(state, String(input.host || ''));
  if (!repo) return reply(200, { ok: true, count: 0 });
  return reply(200, { ok: true, count: pendingCount(state, repo), repoName: path.basename(repo) });
}

const clip = (s) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s).replace(/\s+/g, ' ');

const commitMessage = (edits) => [
  `chore: 網頁改字 ${edits.length} 處`,
  '',
  ...edits.map((e) => `- ${e.file}: 「${clip(e.from)}」→「${clip(e.to)}」`),
].join('\n');

async function submit({ stateDir }, input) {
  let state = readState(stateDir);
  const repo = projectFor(state, hostOf(input.url));
  let entry = repo ? repoPending(state, repo) : { edits: [], unpushed: [] };
  if (!entry.edits.length && !entry.unpushed.length) return refuse(400, '沒有要送出的修改');

  let commit = '';
  try {
    if (entry.edits.length) {
      const files = [...new Set(entry.edits.map((e) => e.file))];
      commit = await commitFiles(repo, files, commitMessage(entry.edits));
      entry = { edits: [], unpushed: [...entry.unpushed, ...entry.edits] };
      state = writeState(stateDir, withPending(state, repo, entry));
    }
    await push(repo);
  } catch (err) {
    return refuse(502, `送不出去：${err.message}`);
  }
  writeState(stateDir, withPending(state, repo, { edits: [], unpushed: [] }));
  return reply(200, { ok: true, repoName: path.basename(repo), count: entry.unpushed.length, commit });
}

// One request at a time: edits and submits touch the same files and state.
let queue = Promise.resolve();
const inTurn = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

function handle(key, input, config) {
  if (key === 'GET /pending') return Promise.resolve(pending(config, input));
  if (key === 'POST /fix') return inTurn(() => edit(config, input));
  return inTurn(() => submit(config, input));
}

module.exports = { handle };
