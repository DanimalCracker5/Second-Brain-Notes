/*
  Second Brain — web/browser.js

  A web session is an item the New menu can create. Each session keeps its
  tabs, the address of every tab, and how far the page was scrolled. Closing
  the app writes that into the same local save as every other note, and the
  account syncs it to the owner's other devices.

  Pages open through the signed-in relay when it is reachable, so a site that
  refuses an embedded frame still renders and link clicks update the saved
  address. Site mode loads the real page in a frame when the owner wants the
  original site. Full immersion covers the notes chrome on a phone or a
  computer; that choice stays on the device.
*/
(function (root) {
  "use strict";

  var MAX_TABS = 8;
  var MAX_HISTORY = 25;
  var host = null;
  var active = null;
  var pageCache = [];
  var relayDownUntil = 0;
  var flushBound = false;

  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>';
  var ICON_FORWARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  var ICON_RELOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>';
  var ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>';
  var ICON_IMMERSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></svg>';
  var SITE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-presentation";
  var RELAY_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads allow-modals";
  var IMMERSION_KEY = "sbn-web-immersion-v1";

  function makeId() {
    return host && host.uid ? host.uid() : "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, "&#39;");
  }

  function cleanTitle(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function decodeBasic(text) {
    return cleanTitle(String(text || "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, function (_, n) {
        var code = Number(n);
        return code > 0 && code < 65536 ? String.fromCharCode(code) : _;
      }));
  }

  function extractTitle(html) {
    var match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
    return match ? decodeBasic(match[1]) : "";
  }

  function searchUrl(query) {
    return "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(String(query || "").replace(/\s+/g, " ").trim());
  }

  function normalizeAddress(raw) {
    var text = String(raw || "").replace(/^\s+|\s+$/g, "");
    if (!text) return "";
    if (text.length > 2000) text = text.slice(0, 2000);
    var hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
    if (!hasScheme && /\s/.test(text)) return searchUrl(text);
    if (!hasScheme) text = "https://" + text;
    var url;
    try { url = new URL(text); }
    catch (e) { return hasScheme ? "" : searchUrl(text); }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    if (!url.hostname || url.href.length > 2000) return "";
    return url.href;
  }

  function hostLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, "") || url; }
    catch (e) { return url || "New tab"; }
  }

  function clampScroll(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(200000, Math.round(n));
  }

  function blankTab() {
    return { id: makeId(), url: "", title: "New tab", history: [], index: -1, scrollX: 0, scrollY: 0 };
  }

  function cleanTab(tab) {
    if (!tab || typeof tab !== "object") return null;
    var history = [];
    (Array.isArray(tab.history) ? tab.history : []).forEach(function (entry) {
      var url = normalizeAddress(entry);
      if (url) history.push(url);
    });
    if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
    var index = Number(tab.index);
    if (!isFinite(index)) index = history.length ? history.length - 1 : -1;
    index = Math.max(-1, Math.min(history.length - 1, Math.round(index)));
    var url = normalizeAddress(tab.url) || (index >= 0 ? history[index] : "");
    if (url && (index < 0 || history[index] !== url)) {
      history.push(url);
      if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
      index = history.length - 1;
    }
    if (!url) { index = -1; history = []; }
    return {
      id: typeof tab.id === "string" && tab.id ? tab.id : makeId(),
      url: url,
      title: cleanTitle(tab.title) || (url ? hostLabel(url) : "New tab"),
      history: history,
      index: index,
      scrollX: clampScroll(tab.scrollX),
      scrollY: clampScroll(tab.scrollY)
    };
  }

  function ensureSession(item, idSource) {
    if (!item || typeof item !== "object") return null;
    var previous = makeId;
    if (typeof idSource === "function") makeId = idSource;
    try {
      if (!item.web || typeof item.web !== "object" || Array.isArray(item.web)) item.web = {};
      var web = item.web;
      if (web.view !== "site" && web.view !== "relay") web.view = "relay";
      if (typeof web.titleLocked !== "boolean") web.titleLocked = false;
      var tabs = [];
      (Array.isArray(web.tabs) ? web.tabs : []).forEach(function (tab) {
        var clean = cleanTab(tab);
        if (clean) tabs.push(clean);
      });
      if (!tabs.length) tabs.push(blankTab());
      if (tabs.length > MAX_TABS) tabs = tabs.slice(0, MAX_TABS);
      web.tabs = tabs;
      if (!tabs.some(function (tab) { return tab.id === web.activeId; })) web.activeId = tabs[0].id;
      return web;
    } finally {
      makeId = previous;
    }
  }

  function activeTab(item) {
    var web = item && item.web;
    if (!web || !web.tabs || !web.tabs.length) return null;
    for (var i = 0; i < web.tabs.length; i++) if (web.tabs[i].id === web.activeId) return web.tabs[i];
    return web.tabs[0];
  }

  function visit(tab, raw) {
    var url = normalizeAddress(raw);
    if (!url || !tab) return false;
    if (tab.url === url && tab.index >= 0 && tab.history[tab.index] === url) return false;
    var history = tab.index >= 0 ? tab.history.slice(0, tab.index + 1) : [];
    if (history[history.length - 1] !== url) history.push(url);
    if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
    tab.history = history;
    tab.index = history.length - 1;
    tab.url = url;
    tab.scrollX = 0;
    tab.scrollY = 0;
    tab.title = hostLabel(url);
    return true;
  }

  function replaceCurrent(tab, raw) {
    var url = normalizeAddress(raw);
    if (!url || !tab || tab.url === url) return false;
    tab.url = url;
    if (tab.index >= 0 && tab.history.length) tab.history[tab.index] = url;
    else { tab.history = [url]; tab.index = 0; }
    return true;
  }

  function retreat(tab) {
    if (!tab || tab.index <= 0) return false;
    tab.index -= 1;
    tab.url = tab.history[tab.index];
    tab.scrollX = 0;
    tab.scrollY = 0;
    tab.title = hostLabel(tab.url);
    return true;
  }

  function advance(tab) {
    if (!tab || tab.index < 0 || tab.index >= tab.history.length - 1) return false;
    tab.index += 1;
    tab.url = tab.history[tab.index];
    tab.scrollX = 0;
    tab.scrollY = 0;
    tab.title = hostLabel(tab.url);
    return true;
  }

  function guardSource(token) {
    return [
      "(function(){",
      "var TOKEN=" + JSON.stringify(String(token || "")) + ";",
      "function send(msg){msg.source='sbn-web';msg.token=TOKEN;try{parent.postMessage(msg,'*');}catch(e){}}",
      "function abs(url){try{return new URL(url,document.baseURI).href;}catch(e){return '';}}",
      "function announce(){send({kind:'ready',title:document.title||'',url:document.baseURI});}",
      "if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',announce); else announce();",
      "window.addEventListener('load',announce);",
      "var scrollTimer;",
      "window.addEventListener('scroll',function(){clearTimeout(scrollTimer);scrollTimer=setTimeout(function(){send({kind:'scroll',x:window.scrollX||0,y:window.scrollY||0});},220);},{passive:true});",
      "window.addEventListener('message',function(e){var data=e.data||{};if(!data||data.token!==TOKEN||data.kind!=='restore')return;window.scrollTo(Number(data.x)||0,Number(data.y)||0);});",
      "document.addEventListener('click',function(e){",
      "var node=e.target;if(node&&node.nodeType!==1)node=node.parentElement;",
      "var a=node&&node.closest?node.closest('a[href]'):null;if(!a)return;",
      "var href=a.getAttribute('href')||'';if(!href||href.charAt(0)==='#')return;",
      "if(/^javascript:/i.test(href)){e.preventDefault();return;}",
      "var url=abs(a.href);if(!url)return;",
      "if(/^(mailto|tel):/i.test(url)){e.preventDefault();send({kind:'external',url:url});return;}",
      "if(!/^https?:/i.test(url))return;",
      "try{var next=new URL(url),cur=new URL(document.baseURI);if(next.origin===cur.origin&&next.pathname===cur.pathname&&next.search===cur.search)return;}catch(err){}",
      "e.preventDefault();if(e.stopPropagation)e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();",
      "send({kind:(e.metaKey||e.ctrlKey||a.target==='_blank')?'tab':'navigate',url:url});",
      "},true);",
      "document.addEventListener('submit',function(e){",
      "var form=e.target;if(!form||!form.action)return;",
      "e.preventDefault();if(e.stopPropagation)e.stopPropagation();",
      "var url=abs(form.action);if(!/^https?:/i.test(url))return;",
      "var method=(form.getAttribute('method')||'get').toUpperCase();",
      "if(form.querySelector&&form.querySelector('input[type=file]')){send({kind:'file'});return;}",
      "if(method!=='POST'){try{var params=new URLSearchParams(new FormData(form));var u=new URL(url);params.forEach(function(v,k){u.searchParams.append(k,v);});send({kind:'navigate',url:u.href});}catch(err){send({kind:'navigate',url:url});}return;}",
      "var body='';try{body=new URLSearchParams(new FormData(form)).toString();}catch(err){body='';}",
      "send({kind:'submit',url:url,body:body});",
      "},true);",
      "window.open=function(url){var absUrl=abs(url||'');if(/^https?:/i.test(absUrl))send({kind:'tab',url:absUrl});return null;};",
      "var titleNode=document.querySelector('title');",
      "if(titleNode&&window.MutationObserver){new MutationObserver(function(){send({kind:'title',title:document.title||''});}).observe(titleNode,{childList:true,subtree:true,characterData:true});}",
      "})();"
    ].join("");
  }

  function rewriteDocument(html, pageUrl, token) {
    var source = String(html || "");
    source = source.replace(/<meta\b[^>]*>/gi, function (tag) {
      if (/http-equiv\s*=\s*["']?\s*(content-security-policy|refresh)\b/i.test(tag)) return "";
      return tag;
    });
    source = source.replace(/<base\b[^>]*>/gi, "");
    var inject = "<meta name=\"referrer\" content=\"no-referrer\"><base href=\"" + escapeAttr(pageUrl) + "\"><script>" + guardSource(token) + "</script>";
    if (/<head[^>]*>/i.test(source)) source = source.replace(/<head[^>]*>/i, function (tag) { return tag + inject; });
    else if (/<html[^>]*>/i.test(source)) source = source.replace(/<html[^>]*>/i, function (tag) { return tag + "<head>" + inject + "</head>"; });
    else source = "<!doctype html><html><head>" + inject + "</head><body>" + source + "</body></html>";
    return source;
  }

  function textDocument(text, pageUrl) {
    return "<!doctype html><html><head><meta name=\"referrer\" content=\"no-referrer\"><base href=\"" + escapeAttr(pageUrl) + "\"><title>" + escapeHtml(hostLabel(pageUrl)) + "</title></head><body><pre style=\"white-space:pre-wrap;font:14px/1.45 ui-monospace,monospace\">" + escapeHtml(text) + "</pre></body></html>";
  }

  function externalDocument(pageUrl, contentType) {
    var safe = escapeAttr(pageUrl);
    var kind = String(contentType || "");
    var body = kind.indexOf("image/") === 0
      ? "<img alt=\"\" src=\"" + safe + "\" style=\"max-width:100%;max-height:100vh;display:block;margin:auto\">"
      : "<p style=\"font:16px/1.4 system-ui,sans-serif\"><a href=\"" + safe + "\">Open " + escapeHtml(hostLabel(pageUrl)) + "</a></p>";
    return "<!doctype html><html><head><meta name=\"referrer\" content=\"no-referrer\"><title>" + escapeHtml(hostLabel(pageUrl)) + "</title></head><body style=\"margin:0;background:#111;color:#fff\">" + body + "</body></html>";
  }

  function sessionText(item) {
    var bits = [];
    if (item && item.title) bits.push(item.title);
    var tabs = item && item.web && item.web.tabs || [];
    tabs.forEach(function (tab) {
      if (!tab) return;
      if (tab.title) bits.push(tab.title);
      if (tab.url) bits.push(tab.url);
    });
    return bits.join("\n");
  }

  function sessionMeta(item) {
    var tab = activeTab(item);
    if (!tab || !tab.url) return "No page yet";
    return hostLabel(tab.url);
  }

  function sessionHasContent(item) {
    var tabs = item && item.web && item.web.tabs || [];
    return tabs.some(function (tab) { return tab && tab.url; });
  }

  function newWebItem() {
    var item = host.baseItem();
    item.type = "web";
    item.title = "Web session";
    ensureSession(item, host.uid);
    return item;
  }

  function relayBase() {
    var cfg = root.ASTRAL_CONFIG || {};
    var web = cfg.web || {};
    return String(web.baseUrl || "").replace(/\/+$/, "");
  }

  function cacheGet(url) {
    for (var i = 0; i < pageCache.length; i++) if (pageCache[i].url === url) return pageCache[i];
    return null;
  }

  function cachePut(url, html, title) {
    pageCache = pageCache.filter(function (entry) { return entry.url !== url; });
    pageCache.unshift({ url: url, html: html, title: title || "" });
    if (pageCache.length > 6) pageCache.length = 6;
  }

  function immersionMap() {
    try {
      var parsed = JSON.parse(root.localStorage.getItem(IMMERSION_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) { return {}; }
  }

  function immersionOn(id) {
    return !!immersionMap()[id];
  }

  function setImmersion(id, on) {
    try {
      var map = immersionMap();
      if (on) map[id] = 1;
      else delete map[id];
      root.localStorage.setItem(IMMERSION_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function toast(message, bad) {
    if (host && host.showToast) host.showToast(message, !!bad);
  }

  function commit(item, opts) {
    if (!host || !active || active.quiet) return;
    opts = opts || {};
    host.touchItem(item);
    if (opts.list && host.renderList) host.renderList();
    if (opts.immediate) {
      if (active.timer) { clearTimeout(active.timer); active.timer = null; }
      host.persist();
      return;
    }
    if (active.timer) return;
    active.timer = setTimeout(function () {
      if (!active) return;
      active.timer = null;
      host.persist();
    }, 700);
  }

  function flushPending() {
    if (!active || !active.timer || !host) return;
    clearTimeout(active.timer);
    active.timer = null;
    host.persist();
  }

  function bindFlush() {
    if (flushBound || !root.addEventListener) return;
    flushBound = true;
    root.addEventListener("pagehide", flushPending);
    root.addEventListener("beforeunload", flushPending);
  }

  function setLoading(on) {
    if (!active) return;
    active.root.classList.toggle("is-loading", !!on);
    if (on) active.progress.style.width = "0";
  }

  function showNote(message) {
    if (!active) return;
    if (!message) { active.note.hidden = true; active.noteText.textContent = ""; return; }
    if (active.noteDismissed) return;
    active.note.hidden = false;
    active.noteText.textContent = message;
  }

  function showStart(on) {
    if (active) active.start.hidden = !on;
  }

  function showFallback(message) {
    if (!active) return;
    active.fallbackText.textContent = message || "This page did not open.";
    active.fallback.hidden = false;
    showStart(false);
    setLoading(false);
  }

  function hideFallback() {
    if (active) active.fallback.hidden = true;
  }

  function currentTab() {
    return active ? activeTab(active.item) : null;
  }

  function paintChrome() {
    if (!active) return;
    var item = active.item;
    var web = item.web;
    var tab = currentTab();
    if (document.activeElement !== active.nameInput) active.nameInput.value = item.title || "";
    if (tab && document.activeElement !== active.address) active.address.value = tab.url || "";
    active.back.disabled = !tab || tab.index <= 0;
    active.forward.disabled = !tab || tab.index < 0 || tab.index >= tab.history.length - 1;
    var mode = active.mode || (web.view === "site" ? "site" : "relay");
    active.siteBtn.classList.toggle("on", mode === "site");
    active.relayBtn.classList.toggle("on", mode === "relay");
    active.immerse.classList.toggle("on", active.root.classList.contains("is-immersive"));
    active.immerseLabel.textContent = active.root.classList.contains("is-immersive") ? "Exit" : "Immerse";
    active.tabRow.textContent = "";
    web.tabs.forEach(function (entry) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "wb-tab" + (entry.id === web.activeId ? " on" : "");
      button.title = entry.url || entry.title || "New tab";
      var label = document.createElement("span");
      label.textContent = entry.title || hostLabel(entry.url) || "New tab";
      button.appendChild(label);
      var close = document.createElement("span");
      close.className = "wb-tab-x";
      close.textContent = "×";
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "Close tab");
      close.onclick = function (event) {
        event.stopPropagation();
        closeTab(entry.id);
      };
      button.appendChild(close);
      button.onclick = function () { selectTab(entry.id); };
      active.tabRow.appendChild(button);
    });
    var add = document.createElement("button");
    add.type = "button";
    add.className = "wb-tab-add";
    add.textContent = "+";
    add.title = "New tab";
    add.setAttribute("aria-label", "New tab");
    add.onclick = function () { addTab(""); };
    active.tabRow.appendChild(add);
  }

  function maybeTitle(item, tab, title) {
    var next = cleanTitle(title);
    if (!next) return false;
    var changed = tab.title !== next;
    tab.title = next;
    if (!item.web.titleLocked && item.title !== next) {
      item.title = next;
      item.web.autoTitle = next;
      changed = true;
    }
    if (changed) {
      paintChrome();
      commit(item, { immediate: false, list: true });
    }
    return changed;
  }

  function restoreScroll(tab) {
    if (!active || active.mode !== "relay" || !tab) return;
    active.ignoreScrollUntil = Date.now() + 900;
    try {
      active.iframe.contentWindow.postMessage({
        source: "sbn-web",
        kind: "restore",
        token: active.token,
        x: tab.scrollX || 0,
        y: tab.scrollY || 0
      }, "*");
    } catch (e) {}
  }

  function paintRelay(html, token) {
    active.mode = "relay";
    active.token = token;
    active.iframe.setAttribute("sandbox", RELAY_SANDBOX);
    active.iframe.srcdoc = html;
    paintChrome();
  }

  function loadSite(item, tab, url, gen) {
    if (!active || gen !== active.gen) return;
    active.mode = "site";
    active.token = "";
    showStart(false);
    hideFallback();
    active.iframe.setAttribute("sandbox", SITE_SANDBOX);
    active.iframe.onload = function () {
      if (!active || gen !== active.gen) return;
      setLoading(false);
    };
    active.iframe.src = url;
    active.iframe.removeAttribute("srcdoc");
    paintChrome();
    maybeTitle(item, tab, "");
  }

  function relayErrorMessage(err) {
    var code = err && err.code || "";
    if (code === "UNAUTHENTICATED" || code === "AUTH" || (err && err.status === 401)) return "Sign in to open pages through the relay. This one is shown directly, and the address is saved on this device.";
    if (code === "NOT_FOUND" || code === "NO_RELAY" || (err && (err.status === 404 || err.down))) return "The web relay is not available right now, so this page is shown directly.";
    return "This page is shown directly because the relay could not open it.";
  }

  function fetchRelay(url, opts) {
    opts = opts || {};
    var base = relayBase();
    if (!base) {
      var missing = new Error("Web relay is not configured.");
      missing.code = "NO_RELAY";
      missing.down = true;
      return Promise.reject(missing);
    }
    if (!host || typeof host.getIdToken !== "function") {
      var signedOut = new Error("Sign in to use the web relay.");
      signedOut.code = "AUTH";
      return Promise.reject(signedOut);
    }
    var ctrl = typeof root.AbortController === "function" ? new root.AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    return host.getIdToken().then(function (token) {
      if (!token) {
        var err = new Error("Sign in to use the web relay.");
        err.code = "AUTH";
        throw err;
      }
      return root.fetch(base + "/page", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url,
          method: opts.method || "GET",
          body: opts.body || "",
          contentType: opts.contentType || ""
        }),
        signal: ctrl ? ctrl.signal : undefined
      });
    }).then(function (response) {
      return response.text().then(function (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!response.ok) {
          var err = new Error((data && data.error) || "That page could not be opened.");
          err.code = data && data.code || "RELAY";
          err.status = response.status;
          if (response.status === 404 || response.status === 405) err.down = true;
          throw err;
        }
        if (!data || !data.url) {
          var bad = new Error("The relay returned an empty page.");
          bad.down = true;
          throw bad;
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") {
        var timeout = new Error("The relay took too long.");
        timeout.code = "TIMEOUT";
        throw timeout;
      }
      if (err && !err.status && !err.code) {
        err.down = true;
        err.code = err.code || "NO_RELAY";
      }
      throw err;
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function load(item, tab, opts) {
    if (!active || !tab) return;
    opts = opts || {};
    var url = tab.url;
    if (!url) {
      active.loadedUrl = "";
      active.mode = item.web.view === "site" ? "site" : "relay";
      setLoading(false);
      hideFallback();
      showNote("");
      showStart(true);
      try {
        active.iframe.src = "about:blank";
        active.iframe.removeAttribute("srcdoc");
      } catch (e) {}
      paintChrome();
      return;
    }
    var gen = ++active.gen;
    active.loadedUrl = url;
    showStart(false);
    hideFallback();
    setLoading(true);
    var wantRelay = item.web.view !== "site" && (opts.forceRelay || Date.now() >= relayDownUntil);
    if (!wantRelay) {
      if (item.web.view !== "site" && !opts.quietNote) showNote("The web relay is not available right now, so this page is shown directly.");
      loadSite(item, tab, url, gen);
      return;
    }
    showNote("");
    if (!opts.reload) {
      var cached = cacheGet(url);
      if (cached && !opts.method) {
        var cachedToken = "c" + gen.toString(36);
        paintRelay(rewriteDocument(cached.html, url, cachedToken), cachedToken);
        setLoading(false);
        maybeTitle(item, tab, cached.title);
        return;
      }
    }
    fetchRelay(url, opts).then(function (data) {
      if (!active || gen !== active.gen) return;
      relayDownUntil = 0;
      var finalUrl = normalizeAddress(data.url) || url;
      if (replaceCurrent(tab, finalUrl)) commit(item, { immediate: true, list: true });
      var token = "t" + gen.toString(36) + Math.random().toString(36).slice(2, 8);
      var html = "";
      var title = "";
      if (data.kind === "text") html = textDocument(data.body || "", finalUrl);
      else if (data.kind === "external") html = externalDocument(finalUrl, data.contentType);
      else {
        html = data.body || "";
        title = extractTitle(html);
        html = rewriteDocument(html, finalUrl, token);
        if (!opts.method) cachePut(finalUrl, data.body || "", title);
      }
      active.loadedUrl = finalUrl;
      paintRelay(html, token);
      setLoading(false);
      if (title) maybeTitle(item, tab, title);
      else maybeTitle(item, tab, hostLabel(finalUrl));
    }).catch(function (err) {
      if (!active || gen !== active.gen) return;
      if (err && err.down) relayDownUntil = Date.now() + 5 * 60 * 1000;
      showNote(relayErrorMessage(err));
      loadSite(item, tab, tab.url || url, gen);
    });
  }

  function adoptProvisionalTitle(item, tab) {
    if (!item || !tab || item.web.titleLocked) return;
    var next = tab.title || (tab.url ? hostLabel(tab.url) : "");
    if (!next || item.title === next) return;
    item.title = next;
    item.web.autoTitle = next;
  }

  function navigate(raw, opts) {
    if (!active) return;
    opts = opts || {};
    var tab = currentTab();
    if (!tab) return;
    var url = normalizeAddress(raw);
    if (!url) {
      toast("Enter an address or a search", true);
      return;
    }
    var changed = visit(tab, url);
    if (!changed && !opts.reload) opts.reload = true;
    if (changed) {
      adoptProvisionalTitle(active.item, tab);
      commit(active.item, { immediate: true, list: true });
    }
    load(active.item, tab, opts);
    paintChrome();
  }

  function selectTab(id) {
    if (!active || active.item.web.activeId === id) return;
    active.item.web.activeId = id;
    commit(active.item, { immediate: true, list: false });
    load(active.item, currentTab(), {});
    paintChrome();
    var tab = currentTab();
    if (tab && !tab.url) setTimeout(function () { if (active) active.address.focus(); }, 0);
  }

  function addTab(url) {
    if (!active) return;
    var web = active.item.web;
    if (web.tabs.length >= MAX_TABS) {
      toast("This session already has " + MAX_TABS + " tabs", true);
      return;
    }
    var tab = blankTab();
    web.tabs.push(tab);
    web.activeId = tab.id;
    if (url) {
      visit(tab, url);
      adoptProvisionalTitle(active.item, tab);
    }
    commit(active.item, { immediate: true, list: true });
    load(active.item, tab, {});
    paintChrome();
    if (!tab.url) setTimeout(function () { if (active) active.address.focus(); }, 0);
  }

  function closeTab(id) {
    if (!active) return;
    var web = active.item.web;
    var index = -1;
    web.tabs.forEach(function (tab, i) { if (tab.id === id) index = i; });
    if (index < 0) return;
    var closingActive = web.activeId === id;
    if (web.tabs.length === 1) {
      var fresh = blankTab();
      web.tabs = [fresh];
      web.activeId = fresh.id;
    } else {
      web.tabs.splice(index, 1);
      if (closingActive) web.activeId = web.tabs[Math.max(0, index - 1)].id;
    }
    commit(active.item, { immediate: true, list: true });
    if (closingActive || web.tabs.length === 1) load(active.item, currentTab(), {});
    paintChrome();
  }

  function goBack() {
    var tab = currentTab();
    if (!tab || !retreat(tab)) return;
    adoptProvisionalTitle(active.item, tab);
    commit(active.item, { immediate: true, list: true });
    load(active.item, tab, {});
    paintChrome();
  }

  function goForward() {
    var tab = currentTab();
    if (!tab || !advance(tab)) return;
    adoptProvisionalTitle(active.item, tab);
    commit(active.item, { immediate: true, list: true });
    load(active.item, tab, {});
    paintChrome();
  }

  function setView(view) {
    if (!active) return;
    active.item.web.view = view === "site" ? "site" : "relay";
    if (view === "relay") relayDownUntil = 0;
    commit(active.item, { immediate: true, list: false });
    var tab = currentTab();
    if (tab && tab.url) load(active.item, tab, { reload: true, forceRelay: view === "relay", quietNote: true });
    else paintChrome();
  }

  function enterImmersion() {
    if (!active) return;
    active.root.classList.add("is-immersive");
    document.body.classList.add("wb-immersive");
    setImmersion(active.item.id, true);
    paintChrome();
    var node = active.root;
    if (node.requestFullscreen) {
      node.requestFullscreen().then(function () { if (active) active.usingFullscreen = true; }).catch(function () { if (active) active.usingFullscreen = false; });
    }
  }

  function leaveImmersion() {
    if (!active) return;
    var node = active.root;
    active.usingFullscreen = false;
    node.classList.remove("is-immersive", "is-chrome");
    document.body.classList.remove("wb-immersive");
    setImmersion(active.item.id, false);
    paintChrome();
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }

  function toggleImmersion() {
    if (!active) return;
    if (active.root.classList.contains("is-immersive")) leaveImmersion();
    else enterImmersion();
  }

  function showImmersiveChrome() {
    if (!active || !active.root.classList.contains("is-immersive")) return;
    active.root.classList.add("is-chrome");
    if (active.chromeTimer) clearTimeout(active.chromeTimer);
    active.chromeTimer = setTimeout(function () {
      if (active && active.root) active.root.classList.remove("is-chrome");
    }, 2400);
  }

  function onMessage(event) {
    if (!active || active.mode !== "relay") return;
    var data = event.data;
    if (!data || data.source !== "sbn-web" || data.token !== active.token) return;
    var fromFrame = event.source === active.iframe.contentWindow;
    if (!fromFrame && event.origin !== "null") return;
    var item = active.item;
    var tab = currentTab();
    if (!tab) return;
    if (data.kind === "ready") {
      maybeTitle(item, tab, data.title);
      restoreScroll(tab);
      return;
    }
    if (data.kind === "title") {
      maybeTitle(item, tab, data.title);
      return;
    }
    if (data.kind === "scroll") {
      if (Date.now() < (active.ignoreScrollUntil || 0)) return;
      var x = clampScroll(data.x);
      var y = clampScroll(data.y);
      if (Math.abs(x - tab.scrollX) < 24 && Math.abs(y - tab.scrollY) < 24) return;
      tab.scrollX = x;
      tab.scrollY = y;
      commit(item, { immediate: false, list: false });
      return;
    }
    if (data.kind === "navigate" && data.url) {
      navigate(data.url);
      return;
    }
    if (data.kind === "tab" && data.url) {
      addTab(data.url);
      return;
    }
    if (data.kind === "external" && data.url) {
      root.open(data.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (data.kind === "file") {
      toast("File uploads open on the real site", true);
      setView("site");
      return;
    }
    if (data.kind === "submit" && data.url) {
      if (String(data.body || "").length > 100000) {
        toast("That form is too large for the relay", true);
        return;
      }
      visit(tab, data.url);
      commit(item, { immediate: true, list: true });
      load(item, tab, { reload: true, method: "POST", body: String(data.body || ""), contentType: "application/x-www-form-urlencoded" });
    }
  }

  function onKey(event) {
    if (!active || !document.body.classList.contains("wb-open")) return;
    if (event.key === "Escape" && active.root.classList.contains("is-immersive")) {
      event.preventDefault();
      event.stopPropagation();
      leaveImmersion();
      return;
    }
    var typing = document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA" || document.activeElement.isContentEditable);
    if (typing && !active.root.contains(document.activeElement)) return;
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "l") {
      event.preventDefault();
      active.address.focus();
      active.address.select();
    }
  }

  function onFullscreen() {
    if (!active || !active.usingFullscreen) return;
    if (!document.fullscreenElement) leaveImmersion();
  }

  function tearDown() {
    flushPending();
    if (active && active.chromeTimer) clearTimeout(active.chromeTimer);
    document.body.classList.remove("wb-open", "wb-immersive");
    if (active && active.root && document.fullscreenElement === active.root) {
      active.usingFullscreen = false;
      document.exitFullscreen().catch(function () {});
    }
    root.removeEventListener("message", onMessage);
    root.removeEventListener("keydown", onKey, true);
    document.removeEventListener("fullscreenchange", onFullscreen);
    active = null;
  }

  function build(item) {
    tearDown();
    ensureSession(item, host.uid);
    bindFlush();
    var rootEl = document.createElement("section");
    rootEl.className = "wb";
    rootEl.setAttribute("data-item-editor", item.id);
    var chrome = document.createElement("div");
    chrome.className = "wb-chrome";
    var name = document.createElement("input");
    name.className = "wb-name";
    name.setAttribute("aria-label", "Session name");
    name.placeholder = "Web session";
    name.spellcheck = false;
    var tabs = document.createElement("div");
    tabs.className = "wb-tabs";
    var toolbar = document.createElement("div");
    toolbar.className = "wb-toolbar";
    function iconButton(svg, label) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "wb-icon";
      button.innerHTML = svg;
      button.title = label;
      button.setAttribute("aria-label", label);
      return button;
    }
    var back = iconButton(ICON_BACK, "Back");
    var forward = iconButton(ICON_FORWARD, "Forward");
    var reload = iconButton(ICON_RELOAD, "Reload");
    var address = document.createElement("input");
    address.className = "wb-address";
    address.type = "text";
    address.inputMode = "url";
    address.autocomplete = "off";
    address.autocapitalize = "off";
    address.spellcheck = false;
    address.placeholder = "Search or enter an address";
    address.setAttribute("aria-label", "Address");
    var view = document.createElement("div");
    view.className = "wb-view";
    view.setAttribute("role", "group");
    view.setAttribute("aria-label", "How this page opens");
    function viewButton(id, label, title) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.onclick = function () { setView(id); };
      view.appendChild(button);
      return button;
    }
    var siteBtn = viewButton("site", "Site", "Open the real website");
    var relayBtn = viewButton("relay", "Relay", "Open inside the app and remember each page");
    var immerse = document.createElement("button");
    immerse.type = "button";
    immerse.className = "wb-textbtn";
    immerse.title = "Full immersion";
    immerse.setAttribute("aria-label", "Full immersion");
    immerse.innerHTML = ICON_IMMERSE;
    var immerseLabel = document.createElement("span");
    immerseLabel.textContent = "Immerse";
    immerse.appendChild(immerseLabel);
    toolbar.appendChild(back);
    toolbar.appendChild(forward);
    toolbar.appendChild(reload);
    toolbar.appendChild(address);
    toolbar.appendChild(view);
    toolbar.appendChild(immerse);
    var note = document.createElement("div");
    note.className = "wb-note";
    note.hidden = true;
    var noteText = document.createElement("span");
    var noteDismiss = document.createElement("button");
    noteDismiss.type = "button";
    noteDismiss.textContent = "Dismiss";
    noteDismiss.onclick = function () { note.hidden = true; if (active) active.noteDismissed = true; };
    note.appendChild(noteText);
    note.appendChild(noteDismiss);
    chrome.appendChild(name);
    chrome.appendChild(tabs);
    chrome.appendChild(toolbar);
    chrome.appendChild(note);
    var stage = document.createElement("div");
    stage.className = "wb-stage";
    var progress = document.createElement("div");
    progress.className = "wb-progress";
    var frame = document.createElement("iframe");
    frame.className = "wb-frame";
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("sandbox", RELAY_SANDBOX);
    frame.title = "Web session";
    var start = document.createElement("div");
    start.className = "wb-start";
    start.innerHTML = "<div><h2>New web session</h2><p>Type an address or a search. The page is still here after you close the app. Immerse fills the phone or the computer, and the session syncs between them.</p></div>";
    var fallback = document.createElement("div");
    fallback.className = "wb-fallback";
    fallback.hidden = true;
    var fallbackCopy = document.createElement("div");
    var fallbackTitle = document.createElement("h2");
    fallbackTitle.textContent = "Page unavailable";
    var fallbackText = document.createElement("p");
    var actions = document.createElement("div");
    actions.className = "wb-fallback-actions";
    function action(label, primary, fn) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (primary) button.className = "primary";
      button.onclick = fn;
      actions.appendChild(button);
      return button;
    }
    action("Try again", true, function () {
      var tab = currentTab();
      if (tab) load(item, tab, { reload: true, forceRelay: item.web.view !== "site" });
    });
    action("Open outside", false, function () {
      var tab = currentTab();
      if (tab && tab.url) root.open(tab.url, "_blank", "noopener,noreferrer");
    });
    fallbackCopy.appendChild(fallbackTitle);
    fallbackCopy.appendChild(fallbackText);
    fallbackCopy.appendChild(actions);
    fallback.appendChild(fallbackCopy);
    var exit = document.createElement("button");
    exit.type = "button";
    exit.className = "wb-exit";
    exit.textContent = "Exit immersion";
    stage.appendChild(progress);
    stage.appendChild(frame);
    stage.appendChild(start);
    stage.appendChild(fallback);
    stage.appendChild(exit);
    rootEl.appendChild(chrome);
    rootEl.appendChild(stage);

    active = {
      item: item,
      root: rootEl,
      iframe: frame,
      address: address,
      nameInput: name,
      tabRow: tabs,
      note: note,
      noteText: noteText,
      start: start,
      fallback: fallback,
      fallbackText: fallbackText,
      progress: progress,
      back: back,
      forward: forward,
      siteBtn: siteBtn,
      relayBtn: relayBtn,
      immerse: immerse,
      immerseLabel: immerseLabel,
      gen: 0,
      token: "",
      loadedUrl: "",
      mode: "",
      timer: null,
      quiet: false,
      ignoreScrollUntil: 0,
      usingFullscreen: false,
      chromeTimer: null
    };

    name.addEventListener("input", function () {
      item.title = name.value;
      item.web.titleLocked = true;
      commit(item, { immediate: false, list: true });
    });
    address.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        navigate(address.value, {});
        address.blur();
      } else if (event.key === "Escape") address.blur();
    });
    address.addEventListener("focus", function () {
      address.select();
    });
    back.onclick = goBack;
    forward.onclick = goForward;
    reload.onclick = function () {
      var tab = currentTab();
      if (!tab || !tab.url) return;
      load(item, tab, { reload: true, forceRelay: item.web.view !== "site" && Date.now() >= relayDownUntil });
    };
    immerse.onclick = toggleImmersion;
    exit.onclick = leaveImmersion;
    rootEl.addEventListener("pointerdown", function (event) {
      if (!rootEl.classList.contains("is-immersive")) return;
      var bounds = rootEl.getBoundingClientRect();
      if (event.clientY - bounds.top < 48) showImmersiveChrome();
    });
    chrome.addEventListener("pointerenter", function () {
      if (active && active.chromeTimer) clearTimeout(active.chromeTimer);
    });
    chrome.addEventListener("pointerleave", showImmersiveChrome);

    document.body.classList.add("wb-open");
    root.addEventListener("message", onMessage);
    root.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFullscreen);
    if (immersionOn(item.id)) {
      rootEl.classList.add("is-immersive");
      document.body.classList.add("wb-immersive");
    }
    paintChrome();
    load(item, currentTab(), {});
    var opened = currentTab();
    if (opened && !opened.url) {
      setTimeout(function () {
        if (active && active.item === item && document.body.contains(address)) address.focus();
      }, 40);
    }
    return rootEl;
  }

  function refresh(item) {
    if (!active || !item || active.item.id !== item.id) return;
    ensureSession(item, host.uid);
    active.item = item;
    var tab = currentTab();
    paintChrome();
    if (!tab) return;
    if ((tab.url || "") !== (active.loadedUrl || "")) load(item, tab, { quietNote: true });
    else if (active.mode === "relay") restoreScroll(tab);
  }

  var ns = root.SecondBrainWeb = root.SecondBrainWeb || {};
  ns.install = function (bridge) {
    host = bridge;
    return [{
      type: "web",
      label: "Web",
      menuLabel: "Web",
      manageLabel: "Web session",
      manageHint: "A browser that keeps the page when you close the app, immerses on phone or desktop, and syncs between them.",
      defaultEnabled: true,
      icon: ICON_GLOBE,
      placeholder: "Web session",
      hideCopy: true,
      create: newWebItem,
      normalize: function (item) { ensureSession(item, host && host.uid); },
      text: sessionText,
      meta: sessionMeta,
      hasContent: sessionHasContent,
      build: build,
      refresh: refresh,
      detach: tearDown,
      reset: tearDown
    }];
  };
  ns.normalizeAddress = normalizeAddress;
  ns.ensureSession = ensureSession;
  ns.visit = visit;
  ns.retreat = retreat;
  ns.advance = advance;
  ns.replaceCurrent = replaceCurrent;
  ns.rewriteDocument = rewriteDocument;
  ns.extractTitle = extractTitle;
  ns.guardSource = guardSource;
  ns.activeTab = activeTab;

  if (typeof module === "object" && module.exports) module.exports = ns;
})(typeof window !== "undefined" ? window : globalThis);
