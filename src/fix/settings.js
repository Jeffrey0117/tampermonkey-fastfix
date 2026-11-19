'use strict';
const path = require('node:path');
const { listRepos } = require('./search');
const { parseAfter, describeAfter } = require('./after-send');
const { readState, writeState, withSite, withoutSite } = require('./store');

// "https://Shop.example.com/pricing" or "shop.example.com:3000" -> "shop.example.com[:3000]"
function normalizeHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).host; } catch (_) { return ''; }
}

// What the settings page shows: which site edits which project, what happens
// after a send, and the projects to pick from.
function listSettings({ stateDir, roots }) {
  const state = readState(stateDir);
  return {
    sites: Object.entries(state.sites)
      .map(([host, repo]) => ({ host, name: path.basename(repo), after: describeAfter(state.after[host]) }))
      .sort((a, b) => a.host.localeCompare(b.host)),
    projects: listRepos(roots).map((repo) => path.basename(repo)).sort((a, b) => a.localeCompare(b)),
  };
}

function setSite({ stateDir, roots }, hostInput, projectName, afterKind, afterValue) {
  const host = normalizeHost(hostInput);
  if (!host) return { ok: false, error: '網域看不懂' };
  const repo = listRepos(roots).find((dir) => path.basename(dir) === String(projectName || '').trim());
  if (!repo) return { ok: false, error: '沒有這個專案' };
  const parsed = parseAfter(afterKind, afterValue);
  if (parsed.error) return { ok: false, error: parsed.error };
  writeState(stateDir, withSite(readState(stateDir), host, repo, parsed.after));
  return { ok: true, host };
}

function removeSite({ stateDir }, hostInput) {
  const host = normalizeHost(hostInput);
  writeState(stateDir, withoutSite(readState(stateDir), host));
  return { ok: true, host };
}

module.exports = { listSettings, setSite, removeSite, normalizeHost };
