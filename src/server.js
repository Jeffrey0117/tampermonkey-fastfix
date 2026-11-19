'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fix = require('./fix');
const { listSettings, setSite, removeSite } = require('./fix/settings');
const { isDirectLocalVisit, renderSetupPage, SETUP_HEADERS } = require('./setup-page');

const MAX_BODY_BYTES = 256 * 1024;
const USERSCRIPT_PATH = path.join(__dirname, '..', 'fastfix.user.js');
const FIX_ROUTES = ['POST /fix', 'POST /style', 'POST /submit', 'GET /pending'];
const SETTINGS_ROUTES = ['POST /setup/sites', 'POST /setup/sites/remove'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sameSecret(given, wanted) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(wanted)).digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenMatches(req, token) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return Boolean(match) && sameSecret(match[1], token);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooBig = true;      // keep draining so the reply can be sent
      else chunks.push(chunk);
    });
    req.on('end', () => (tooBig ? reject(new HttpError(413, '內容太大')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// A web page can POST text/plain cross-site without a preflight; JSON it cannot.
async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    req.resume();
    throw new HttpError(415, '只收 application/json');
  }
  let data;
  try { data = JSON.parse(await readBody(req)); } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, '不是 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, '格式不對');
  return data;
}

// The settings forms on the setup page. Same guard as the page itself, plus the
// token the page carries, so no other web page can change which project a site edits.
async function handleSettings(key, req, res, config) {
  if (!isDirectLocalVisit(req)) {
    req.resume();
    throw new HttpError(403, '設定只能在這台電腦上直接改');
  }
  const form = new URLSearchParams(await readBody(req));
  if (!sameSecret(form.get('token') || '', config.token)) throw new HttpError(401, '金鑰不對');
  const result = key === 'POST /setup/sites'
    ? setSite(config, form.get('host'), form.get('project'))
    : removeSite(config, form.get('host'));
  const back = new URLSearchParams(result.ok
    ? { msg: key === 'POST /setup/sites' ? `已設定 ${result.host}` : `已移除 ${result.host}` }
    : { err: result.error, host: form.get('host') || '' });
  res.writeHead(303, { location: `/setup?${back}`, 'cache-control': 'no-store' });
  res.end();
}

async function route(req, res, config) {
  const { pathname, searchParams } = new URL(req.url, 'http://local');
  const key = `${req.method} ${pathname}`;

  if (key === 'GET /health') return sendJson(res, 200, { ok: true });

  if (key === 'GET /setup') {
    if (!isDirectLocalVisit(req)) throw new HttpError(403, '設定頁只能在這台電腦上直接開');
    res.writeHead(200, SETUP_HEADERS);
    return res.end(renderSetupPage({
      token: config.token,
      roots: config.roots,
      ...listSettings(config),
      host: searchParams.get('host') || '',
      message: searchParams.get('msg') || '',
      error: searchParams.get('err') || '',
    }));
  }

  if (SETTINGS_ROUTES.includes(key)) return handleSettings(key, req, res, config);

  if (key === 'GET /fastfix.user.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(USERSCRIPT_PATH));
  }

  if (FIX_ROUTES.includes(key)) {
    if (!tokenMatches(req, config.token)) {
      req.resume();
      throw new HttpError(401, '金鑰不對');
    }
    let input = { host: searchParams.get('host') || '' };
    if (req.method === 'POST') input = await readJson(req);
    else req.resume();
    const out = await fix.handle(key, input, config);
    return sendJson(res, out.status, out.body);
  }

  req.resume();
  throw new HttpError(404, '沒有這個位置');
}

function createServer(config) {
  if (!config || !config.token) throw new Error('createServer: token is required');
  if (!config.stateDir || !Array.isArray(config.roots)) throw new Error('createServer: stateDir and roots are required');
  return http.createServer((req, res) => {
    route(req, res, config).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) process.stderr.write(`[fastfix] ${req.method} ${req.url}: ${err.stack || err}\n`);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: status === 500 ? '出錯了，看 server.log' : err.message });
      else res.end();
    });
  });
}

module.exports = { createServer };
