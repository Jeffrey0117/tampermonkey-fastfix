'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDirty, commitFiles, push } = require('./git');
const { matchesInRepo } = require('./search');
const { newRiskyChars, replaceAt, contextScore } = require('./match');
const { parseLook, describeLook, applyLook } = require('./style');
const { readState, writeState, repoPending, withPending, withSent } = require('./store');

const MAX_CHOICES = 12;
const MAX_TEXT = 2000;
const SUMMARY_MAX = 60;
const LOOK_MARK = '（樣式）';

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

// The words are not in the source, but an earlier edit here replaced them:
// the page is simply still showing the old version.
function alreadyChanged(state, repo, text) {
  const pending = repoPending(state, repo);
  const history = [...(state.sent[repo] || []), ...pending.unpushed, ...pending.edits];
  const isLook = (e) => e.to.startsWith(LOOK_MARK);
  return [...history].reverse().find((e) => !isLook(e) && (text.includes(e.from) || e.from.includes(text))) || null;
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

// Finds the one place in the site's project where the clicked words live.
// Gives back either { found } or the { reply } that ends the request.
async function locate({ stateDir }, input) {
  const from = typeof input.text === 'string' ? input.text.trim() : '';
  const host = hostOf(input.url);
  if (!from) return { reply: refuse(400, '沒有內容') };
  if (from.length > MAX_TEXT) return { reply: refuse(400, '這段字太長') };
  if (!host) return { reply: refuse(400, '不知道是哪個網站') };

  const state = readState(stateDir);
  const repo = projectFor(state, host);
  if (!repo) return { reply: reply(200, { ok: true, status: 'unset', host }) };
  const repoName = path.basename(repo);

  const matches = await matchesInRepo(repo, from);
  if (!matches.length) {
    const earlier = alreadyChanged(state, repo, from);
    if (earlier) return { reply: reply(200, { ok: true, status: 'stale', repoName, from: earlier.from, to: earlier.to }) };
    return { reply: reply(200, { ok: true, status: 'notfound', repoName }) };
  }

  const pick = input.pick && typeof input.pick === 'object' ? input.pick : null;
  const hints = { before: typeof input.before === 'string' ? input.before : '', after: typeof input.after === 'string' ? input.after : '' };
  const match = pick ? matches.find((m) => m.file === pick.file && m.nth === pick.nth) : clearWinner(matches, repo, hints);
  if (pick && !match) return { reply: refuse(409, '那個位置已經變了，再試一次') };
  if (match) return { found: { state, repo, repoName, match, from } };
  if (matches.length > MAX_CHOICES) return { reply: reply(200, { ok: true, status: 'toomany', count: matches.length }) };
  return { reply: reply(200, { ok: true, status: 'choose', repoName, matches: matches.map(publicMatch) }) };
}

// Writes one change to the file and counts it as pending. `change(content)`
// returns the new content, or { reason } when it cannot be done.
async function applyChange({ stateDir }, { state, repo, repoName, match }, change, record) {
  const { file } = match;
  const pending = repoPending(state, repo);
  const ours = [...pending.edits, ...pending.unpushed].some((e) => e.file === file);
  if (!ours && await isDirty(repo, file)) return refuse(409, `${file} 有還沒 commit 的修改，先處理完再改`);

  const full = path.join(repo, file);
  const result = change(fs.readFileSync(full, 'utf8'));
  if (result.reason) return reply(200, { ok: true, status: 'cant', reason: result.reason });
  fs.writeFileSync(full, result.content, 'utf8');

  const next = withPending(state, repo, { ...pending, edits: [...pending.edits, { file, ...record, at: new Date().toISOString() }] });
  writeState(stateDir, next);
  return reply(200, { ok: true, status: 'done', repoName, file, line: match.line, pending: pendingCount(next, repo) });
}

async function edit(config, input) {
  const from = typeof input.text === 'string' ? input.text.trim() : '';
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  if (!to) return refuse(400, '沒有內容');
  if (to.length > MAX_TEXT) return refuse(400, '這段字太長');
  if (from === to) return refuse(400, '沒有改任何字');
  const risky = newRiskyChars(from, to);
  if (risky.length) return refuse(422, `新的字裡有可能弄壞程式的符號：${risky.map((c) => JSON.stringify(c)).join(' ')}`);

  const where = await locate(config, input);
  if (where.reply) return where.reply;
  const { match } = where.found;
  return applyChange(config, where.found, (content) => ({ content: replaceAt(content, match.index, match.length, to) }), { from, to });
}

async function restyle(config, input) {
  const look = parseLook(input.look);
  if (!look) return refuse(400, '樣式看不懂');
  const where = await locate(config, input);
  if (where.reply) return where.reply;
  const { repo, match, from } = where.found;
  return applyChange(config, where.found,
    (content) => applyLook({ repo, file: match.file, content, match, look }),
    { from, to: `${LOOK_MARK}${describeLook(look)}` });
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
  writeState(stateDir, withSent(withPending(state, repo, { edits: [], unpushed: [] }), repo, entry.unpushed));
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
  if (key === 'POST /style') return inTurn(() => restyle(config, input));
  return inTurn(() => submit(config, input));
}

module.exports = { handle };
