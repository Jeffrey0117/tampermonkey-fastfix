'use strict';
const fs = require('node:fs');
const { listSites, devCopy } = require('./cloudpipe');

// Which project a site edits, and what a send has to do afterwards.
//   1. a line on the settings page: always wins
//   2. a site CloudPipe deploys: the project's working copy on this machine
// Nothing is guessed: both are settings somebody made, here or in CloudPipe.
// Returns { repo, after, cloudpipe? }, or { reason } when CloudPipe knows the site
// but it cannot be edited from here, or {} when nobody knows the site.
async function siteFor(config, state, hostInput) {
  const host = String(hostInput || '').toLowerCase();
  const manual = state.sites[host] || state.sites[hostInput];
  if (manual) return fs.existsSync(manual) ? { repo: manual, after: state.after[host] || state.after[hostInput] || null } : {};
  const site = (await listSites(config.cloudpipe)).find((s) => s.host === host);
  if (!site) return {};
  const dev = await devCopy(site, config.roots, config.cloudpipe);
  if (dev.reason) return { reason: dev.reason };
  return { repo: dev.repo, cloudpipe: site.id, after: site.selfDeploys ? null : { kind: 'cloudpipe', id: site.id } };
}

module.exports = { siteFor };
