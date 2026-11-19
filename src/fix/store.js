'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'state.json';
const SENT_KEPT = 30;

// sites:      host -> repo folder (set on the settings page)
// after:      host -> what to do once the edits are pushed (missing = the push deploys by itself)
// pending:    repo folder -> { edits: [not committed], unpushed: [committed, not pushed] }
// sent:       repo folder -> the last edits that were pushed (to recognise a page that still shows the old words)
// deliveries: repo folder -> the last send and how far it got: waiting -> live | dismissed, or failed
function readState(stateDir) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path.join(stateDir, FILE_NAME), 'utf8')) || {}; } catch (_) { /* no state yet */ }
  return {
    sites: { ...data.sites },
    after: { ...data.after },
    pending: { ...data.pending },
    sent: { ...data.sent },
    deliveries: { ...data.deliveries },
  };
}

function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, FILE_NAME), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

const repoPending = (state, repo) => {
  const entry = state.pending[repo] || {};
  return { edits: entry.edits || [], unpushed: entry.unpushed || [] };
};

function withPending(state, repo, next) {
  const { [repo]: _dropped, ...rest } = state.pending;
  const empty = !next.edits.length && !next.unpushed.length;
  return { ...state, pending: empty ? rest : { ...rest, [repo]: next } };
}

const withSent = (state, repo, edits) => ({
  ...state,
  sent: { ...state.sent, [repo]: [...(state.sent[repo] || []), ...edits].slice(-SENT_KEPT) },
});

const withDelivery = (state, repo, delivery) => ({ ...state, deliveries: { ...state.deliveries, [repo]: delivery } });

function withSite(state, host, repo, after) {
  const { [host]: _old, ...otherAfter } = state.after;
  return { ...state, sites: { ...state.sites, [host]: repo }, after: after ? { ...otherAfter, [host]: after } : otherAfter };
}

function withoutSite(state, host) {
  const { [host]: _removed, ...sites } = state.sites;
  const { [host]: _alsoRemoved, ...after } = state.after;
  return { ...state, sites, after };
}

module.exports = { readState, writeState, repoPending, withPending, withSent, withDelivery, withSite, withoutSite };
