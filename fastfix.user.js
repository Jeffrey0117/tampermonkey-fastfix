// ==UserScript==
// @name         fastFix
// @namespace    fastfix
// @version      1.0.0
// @description  Alt + 點網頁上的字，直接改掉自己網站原始碼裡的那段字。這支只負責去本機服務拿最新的程式來跑，裝一次就好，之後不用再更新。
// @homepageURL  https://github.com/Jeffrey0117/tampermonkey-fastfix
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

// Loader only. The code that does the work is client.js, served by the local
// fastFix service; it is fetched fresh on every page load. Keep this file as it
// is: changing it means everyone has to install again.
(function () {
  'use strict';

  const DEFAULT_ENDPOINT = 'http://127.0.0.1:4480';
  const FETCH_TIMEOUT_MS = 3000;
  const endpoint = String(GM_getValue('endpoint', DEFAULT_ENDPOINT)).replace(/\/+$/, '');

  let started = false;
  function run(code) {
    if (started || !code) return;
    started = true;
    new Function('GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_setClipboard', code)(
      GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_setClipboard);
  }
  // the service is not running: use the copy kept from last time
  const runKept = () => run(String(GM_getValue('code', '')));

  GM_xmlhttpRequest({
    method: 'GET',
    url: endpoint + '/client.js',
    timeout: FETCH_TIMEOUT_MS,
    onload: (res) => {
      if (res.status !== 200 || !res.responseText) return runKept();
      GM_setValue('code', res.responseText);
      run(res.responseText);
    },
    onerror: runKept,
    ontimeout: runKept,
  });
})();
