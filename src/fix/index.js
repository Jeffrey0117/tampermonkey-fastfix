'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDirty, commitFiles, push, catchUp } = require('./git');
const { matchesInRepo } = require('./search');
const { newRiskyChars, replaceAt, contextScore } = require('./match');
const { parseLook, describeLook, applyLook, usesTailwind } = require('./style');
const { parseMark, restyleByElement } = require('./element');
const { withBreaks, linesOf } = require('./breaks');
const { runAfter } = require('./after-send');
const { LOOK_MARK, isLookEdit, nextDelivery, openDelivery, closeDelivery } = require('./delivery');
const { readState, writeState, repoPending, withPending, withSent, withDelivery } = require('./store');

const MAX_CHOICES = 12;
const MAX_TEXT = 2000;
const SUMMARY_MAX = 60;
const LANDINGS = ['live', 'dismissed'];

const reply = (status, body) => ({ status, body });
const refuse = (status, error) => reply(status, { ok: false, error });

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

// The page an edit was made on, without the #part: where to look for the new words later.
// Where on the page the change is, as the userscript worked it out. Only plain
// "tag:nth-child(n) > ..." chains are kept; anything else is dropped.
const SPOT = /^body(?: > [a-z][a-z0-9-]*:nth-child\(\d{1,4}\)){1,60}$/;
const spotOf = (value) => (typeof value === 'string' && SPOT.test(value) ? value : '');

const cssLook = (look) => ({
  ...(look.fontSize ? { fontSize: `${look.fontSize}px` } : {}),
  ...(look.fontWeight ? { fontWeight: String(look.fontWeight) } : {}),
  ...(look.color ? { color: look.color } : {}),
});

function pageOf(url) {
  try { const u = new URL(url); return u.origin + u.pathname + u.search; } catch (_) { return ''; }
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
  return [...history].reverse().find((e) => !isLookEdit(e) && (text.includes(e.from) || e.from.includes(text))) || null;
}

// What the clicked words are in the source now, following the edits made to them one after another.
function becameWhat(state, repo, text) {
  const pending = repoPending(state, repo);
  const history = [...(state.sent[repo] || []), ...pending.unpushed, ...pending.edits];
  return history.reduce((now, e) => (!isLookEdit(e) && e.from === now ? e.to : now), text);
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
  try {
    await catchUp(repo);
  } catch (err) {
    return { reply: refuse(409, `${repoName} 比線上的舊，自動更新失敗：${err.message}`) };
  }

  // The page only shows new words once they are live. Until then a click on the
  // old words means the words an earlier edit turned them into.
  let matches = await matchesInRepo(repo, from);
  let current = from;
  if (!matches.length) {
    const earlier = alreadyChanged(state, repo, from);
    current = becameWhat(state, repo, from);
    if (current !== from) matches = await matchesInRepo(repo, current);
    if (!matches.length && earlier) return { reply: reply(200, { ok: true, status: 'stale', repoName, from: earlier.from, to: earlier.to }) };
    if (!matches.length) return { reply: reply(200, { ok: true, status: 'notfound', repoName }), missing: { state, repo, repoName, from } };
  }

  const pick = input.pick && typeof input.pick === 'object' ? input.pick : null;
  const hints = { before: typeof input.before === 'string' ? input.before : '', after: typeof input.after === 'string' ? input.after : '' };
  const match = pick ? matches.find((m) => m.file === pick.file && m.nth === pick.nth) : clearWinner(matches, repo, hints);
  if (pick && !match) return { reply: refuse(409, '那個位置已經變了，再試一次') };
  if (match) return { found: { state, repo, repoName, match, from: current } };
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

  const wrote = result.classes ? { classes: result.classes } : {};
  const next = withPending(state, repo, { ...pending, edits: [...pending.edits, { file, ...record, ...wrote, at: new Date().toISOString() }] });
  writeState(stateDir, next);
  return reply(200, { ok: true, status: 'done', repoName, file, line: match.line, pending: pendingCount(next, repo) });
}

async function edit(config, input) {
  const from = typeof input.text === 'string' ? input.text.trim() : '';
  // a line break (Shift+Enter in the box) is kept; how it is written depends on the file (see breaks.js)
  const to = typeof input.to === 'string' ? linesOf(input.to.replace(/\r\n?/g, '\n')).join('\n') : '';
  if (!to) return refuse(400, '沒有內容');
  if (to.length > MAX_TEXT) return refuse(400, '這段字太長');
  if (from === to) return refuse(400, '沒有改任何字');
  const risky = newRiskyChars(from, to).filter((c) => c !== '\n');
  if (risky.length) return refuse(422, `新的字裡有可能弄壞程式的符號：${risky.map((c) => JSON.stringify(c)).join(' ')}`);

  const where = await locate(config, input);
  if (where.reply) return where.reply;
  const { match, from: current } = where.found;
  if (current === to) return refuse(400, '沒有改任何字');
  return applyChange(config, where.found, (content) => {
    const written = withBreaks(where.found.repo, match.file, content, match, to);
    return written.reason ? written : { content: replaceAt(content, match.index, match.length, written.text) };
  }, { from: current, to, page: pageOf(input.url), path: spotOf(input.path) });
}

