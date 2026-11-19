'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'state.json';
const EMPTY = { sites: {}, pending: {} };

// sites:   host -> repo folder (set on the settings page)
// pending: repo folder -> { edits: [not committed], unpushed: [committed, not pushed] }
function readState(stateDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateDir, FILE_NAME), 'utf8'));
    return { sites: { ...data.sites }, pending: { ...data.pending } };
  } catch (_) {
    return { ...EMPTY };
  }
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

const withSite = (state, host, repo) => ({ ...state, sites: { ...state.sites, [host]: repo } });

function withoutSite(state, host) {
  const { [host]: _removed, ...sites } = state.sites;
  return { ...state, sites };
}

module.exports = { readState, writeState, repoPending, withPending, withSite, withoutSite };
