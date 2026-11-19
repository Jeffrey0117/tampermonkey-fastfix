// ==UserScript==
// @name         fastFix
// @namespace    fastfix
// @version      0.1.0
// @description  Alt + 點網頁上的字，直接改掉自己網站原始碼裡的那段字。改完幾處再一次送出。
// @homepageURL  https://github.com/Jeffrey0117/tampermonkey-fastfix
// @updateURL    https://raw.githubusercontent.com/Jeffrey0117/tampermonkey-fastfix/main/fastfix.user.js
// @downloadURL  https://raw.githubusercontent.com/Jeffrey0117/tampermonkey-fastfix/main/fastfix.user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_ENDPOINT = 'http://127.0.0.1:4480';
  const QUICK_TIMEOUT_MS = 8000;
  const WORK_TIMEOUT_MS = 100000;        // first search on a site looks through every repo; a push can be slow
  const TOAST_MS = 2600;
  const LONG_TOAST_MS = 9000;
  const BOX_MIN = 260;
  const BOX_MAX = 520;

  const endpoint = () => String(GM_getValue('endpoint', DEFAULT_ENDPOINT)).replace(/\/+$/, '');
  const token = () => String(GM_getValue('token', ''));

  // ---- setup page: pick the token up, no copy-paste ----
  function adoptTokenFromSetupPage() {
    if (location.origin !== new URL(endpoint()).origin || location.pathname !== '/setup') return;
    const meta = document.querySelector('meta[name="fastfix-token"]');
    const status = document.getElementById('fastfix-status');
    if (!meta || !meta.content) return;
    GM_setValue('token', meta.content);
    if (status) {
      status.dataset.state = 'ok';
      status.textContent = '已連上 ✓ 到自己的網站，按住 Alt 點一段字試試。';
    }
  }

  // ---- talking to the local service ----
  function call(method, path, body, timeout) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: endpoint() + path,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: timeout || QUICK_TIMEOUT_MS,
        onload: (res) => {
          let data = null;
          try { data = JSON.parse(res.responseText); } catch (_) { /* not json */ }
          if (res.status >= 200 && res.status < 300 && data) resolve(data);
          else reject(new Error((data && data.error) || 'fastFix 服務回了 ' + res.status));
        },
        onerror: () => reject(new Error('連不上 fastFix 服務')),
        ontimeout: () => reject(new Error('fastFix 服務沒有回應')),
      });
    });
  }

  // ---- everything we draw lives in one shadow root, away from page styles ----
  const STYLE = `
    :host { all: initial; }
    .box, .toast, .chip { position: fixed; font: 14px/1.5 'Noto Sans TC', system-ui, sans-serif; color: #1F1B16; }
    .box { z-index: 2147483647; box-sizing: border-box; padding: 10px; background: #FFFDF9; border: 1px solid #EBE4DA; border-radius: 14px;
           box-shadow: 0 14px 40px rgba(31,27,22,.26), 0 2px 6px rgba(31,27,22,.08); }
    .box textarea { box-sizing: border-box; display: block; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid #E0D7CA;
                    border-radius: 10px; background: #fff; color: inherit; font: inherit; resize: vertical; }
    .box textarea:focus { outline: 2px solid #E09A2E; outline-offset: -1px; }
    .box .hint { margin-top: 6px; font-size: 11px; color: #A49A8E; }
    .box .note { margin-top: 8px; font-size: 13px; color: #B4412F; }
    .box .choice { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; border: 1px solid #EBE4DA; border-radius: 10px;
                   background: #fff; color: inherit; font: inherit; text-align: left; cursor: pointer; word-break: break-all; }
    .box .choice:hover { background: #FCF1DD; }
    .box .choice b { display: block; font-size: 12px; color: #A49A8E; }
    .toast { z-index: 2147483647; right: 18px; bottom: 18px; max-width: 340px; padding: 10px 14px; background: #1F1B16; color: #fff;
             border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.25); word-break: break-all; }
    .toast.bad { background: #B4412F; }
    .chip { z-index: 2147483646; left: 18px; bottom: 18px; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px;
            background: #1F1B16; color: #fff; border-radius: 999px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
    .chip button { padding: 6px 14px; border: 0; border-radius: 999px; background: #E09A2E; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .chip button:disabled { opacity: .55; cursor: default; }
  `;

  let root = null;
  let boxEl = null;
  let chipEl = null;
  let toastTimer = 0;

  function shadow() {
    if (root && root.host.isConnected) return root;
    const host = document.createElement('div');
    host.id = 'fastfix-host';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    document.documentElement.appendChild(host);
    return root;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, bad, ms) {
    const r = shadow();
    const old = r.querySelector('.toast');
    if (old) old.remove();
    const el = make('div', bad ? 'toast bad' : 'toast', message);
    r.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), ms || TOAST_MS);
  }

  function closeBox() {
    if (boxEl) { boxEl.remove(); boxEl = null; }
  }

  // ---- the "N edits not sent yet" chip ----
  function editedHosts() {
    try {
      const hosts = JSON.parse(GM_getValue('hosts', '[]'));
      return Array.isArray(hosts) ? hosts : [];
    } catch (_) { return []; }
  }

  function rememberHost() {
    const hosts = editedHosts();
    if (!hosts.includes(location.host)) GM_setValue('hosts', JSON.stringify([...hosts, location.host]));
  }

  function showChip(count) {
    if (chipEl) { chipEl.remove(); chipEl = null; }
    if (!count) return;
    chipEl = make('div', 'chip');
    chipEl.appendChild(make('span', '', '已改 ' + count + ' 處，還沒送出'));
    const btn = make('button', '', '送出');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '送出中…';
      call('POST', '/submit', { url: location.href }, WORK_TIMEOUT_MS)
        .then((data) => {
          showChip(0);
          toast('已送出 ' + data.count + ' 處到 ' + data.repoName + '，部署完就是新的', false, LONG_TOAST_MS);
        })
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = '送出';
          toast(err.message, true, LONG_TOAST_MS);
        });
    });
    chipEl.appendChild(btn);
    shadow().appendChild(chipEl);
  }

  // Only asks on sites where an edit was made before, so other pages stay quiet.
  function refreshChip() {
    if (!token() || window.top !== window || !editedHosts().includes(location.host)) return;
    call('GET', '/pending?host=' + encodeURIComponent(location.host))
      .then((data) => showChip(data.count || 0))
      .catch(() => { /* service not running: no chip */ });
  }

  // ---- what was clicked ----
  function textNodeAt(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      return pos && pos.offsetNode;
    }
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    return range && range.startContainer;
  }

  // A selection wins; otherwise the whole run of text under the pointer.
  function targetAt(x, y) {
    const selection = window.getSelection();
    const selected = String(selection || '').trim();
    if (selected && selection.rangeCount) return { text: selected, range: selection.getRangeAt(0).cloneRange() };
    const node = textNodeAt(x, y);
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return { text: node.textContent.trim(), range };
  }

  // Show the new words right away; the real page catches up after the deploy.
  function swapOnPage(range, to) {
    try {
      const node = range.startContainer;
      if (node !== range.endContainer || node.nodeType !== Node.TEXT_NODE) return;
      const full = node.textContent;
      const picked = full.slice(range.startOffset, range.endOffset);
      const lead = picked.length - picked.trimStart().length;
      const trail = picked.length - picked.trimEnd().length;
      node.textContent = full.slice(0, range.startOffset + lead) + to + full.slice(range.endOffset - trail);
    } catch (_) { /* the page changed under us; the deploy will show it */ }
  }

  const aiPrompt = (from, to) => '把網頁上的「' + from + '」改成「' + to + '」。頁面：' + location.href
    + '。直接搜原始碼找不到這段字，它可能是程式拼出來的，或來自資料庫、設定檔。';

  function placeBox(range) {
    const at = range.getBoundingClientRect();
    const width = Math.max(BOX_MIN, Math.min(BOX_MAX, at.width + 24, window.innerWidth - 16));
    boxEl.style.width = width + 'px';
    boxEl.style.left = Math.max(8, Math.min(at.left - 10, window.innerWidth - width - 8)) + 'px';
    const height = boxEl.getBoundingClientRect().height;
    const below = at.bottom + 6;
    boxEl.style.top = (below + height > window.innerHeight - 8 ? Math.max(8, at.top - height - 6) : below) + 'px';
  }

  // ---- the edit box ----
  function openBox({ text, range }) {
    closeBox();
    boxEl = make('div', 'box');
    const input = make('textarea');
    input.value = text;
    const hint = make('div', 'hint', 'Enter 改 · Esc 取消');
    const note = make('div', 'note');
    note.hidden = true;
    const choices = make('div');

    const say = (message) => { note.textContent = message; note.hidden = !message; };
    const busy = (on) => { input.readOnly = on; hint.textContent = on ? '在找這段字…' : 'Enter 改 · Esc 取消'; };

    const onReply = (data, to) => {
      if (data.status === 'done') {
        closeBox();
        swapOnPage(range, to);
        rememberHost();
        showChip(data.pending);
        toast('已改 ' + data.repoName + ' / ' + data.file);
      } else if (data.status === 'choose') {
        say('有 ' + data.matches.length + ' 處一樣的字，要改哪一個？');
        for (const m of data.matches) {
          const btn = make('button', 'choice');
          btn.type = 'button';
          btn.appendChild(make('b', '', m.repoName + ' / ' + m.file + ' : ' + m.line));
          btn.appendChild(document.createTextNode(m.context));
          btn.addEventListener('click', () => send({ repo: m.repo, file: m.file, nth: m.nth }));
          choices.appendChild(btn);
        }
      } else if (data.status === 'toomany') {
        say('有 ' + data.count + ' 處一樣的字。先選取長一點的一段，再 Alt + 點。');
      } else {
        closeBox();
        GM_setClipboard(aiPrompt(text, to));
        toast('原始碼裡找不到這段字，這裡改不了。已複製一句給 AI 的指令，貼給它就能改。', true, LONG_TOAST_MS);
      }
    };

    function send(pick) {
      const to = input.value.trim();
      if (!to || to === text) { say('還沒改任何字'); return; }
      busy(true);
      say('');
      choices.textContent = '';
      call('POST', '/fix', { text, to, url: location.href, pick }, WORK_TIMEOUT_MS)
        .then((data) => { busy(false); onReply(data, to); })
        .catch((err) => { busy(false); say(err.message); });
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                                     // page shortcuts stay out of the box
      if (e.key === 'Escape') closeBox();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });

    boxEl.appendChild(input);
    boxEl.appendChild(hint);
    boxEl.appendChild(note);
    boxEl.appendChild(choices);
    shadow().appendChild(boxEl);
    placeBox(range);
    input.focus();
    input.select();
  }

  // ---- wiring: Alt + click ----
  const isFixClick = (e) => e.altKey && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  const isOurs = (e) => Boolean(root) && e.target === root.host;

  document.addEventListener('click', (e) => {
    if (!isFixClick(e) || isOurs(e)) return;
    e.preventDefault();                                        // Alt + click on a link would download it
    e.stopPropagation();
    if (!token()) {
      toast('還沒連上：先開 ' + endpoint() + '/setup', true, LONG_TOAST_MS);
      return;
    }
    const target = targetAt(e.clientX, e.clientY);
    if (!target) { toast('這裡沒有可以改的字', true); return; }
    openBox(target);
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (isFixClick(e) && !isOurs(e)) e.preventDefault();       // keep an existing selection, do not start a new one
    else if (boxEl && !isOurs(e)) closeBox();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBox(); }, true);

  GM_registerMenuCommand('fastFix：設定服務位置', () => {
    const next = prompt('fastFix 服務的位置', endpoint());
    if (next && /^https?:\/\//i.test(next.trim())) GM_setValue('endpoint', next.trim());
  });
  GM_registerMenuCommand('fastFix：開設定頁', () => { window.open(endpoint() + '/setup', '_blank'); });

  adoptTokenFromSetupPage();
  refreshChip();
})();