const lineAt = (repo, match) => fs.readFileSync(path.join(repo, match.file), 'utf8').slice(0, match.index).split('\n').length;

async function restyle(config, input) {
  const look = parseLook(input.look);
  if (!look) return refuse(400, '樣式看不懂');
  const where = await locate(config, input);
  // The words may come from a database or a list further up the file; the element that
  // shows them is still in the project, and the page says which one it is.
  const base = where.found || where.missing;
  if (!base) return where.reply;
  const record = { from: base.from, to: `${LOOK_MARK}${describeLook(look)}`, page: pageOf(input.url), path: spotOf(input.path), look: cssLook(look) };
  const mark = parseMark(input.mark);
  if (mark && usesTailwind(base.repo)) {
    const hint = where.found ? { text: base.from, file: base.match.file, line: lineAt(base.repo, base.match) } : { text: base.from };
    const done = restyleByElement(base.repo, mark, look, hint);
    if (done && done.reason) return reply(200, { ok: true, status: 'cant', reason: done.reason });
    if (done) return applyChange(config, { ...base, match: { file: done.file } }, () => ({ content: done.content, classes: done.classes }), record);
  }
  if (where.reply) return where.reply;
  const { repo, match } = where.found;
  return applyChange(config, where.found, (content) => applyLook({ repo, file: match.file, content, match, look }), record);
}

function pending({ stateDir }, input) {
  const state = readState(stateDir);
  const repo = projectFor(state, String(input.host || ''));
  if (!repo) return reply(200, { ok: true, count: 0 });
  const delivery = openDelivery(state.deliveries[repo]);
  return reply(200, { ok: true, count: pendingCount(state, repo), repoName: path.basename(repo), ...(delivery ? { delivery } : {}) });
}

const clip = (s) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s).replace(/\s+/g, ' ');

const commitMessage = (edits) => [
  `chore: 網頁改字 ${edits.length} 處`,
  '',
  ...edits.map((e) => `- ${e.file}: 「${clip(e.from)}」→「${clip(e.to)}」`),
].join('\n');

// Commit and push what is pending. Nothing is lost when the push fails.
async function pushPending(stateDir, state, repo, entry) {
  let commit = '';
  let next = entry;
  let saved = state;
  if (entry.edits.length) {
    const files = [...new Set(entry.edits.map((e) => e.file))];
    commit = await commitFiles(repo, files, commitMessage(entry.edits));
    next = { edits: [], unpushed: [...entry.unpushed, ...entry.edits] };
    saved = writeState(stateDir, withPending(state, repo, next));
  }
  await push(repo);
  return { commit, sentEdits: next.unpushed, state: saved };
}

// Send: push, then do what this site needs to really show it (see after-send.js),
// and leave a delivery that stays "waiting" until the page is seen with the new words.
// With nothing new to send, a delivery whose deploy call failed is tried again.
async function submit(config, input) {
  const { stateDir } = config;
  let state = readState(stateDir);
  const host = hostOf(input.url);
  const repo = projectFor(state, host);
  const entry = repo ? repoPending(state, repo) : { edits: [], unpushed: [] };
  const last = repo ? state.deliveries[repo] : null;
  const nothingNew = !entry.edits.length && !entry.unpushed.length;
  if (nothingNew && !(last && last.status === 'failed')) return refuse(400, '沒有要送出的修改');

  let commit = nothingNew ? last.commit : '';
  let sentEdits = [];
  if (!nothingNew) {
    try {
      ({ commit, sentEdits, state } = await pushPending(stateDir, state, repo, entry));
    } catch (err) {
      return refuse(502, `送不出去：${err.message}`);
    }
    state = writeState(stateDir, withSent(withPending(state, repo, { edits: [], unpushed: [] }), repo, sentEdits));
  }

  const error = await runAfter(config, repo, state.after[host]).then(() => '', (err) => `叫部署失敗：${err.message}`);
  const delivery = nextDelivery(last, sentEdits, { commit, page: pageOf(input.url), error });
  writeState(stateDir, withDelivery(state, repo, delivery));
  return reply(200, { ok: true, repoName: path.basename(repo), count: sentEdits.length, commit, delivery: openDelivery(delivery) });
}

// The page was seen with the new words ("live"), or the person stopped waiting ("dismissed").
function landed({ stateDir }, input) {
  if (!LANDINGS.includes(input.result)) return refuse(400, '結果看不懂');
  const state = readState(stateDir);
  const repo = projectFor(state, hostOf(input.url));
  const delivery = repo ? state.deliveries[repo] : null;
  if (delivery && openDelivery(delivery)) writeState(stateDir, withDelivery(state, repo, closeDelivery(delivery, input.result)));
  return reply(200, { ok: true });
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
  if (key === 'POST /landed') return inTurn(() => landed(config, input));
  return inTurn(() => submit(config, input));
}

module.exports = { handle };
