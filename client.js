// fastFix: everything the page side does. The installed userscript (fastfix.user.js)
// fetches this file from the local service on every page load and runs it, so a
// change here is live on the next reload with nothing to reinstall.
// GM_* come in from the loader.
(function () {
  'use strict';

  const DEFAULT_ENDPOINT = 'http://127.0.0.1:4480';
  const QUICK_TIMEOUT_MS = 8000;
  const WORK_TIMEOUT_MS = 100000;        // a push can be slow
  const TOAST_MS = 2600;
  const LONG_TOAST_MS = 9000;
  const BOX_MIN = 320;
  const BOX_MAX = 520;
  const NEAR_CHARS = 60;
  const SIZES = [12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72, 96, 128];
  const HINT = 'Enter 送出 · Esc 取消';
  const WATCH_EVERY_MS = 5000;           // how often the site is looked at after a send
  const GIVE_UP_S = 300;
  const DEEP_EVERY = 4;                  // every so many looks, the page's scripts are read too
  const SCRIPT_CAP = 40;
  const RELOAD_AFTER_MS = 1200;

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
    .box .tools { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
    .box .tools button { min-width: 34px; height: 30px; padding: 0 8px; border: 1px solid #E0D7CA; border-radius: 8px; background: #fff;
                         color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
    .box .tools button:hover { background: #FCF1DD; }
    .box .tools .gap { width: 8px; }
    .box .tools .push { flex: 1; }
    .box .tools button, .box .tools input { flex: 0 0 auto; white-space: nowrap; }
    .box .tools button.go { padding: 0 16px; border-color: #E09A2E; background: #E09A2E; color: #fff; font-weight: 700; }
    .box .tools button.go:hover { background: #C98622; }
    .box .tools input { width: 34px; height: 30px; padding: 2px; border: 1px solid #E0D7CA; border-radius: 8px; background: #fff; cursor: pointer; }
    .box .hint { margin-top: 6px; font-size: 11px; color: #A49A8E; }
    .box .note { margin-top: 8px; font-size: 13px; color: #B4412F; }
    .box .choice { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; border: 1px solid #EBE4DA; border-radius: 10px;
                   background: #fff; color: inherit; font: 12px/1.5 Consolas, 'Noto Sans TC', monospace; text-align: left; cursor: pointer;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .box .choice:hover { background: #FCF1DD; }
    .box .choice b { display: block; font: 700 12px/1.5 'Noto Sans TC', system-ui, sans-serif; color: #A49A8E; }
    .toast { z-index: 2147483647; right: 18px; bottom: 66px; max-width: 340px; padding: 10px 14px; background: #1F1B16; color: #fff;
             border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.25); word-break: break-all; }
    .toast.bad { background: #B4412F; }
    .chip { z-index: 2147483646; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px;
            background: #1F1B16; color: #fff; border-radius: 999px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
    .chip { max-width: calc(100vw - 36px); box-sizing: border-box; }
    .chip span { padding-right: 6px; }
    .chip.busy { padding-bottom: 13px; overflow: hidden; }
    .chip .bar { position: absolute; left: 14px; right: 14px; bottom: 6px; height: 3px; border-radius: 3px; background: rgba(255,255,255,.18); overflow: hidden; }
    .chip .bar::after { content: ''; position: absolute; top: 0; bottom: 0; width: 38%; border-radius: 3px; background: #E09A2E; animation: slide 1.3s ease-in-out infinite; }
    @keyframes slide { from { left: -40%; } to { left: 100%; } }
    .chip button + button { background: #4A433B; }
    .chip button { padding: 6px 14px; border: 0; border-radius: 999px; background: #E09A2E; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .chip button:disabled { opacity: .55; cursor: default; }
  `;

  let root = null;
  let boxEl = null;
  let chipEl = null;
  let undoPreview = null;                // puts the element back if the box closes without saving
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

  function toast(message, bad, ms, onClick) {
    const r = shadow();
    const old = r.querySelector('.toast');
    if (old) old.remove();
    const el = make('div', bad ? 'toast bad' : 'toast', message);
    if (onClick) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', onClick);
    }
    r.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), ms || TOAST_MS);
  }

  function closeBox() {
    if (!boxEl) return;
    boxEl.remove();
    boxEl = null;
    if (undoPreview) undoPreview();
    undoPreview = null;
  }

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

  function setChip(text, buttons, busy) {
    if (chipEl) { chipEl.remove(); chipEl = null; }
    if (!text) return;
    chipEl = make('div', busy ? 'chip busy' : 'chip');
    if (busy) chipEl.appendChild(make('i', 'bar'));
    chipEl.appendChild(make('span', '', text));
    for (const [label, onClick] of buttons || []) {
      const btn = make('button', '', label);
      btn.type = 'button';
      btn.addEventListener('click', () => onClick(btn));
      chipEl.appendChild(btn);
    }
    shadow().appendChild(chipEl);
  }

  // ---- after a send: is the site really showing the new words yet? ----
  // The site is read the way the person's browser reads it: the page, and the
  // scripts it loads when the words are not in the page itself.
  const squash = (text) => text.replace(/\s+/g, ' ');
  const sameOrigin = (url) => { try { return new URL(url).origin === location.origin; } catch (_) { return false; } };
  const absolute = (ref, base) => { try { return new URL(ref, base).href; } catch (_) { return ''; } };
  const getText = (url, cache) => fetch(url, { cache, credentials: 'same-origin' })
    .then((res) => (res.ok ? res.text() : ''))
    .catch(() => '');

  // The same words as a build may have written them: plain, HTML-escaped, or \uXXXX.
  function spellings(words) {
    const html = words.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
    const unicode = words.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    return [...new Set([words, html, unicode, unicode.replace(/\\u[0-9a-f]{4}/g, (u) => '\\u' + u.slice(2).toUpperCase())])];
  }
  const has = (squashed, words) => spellings(squash(words)).some((w) => squashed.includes(w));

  async function scriptTexts(html, pageUrl) {
    const refs = (text, base, pattern) => Array.from(text.matchAll(pattern), (m) => absolute(m[1], base));
    const tidy = (urls, skip) => [...new Set(urls)].filter((u) => u && sameOrigin(u) && !skip.includes(u)).slice(0, SCRIPT_CAP);
    const first = tidy(refs(html, pageUrl, /<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+\.m?js[^"']*)["']/gi), []);
    const firstTexts = await Promise.all(first.map((u) => getText(u, 'no-cache')));
    const named = /["'`]((?:\.{0,2}\/)?[\w@.\/-]+\.m?js)["'`]/g;       // chunks a script loads later
    const second = tidy(firstTexts.flatMap((text, i) => [...refs(text, first[i], named), ...refs(text, location.origin + '/', named)]), first);
    const secondTexts = await Promise.all(second.map((u) => getText(u, 'no-cache')));
    return [...firstTexts, ...secondTexts].map(squash);
  }

  // One page, all the spots changed on it. Each spot is looked up where it was
  // changed (its path), so the same words elsewhere on the page do not count.
  //   yes      the spot shows the change
  //   no       the spot is there and still shows the old thing
  //   unknown  the spot cannot be found in what the server sends (drawn by scripts, or the page moved)
  const lastHtml = {};
  const spotIn = (doc, path) => { try { return doc && path ? doc.querySelector(path) : null; } catch (_) { return null; } };
  function sameLook(el, look) {
    const probe = document.createElement('span');
    return Object.keys(look).every((k) => { probe.style[k] = look[k]; return el.style[k] && el.style[k] === probe.style[k]; });
  }
  function spotSays(doc, check) {
    const el = spotIn(doc, check.path);
    if (!el) return 'unknown';
    const text = squash(el.textContent);
    if (check.look) {
      if (!check.text || !text.includes(squash(check.text))) return 'unknown';
      return sameLook(el, check.look) ? 'yes' : 'no';
    }
    if (text.includes(squash(check.to))) return 'yes';
    return check.from && text.includes(squash(check.from)) ? 'no' : 'unknown';
  }

  async function pageShows(page, checks, round) {
    let url = page;
    try { const u = new URL(page); url = location.origin + u.pathname + u.search; } catch (_) { /* keep as is */ }
    const html = await getText(url, 'no-store');
    let doc = null;
    try { doc = html ? new DOMParser().parseFromString(html, 'text/html') : null; } catch (_) { /* judged by the words alone */ }
    const said = checks.map((c) => spotSays(doc, c));
    // words whose spot could not be found: anywhere in the page or its scripts will do
    const loose = checks.filter((c, i) => said[i] === 'unknown' && !c.look).map((c) => c.to);
    const squashed = squash(html);
    let missing = loose.filter((w) => !has(squashed, w));
    if (missing.length && html && (html !== lastHtml[url] || round % DEEP_EVERY === 0)) {
      const scripts = await scriptTexts(html, url);
      missing = missing.filter((w) => !scripts.some((text) => has(text, w)));
    }
    lastHtml[url] = html;
    const looksUnknown = checks.filter((c, i) => said[i] === 'unknown' && c.look).length;
    if (said.includes('no') || missing.length) return 'waiting';
    return looksUnknown === checks.length ? 'cant' : 'live';
  }

  // 'live' when every page shows its changes, 'cant' when there is nothing that can be checked.
  function allLive(checks, round) {
    const pages = [...new Set(checks.map((c) => c.page))];
    return Promise.all(pages.map((page) => pageShows(page, checks.filter((c) => c.page === page), round)))
      .then((results) => (results.includes('waiting') ? 'waiting' : (results.every((r) => r === 'cant') ? 'cant' : 'live')));
  }

  // After a reload in the middle of a wait the page is the old one again: put the
  // changes that are on their way back on it, with their outline.
  let restored = false;
  function restore(checks) {
    if (restored) return;
    restored = true;
    const here = location.origin + location.pathname + location.search;
    for (const c of checks) {
      const el = c.page === here ? spotIn(document, c.path) : null;
      if (!el) continue;
      try {
        if (c.look) {
          if (!c.text || !squash(el.textContent).includes(squash(c.text))) continue;
          Object.assign(el.style, c.look);
        } else if (!el.textContent.includes(c.to)) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node && !node.textContent.includes(c.from)) node = walker.nextNode();
          if (!node || !c.from) continue;
          node.textContent = node.textContent.replace(c.from, () => c.to);
        }
        markChanged(el);
      } catch (_) { /* the page changed under us */ }
    }
  }

  // ---- the chip, bottom right: what is not sent yet, and how far the last send got ----
  let watching = 0;                      // changes whenever the chip is redrawn, so an old wait stops
  let watchTimer = 0;

  function settle(result) {
    watching += 1;
    clearTimeout(watchTimer);
    setChip('');
    call('POST', '/landed', { url: location.href, result }).catch(() => { /* asked again on the next page load */ });
  }

  function land() {
    call('POST', '/landed', { url: location.href, result: 'live' }).catch(() => { /* asked again on the next page load */ });
    setChip('已上線 ✓ 重新整理中…');
    // always reloads by itself; only holds off while something is being typed in the box
    const reload = () => (boxEl ? setTimeout(reload, 500) : location.reload());
    setTimeout(reload, RELOAD_AFTER_MS);
  }

  function watch(delivery, round, mine) {
    if (mine !== watching) return;
    const waited = Math.max(0, Math.round((Date.now() - Date.parse(delivery.at)) / 1000));
    const cantTell = () => setChip('已送出 ✓ 這次改的地方沒辦法自動確認，等一下重新整理看看', [['好', () => settle('dismissed')]]);
    if (!delivery.checks.length) { cantTell(); return; }
    restore(delivery.checks);
    if (waited > GIVE_UP_S) {
      setChip('已送出，但等了 ' + Math.round(waited / 60) + ' 分鐘網站還是舊的', [
        ['再看一次', () => showState({ count: 0, delivery: { ...delivery, at: new Date().toISOString() } })],
        ['不等了', () => settle('dismissed')],
      ]);
      return;
    }
    if (round === 0) setChip('已送出，等網站更新', [], true);
    allLive(delivery.checks, round).then((live) => {
      if (mine !== watching) return;
      if (live === 'live') land();
      else if (live === 'cant') cantTell();
      else watchTimer = setTimeout(() => watch(delivery, round + 1, mine), WATCH_EVERY_MS);
    });
  }

  function submitNow() {
    watching += 1;
    clearTimeout(watchTimer);
    setChip('送出中', [], true);
    call('POST', '/submit', { url: location.href }, WORK_TIMEOUT_MS)
      .then((data) => showState({ count: 0, delivery: data.delivery }))
      .catch((err) => {
        toast(err.message, true, LONG_TOAST_MS);
        refreshChip();
      });
  }

  function showState({ count, delivery }) {
    watching += 1;
    clearTimeout(watchTimer);
    if (count) { setChip('已改 ' + count + ' 處，還沒送出', [['送出', submitNow]]); return; }
    if (!delivery) { setChip(''); return; }
    if (delivery.status === 'failed') {
      setChip('已送出，但' + delivery.error, [['再叫一次', submitNow], ['關掉', () => settle('dismissed')]]);
      return;
    }
    watch(delivery, 0, watching);
  }

  // Only asks on sites where an edit was made before, so other pages stay quiet.
  function refreshChip() {
    if (!token() || window.top !== window || !editedHosts().includes(location.host)) return;
    call('GET', '/pending?host=' + encodeURIComponent(location.host))
      .then((data) => showState({ count: data.count || 0, delivery: data.delivery }))
      .catch(() => { /* service not running: no chip */ });
  }

  // ---- what was clicked ----
  // Where the element is on this page: unique here, and good until the page's layout changes.
  function pathOf(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (!n.parentElement) return '';
      parts.unshift(n.localName + ':nth-child(' + (Array.prototype.indexOf.call(n.parentElement.children, n) + 1) + ')');
    }
    return parts.length ? 'body > ' + parts.join(' > ') : '';
  }

  function textNodeAt(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      return pos && pos.offsetNode;
    }
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    return range && range.startContainer;
  }

  // The words just before and after the clicked text, as the page shows them.
  // They tell two identical sentences in the same project apart.
  function surroundings(range) {
    try {
      const node = range.commonAncestorContainer;
      const block = node.nodeType === Node.TEXT_NODE ? (node.parentElement.parentElement || node.parentElement) : node;
      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange();
      after.selectNodeContents(block);
      after.setStart(range.endContainer, range.endOffset);
      return { before: String(before).slice(-NEAR_CHARS), after: String(after).slice(0, NEAR_CHARS) };
    } catch (_) {
      return { before: '', after: '' };
    }
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

  // The new words and look show at once, so there is nothing to sit and wait for.
  // The dashed outline says "changed, not live yet"; it goes away with the reload
  // that happens once the site really serves the change.
  function swapOnPage(range, to) {
    try {
      const node = range.startContainer;
      if (node !== range.endContainer || node.nodeType !== Node.TEXT_NODE) return;
      const full = node.textContent;
      const picked = full.slice(range.startOffset, range.endOffset);
      const lead = picked.length - picked.trimStart().length;
      const trail = picked.length - picked.trimEnd().length;
      node.textContent = full.slice(0, range.startOffset + lead) + to + full.slice(range.endOffset - trail);
    } catch (_) { /* the page changed under us; the reload will show it */ }
  }

  function markChanged(el) {
    try {
      el.style.outline = '2px dashed #E09A2E';
      el.style.outlineOffset = '3px';
      el.title = '已改，還沒上線。上線後這一頁會自己重新整理';
    } catch (_) { /* the page changed under us */ }
  }

  const lookWords = (look) => [
    look.fontSize && '字大小 ' + look.fontSize,
    look.fontWeight && '粗細 ' + look.fontWeight,
    look.color && '顏色 ' + look.color,
  ].filter(Boolean).join('、');

  const aiPrompt = (from, to, look) => '網頁上的「' + from + '」這段字'
    + (to ? '，改成「' + to + '」' : '')
    + (lookWords(look) ? '，樣式改成 ' + lookWords(look) : '')
    + '。頁面：' + location.href + '。直接搜原始碼找不到這段字，它可能是程式拼出來的，或來自資料庫、設定檔。';

  function rgbToHex(rgb) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    return m ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#000000';
  }

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
    const tools = make('div', 'tools');
    const hint = make('div', 'hint', HINT);
    const note = make('div', 'note');
    note.hidden = true;
    const choices = make('div');
    const near = surroundings(range);

    const say = (message) => { note.textContent = message; note.hidden = !message; };
    const busy = (on) => { input.readOnly = on; hint.textContent = on ? '在找這段字…' : HINT; };

    // How the words look: size, weight, colour. Shown on the page at once,
    // written to the source together with the words on Enter.
    const holder = range.commonAncestorContainer;
    const el = holder.nodeType === Node.TEXT_NODE ? holder.parentElement : holder;
    const shown = getComputedStyle(el);
    const original = { fontSize: el.style.fontSize, fontWeight: el.style.fontWeight, color: el.style.color };
    let look = {};
    let lookSaved = false;
    let keepPreview = false;
    undoPreview = () => { if (!keepPreview) Object.assign(el.style, original); };

    const preview = (change) => {
      look = { ...look, ...change };
      lookSaved = false;
      Object.assign(el.style, change);
      placeBox(range);
    };
    const stepSize = (dir) => {
      const now = Math.round(parseFloat(look.fontSize || shown.fontSize));
      const next = dir > 0 ? SIZES.find((s) => s > now) : [...SIZES].reverse().find((s) => s < now);
      if (next) preview({ fontSize: next + 'px' });
    };
    const stepWeight = (dir) => {
      const now = Math.round(Number(look.fontWeight || shown.fontWeight) / 100) * 100;
      const next = Math.max(100, Math.min(900, now + dir * 100));
      if (next !== now) preview({ fontWeight: String(next) });
    };
    const tool = (label, title, onClick) => {
      const btn = make('button', '', label);
      btn.type = 'button';
      btn.title = title;
      btn.addEventListener('mousedown', (e) => e.preventDefault());   // keep the caret in the text box
      btn.addEventListener('click', onClick);
      tools.appendChild(btn);
    };
    tool('A−', '字小一點', () => stepSize(-1));
    tool('A+', '字大一點', () => stepSize(1));
    tools.appendChild(make('span', 'gap'));
    tool('細', '細一點', () => stepWeight(-1));
    tool('粗', '粗一點', () => stepWeight(1));
    tools.appendChild(make('span', 'gap'));
    const colour = make('input');
    colour.type = 'color';
    colour.title = '字的顏色';
    colour.value = rgbToHex(shown.color);
    colour.addEventListener('input', () => preview({ color: colour.value }));
    tools.appendChild(colour);
    tools.appendChild(make('span', 'push'));
    tool('送出', '改完直接送出', () => send());
    tools.lastChild.className = 'go';

    const finish = (data, to) => {
      keepPreview = true;
      closeBox();
      if (to) swapOnPage(range, to);
      markChanged(el);
      rememberHost();
      showState({ count: data.pending });
      submitNow();                                             // one step: changing it is sending it
    };

    // Any answer other than "done": say why, or ask which place.
    const onStopped = (data, to) => {
      if (data.status === 'cant') {
        say(data.reason);
      } else if (data.status === 'choose') {
        say(data.repoName + ' 裡有 ' + data.matches.length + ' 處一樣的字，改哪一個？');
        for (const m of data.matches) {
          const btn = make('button', 'choice');
          btn.type = 'button';
          btn.title = m.context;
          btn.appendChild(make('b', '', m.file + ' 第 ' + m.line + ' 行'));
          btn.appendChild(document.createTextNode(m.context));
          btn.addEventListener('click', () => send({ file: m.file, nth: m.nth }));
          choices.appendChild(btn);
        }
      } else if (data.status === 'toomany') {
        say('有 ' + data.count + ' 處一樣的字。先選取長一點的一段，再 Alt + 點。');
      } else if (data.status === 'stale') {
        closeBox();
        toast('這段字已經改過了（「' + data.from + '」→「' + data.to + '」），這一頁顯示的還是舊的。重新整理看看；還是舊的就是還沒部署完。', true, LONG_TOAST_MS);
      } else if (data.status === 'unset') {
        closeBox();
        toast('這個網站還沒設定專案。點這裡去設定頁加一行。', true, LONG_TOAST_MS,
          () => window.open(endpoint() + '/setup?host=' + encodeURIComponent(location.host), '_blank'));
      } else {
        closeBox();
        GM_setClipboard(aiPrompt(text, to, look));
        toast(data.repoName + ' 裡找不到這段字，這裡改不了。已複製一句給 AI 的指令，貼給它就能改。', true, LONG_TOAST_MS);
      }
    };

    // The look goes first: it is found by the old words, which the second step replaces.
    function send(pick) {
      const typed = input.value.trim();
      const to = typed && typed !== text ? typed : '';
      const lookChanged = Object.keys(look).length > 0 && !lookSaved;
      if (!to && !lookChanged) { say('還沒改任何東西'); return; }
      const where = { text, url: location.href, path: pathOf(el), pick, ...near };
      const steps = [
        lookChanged && (() => call('POST', '/style', { ...where, look }, WORK_TIMEOUT_MS).then((data) => {
          if (data.status === 'done') lookSaved = true;
          return data;
        })),
        to && (() => call('POST', '/fix', { ...where, to }, WORK_TIMEOUT_MS)),
      ].filter(Boolean);
      const run = (i, last) => (i === steps.length
        ? finish(last, to)
        : steps[i]().then((data) => (data.status === 'done' ? run(i + 1, data) : onStopped(data, to))));
      busy(true);
      say('');
      choices.textContent = '';
      Promise.resolve().then(() => run(0, null))
        .then(() => busy(false))
        .catch((err) => { busy(false); say(err.message); });
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                                     // page shortcuts stay out of the box
      if (e.key === 'Escape') closeBox();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });

    boxEl.appendChild(input);
    boxEl.appendChild(tools);
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
