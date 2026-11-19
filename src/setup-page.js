'use strict';

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cdn-loop'];

const isLoopbackAddress = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

// The setup page hands out the token and changes settings, so it is only for
// someone sitting at this machine who typed the address: not a proxy, not a
// tunnel, not another web page.
function isDirectLocalVisit(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (!isLoopbackHost(req.headers.host)) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'none' || site === 'same-origin';
}

// Opening the setup page in its own tab is fine however the person got there
// (a link in another page, a bookmark bar, a reload of either): the other page
// cannot read what the tab shows, and the page refuses to be framed.
function isSetupPageVisit(req) {
  if (isDirectLocalVisit(req)) return true;
  const arrivedByLink = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  return arrivedByLink && isDirectLocalVisit({ socket: req.socket, headers: { ...req.headers, 'sec-fetch-site': 'none' } });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
  body { margin: 0; background: #FAF7F2; color: #1F1B16; font: 16px/1.7 'Noto Sans TC', system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 56px 20px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 40px 0 6px; }
  p { margin: 0 0 14px; color: #6B6259; }
  ol { padding-left: 22px; margin: 16px 0; }
  li { margin-bottom: 12px; }
  a.btn, button { display: inline-block; background: #E09A2E; color: #fff; font: inherit; font-weight: 700; text-decoration: none; padding: 9px 18px; border: 0; border-radius: 12px; cursor: pointer; }
  button.plain { background: none; color: #A49A8E; padding: 4px 8px; font-weight: 400; white-space: nowrap; }
  button.plain:hover { color: #B4412F; }
  code { background: #fff; border: 1px solid #EBE4DA; border-radius: 6px; padding: 1px 6px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; }
  td { padding: 9px 4px; border-bottom: 1px solid #EBE4DA; }
  td.last { text-align: right; width: 1%; }
  td.none { color: #A49A8E; }
  form.add { display: flex; flex-wrap: wrap; gap: 8px; }
  td.after { color: #6B6259; font-size: 14px; }
  form.add select { flex: 0 0 auto; box-sizing: border-box; padding: 9px 11px; border: 1px solid #E0D7CA; border-radius: 10px; background: #fff; color: inherit; font: inherit; }
  form.add input.wide { flex-basis: 100%; }
  form.add input { flex: 1 1 180px; min-width: 0; box-sizing: border-box; padding: 9px 11px; border: 1px solid #E0D7CA; border-radius: 10px; background: #fff; color: inherit; font: inherit; }
  form.inline { display: inline; margin: 0; }
  .msg { margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; background: #fff; border: 1px solid #EBE4DA; font-weight: 700; }
  .msg.bad { border-color: #B4412F; color: #B4412F; }
  #fastfix-status { margin-top: 8px; padding: 14px 16px; border-radius: 12px; background: #fff; border: 1px solid #EBE4DA; font-weight: 700; }
  #fastfix-status[data-state="ok"] { border-color: #3E9B5F; color: #2C7A48; }
`;

function siteRows(sites, token) {
  if (!sites.length) return '<tr><td class="none" colspan="4">還沒有設定任何網站。</td></tr>';
  return sites.map(({ host, name, after }) => `<tr>
      <td>${escapeHtml(host)}</td>
      <td>${escapeHtml(name)}</td>
      <td class="after">${escapeHtml(after)}</td>
      <td class="last"><form class="inline" method="post" action="/setup/sites/remove">
        <input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="host" value="${escapeHtml(host)}">
        <button class="plain" type="submit">移除</button></form></td>
    </tr>`).join('\n');
}

function renderSetupPage({ token, sites, projects, roots, host = '', message = '', error = '' }) {
  const note = error ? `<div class="msg bad">${escapeHtml(error)}</div>` : (message ? `<div class="msg">${escapeHtml(message)}</div>` : '');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="fastfix-token" content="${escapeHtml(token)}">
<title>fastFix 設定</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>fastFix</h1>
  <p>按住 Alt 點網頁上的字，直接改掉原始碼我愛你</p>

  <h2>哪個網站改哪個專案</h2>
  <p>先在這裡設好。設過的網站，Alt + 點就只會動那一個專案肏你媽<br>最後一欄是按「送出」之後要做什麼，網站才會真的變成新的。要改就用同一個網域再加一次。</p>
  ${note}
  <table>
    ${siteRows(sites, token)}
  </table>
  <form class="add" method="post" action="/setup/sites">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input name="host" placeholder="網域，例如 localhost:3000" value="${escapeHtml(host)}" required>
    <input name="project" list="projects" placeholder="專案資料夾名稱" autocomplete="off" required>
    <datalist id="projects">${projects.map((p) => `<option value="${escapeHtml(p)}">`).join('')}</datalist>
    <select name="after" aria-label="送出後要做什麼">
      <option value="push">送出後：push 就會自己部署</option>
      <option value="cloudpipe">送出後：叫 CloudPipe 部署</option>
      <option value="command">送出後：跑一個指令</option>
    </select>
    <input class="wide" name="afterValue" placeholder="CloudPipe 的專案代號，或要跑的指令（push 就會部署的留空）" autocomplete="off">
    <button type="submit">加入</button>
  </form>
  <p style="margin-top:10px;font-size:14px">專案清單來自 <code>${escapeHtml(roots.join('、'))}</code></p>

  <h2>安裝腳本</h2>
  <ol>
    <li><a class="btn" href="/fastfix.user.js">安裝腳本</a><br>Tampermonkey 會跳出安裝畫面，按「安裝」。只要裝這一次，之後有新功能會自己生效。</li>
    <li>回到這一頁按 <code>F5</code> 重新整理。下面那一格變成「肏你媽」就完成了。</li>
  </ol>
  <div id="fastfix-status" data-state="waiting">還沒連上：腳本裝好後重新整理這一頁。</div>
</main>
</body>
</html>
`;
}

// script-src 'unsafe-eval': the page has no scripts of its own, but the installed fastFix script
// runs the code it fetched from this service, and the browser counts that against the page.
const SETUP_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

module.exports = { isDirectLocalVisit, isSetupPageVisit, renderSetupPage, SETUP_HEADERS };
