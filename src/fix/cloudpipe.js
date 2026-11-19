'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./git');
const { listRepos } = require('./search');

// CloudPipe already knows which domain is which project, and how each deploy went.
// fastFix reads both, so a site deployed there needs no line on the settings page,
// and a deploy that failed is reported as that instead of "the site is still old".
// Everything here is read-only except askCloudpipe, and when CloudPipe cannot be
// reached the answer is simply "nothing known": the settings page still works.

const LIST_FRESH_MS = 30000;
const QUICK_TIMEOUT_MS = 4000;
const TRIGGER_TIMEOUT_MS = 15000;
const DEPLOYS_LOOKED_AT = 15;

// The CloudPipe key: CLOUDPIPE_TOKEN, or the serviceToken in the file CLOUDPIPE_CONFIG points at.
function cloudpipeToken({ token, configFile } = {}) {
  if (token) return token;
  if (!configFile) return '';
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^﻿/, '')).serviceToken || ''; } catch (_) { return ''; }
}

async function api(cloudpipe, route, { method = 'GET', timeout = QUICK_TIMEOUT_MS } = {}) {
  const token = cloudpipeToken(cloudpipe);
  if (!token) throw new Error('沒有 CloudPipe 的金鑰（.env 的 CLOUDPIPE_TOKEN 或 CLOUDPIPE_CONFIG）');
  let res;
  try {
    res = await fetch(`${cloudpipe.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (_) {
    throw new Error('連不上 CloudPipe');
  }
  if (!res.ok) throw new Error(`CloudPipe 回了 ${res.status}`);
  return res.json().catch(() => ({}));
}

const askCloudpipe = (cloudpipe, id) => api(cloudpipe || {}, `/api/_admin/deploy/projects/${encodeURIComponent(id)}/deploy`, { method: 'POST', timeout: TRIGGER_TIMEOUT_MS });

// Every domain CloudPipe serves, with the project behind it. The same rule its own
// router uses: "<id>.<domain>" unless the project hides it, plus its custom domains.
function sitesOf(projects, domain) {
  return projects.flatMap((p) => {
    if (!p || typeof p.id !== 'string') return [];
    const hosts = [
      ...(domain && !p.hideDefaultDomain ? [`${p.id}.${domain}`] : []),
      ...(Array.isArray(p.customDomains) ? p.customDomains : []),
    ].filter((h) => typeof h === 'string' && h).map((h) => h.toLowerCase());
    return [...new Set(hosts)].map((host) => ({
      host,
      id: p.id,
      branch: p.branch || 'main',
      repoUrl: p.repoUrl || '',
      directory: p.directory || '',
      selfDeploys: Boolean(p.webhookId),          // a push to its repo starts a deploy by itself
    }));
  });
}

const lists = new Map();                          // CloudPipe address -> { at, sites }
async function listSites(cloudpipe) {
  if (!cloudpipe || !cloudpipe.url || !cloudpipeToken(cloudpipe)) return [];
  const kept = lists.get(cloudpipe.url);
  if (kept && Date.now() - kept.at < LIST_FRESH_MS) return kept.sites;
  try {
    const [settings, list] = await Promise.all([api(cloudpipe, '/api/_admin/config'), api(cloudpipe, '/api/_admin/deploy/projects')]);
    const sites = sitesOf(Array.isArray(list.projects) ? list.projects : [], String(settings.domain || '').toLowerCase());
    lists.set(cloudpipe.url, { at: Date.now(), sites });
    return sites;
  } catch (_) {
    return kept ? kept.sites : [];                // CloudPipe is restarting: go by what it said last
  }
}

const real = (dir) => { try { return fs.realpathSync(dir).toLowerCase(); } catch (_) { return ''; } };
// "https://github.com/Me/Shop.git", "git@github.com:Me/Shop" -> "github.com/me/shop"
const sameRepoName = (url) => String(url).trim().toLowerCase()
  .replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(':', '/').replace(/\.git$/, '').replace(/\/+$/, '');

// The folder CloudPipe runs the project from. Editing there is never right: the next
// deploy throws the edit away, and until then CloudPipe refuses to deploy at all.
function runningCopy(site, cloudpipe) {
  if (!cloudpipe.configFile || !site.directory) return '';
  return real(path.resolve(path.dirname(cloudpipe.configFile), site.directory));
}

// The copy of the project on this machine that is worked in and pushed from:
// a repo under the project folders with the project's name, that is not the running
// copy, pushes to the repo CloudPipe deploys, and is on the branch it deploys.
// Returns { repo } or { reason }.
async function devCopy(site, roots, cloudpipe) {
  const running = runningCopy(site, cloudpipe);
  const named = listRepos(roots).filter((dir) => path.basename(dir).toLowerCase() === site.id.toLowerCase());
  const repo = named.find((dir) => !running || real(dir) !== running);
  if (!repo) return { reason: named.length ? `${site.id} 在這台電腦上只有 CloudPipe 正在跑的那一份，那份不能改` : `這台電腦找不到 ${site.id} 開發用的資料夾` };
  const name = path.basename(repo);
  const origin = (await git(repo, ['config', '--get', 'remote.origin.url'], { okCodes: [0, 1] })).stdout;
  if (site.repoUrl && sameRepoName(origin) !== sameRepoName(site.repoUrl)) return { reason: `${name} 推上去的地方不是 CloudPipe 部署的那個 repo` };
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (branch !== site.branch) return { reason: `${name} 現在在 ${branch} 分支，CloudPipe 部署的是 ${site.branch}` };
  return { repo };
}

// How CloudPipe's deploy of one pushed commit is doing:
//   { stage: 'building' | 'done' }   or   { stage: 'failed', error }   or   null (it has not started one, or cannot be asked)
const sameCommit = (a, b) => Boolean(a) && Boolean(b) && (String(a).startsWith(b) || String(b).startsWith(a));
async function deployOf(cloudpipe, id, commit) {
  let list;
  try {
    list = await api(cloudpipe, `/api/_admin/deploy/deployments?project=${encodeURIComponent(id)}&limit=${DEPLOYS_LOOKED_AT}`);
  } catch (_) { return null; }
  const mine = (Array.isArray(list.deployments) ? list.deployments : []).filter((d) => d && d.projectId === id && sameCommit(d.commit, commit));
  if (!mine.length) return null;
  const last = mine.reduce((a, b) => (String(b.startedAt) > String(a.startedAt) ? b : a));
  if (last.status === 'failed' || last.status === 'aborted') return { stage: 'failed', error: String(last.error || last.status).slice(0, 200) };
  if (last.status === 'success' || last.status === 'online' || last.status === 'skipped') return { stage: 'done' };
  return { stage: 'building' };
}

module.exports = { cloudpipeToken, askCloudpipe, listSites, devCopy, deployOf, sitesOf };
