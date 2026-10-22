/*
  Starts Firebase Auth before the rest of the app, and skips the mobile
  iframe that otherwise blocks a saved session.

  On iPhone (and mobile Safari) the compat SDK opens an auth iframe and waits
  for it — up to 30s for the gapi script, then another 5–15s for the iframe —
  before onAuthStateChanged reports the user already stored on this device.
  That wait is the "Checking your secure session…" hang. The iframe is only
  needed to preload popup sign-in. signInWithPopup still passes its own
  resolver when someone actually taps the button, so a returning session can
  skip it.

  A saved session shows the edge loader (html.auth-restoring). No session
  shows the sign-in card. The check is synchronous when this device has signed
  in before (localStorage hint) and falls back to Firebase's IndexedDB record.
*/
(function (global) {
  "use strict";
  var HINT_KEY = "sb-known-session";
  var DB_NAME = "firebaseLocalStorageDb";
  var STORE_NAME = "firebaseLocalStorage";

  function readHint() {
    try { return global.localStorage.getItem(HINT_KEY) === "1"; }
    catch (e) { return false; }
  }

  function rememberHint(on) {
    try {
      if (on) global.localStorage.setItem(HINT_KEY, "1");
      else global.localStorage.removeItem(HINT_KEY);
    } catch (e) {}
  }

  function sessionFromRecord(row) {
    var value = row && typeof row === "object" ? (row.value && typeof row.value === "object" ? row.value : row) : null;
    if (!value || typeof value.uid !== "string" || !value.uid) return null;
    var token = value.stsTokenManager;
    if (!token || !token.refreshToken) return null;
    var exp = Number(token.expirationTime);
    if (!isFinite(exp) || exp < 0) exp = 0;
    if (exp && exp < 1e12) exp = exp * 1000;
    return { uid: value.uid, expirationTime: exp || 0 };
  }

  function rootElement() {
    return global.document && global.document.documentElement;
  }

  function setRestoring(on) {
    var root = rootElement();
    if (!root || !root.classList) return;
    if (on) root.classList.add("auth-restoring");
    else root.classList.remove("auth-restoring");
  }

  function paintGateStatus(text) {
    global.__sbGateStatus = text;
    var status = global.document && global.document.getElementById && global.document.getElementById("authGateStatus");
    if (status) status.textContent = text;
  }

  function hasSavedSession() {
    var cached = global.__sbCachedSession;
    if (cached && cached.uid) return true;
    var root = rootElement();
    return !!(root && root.classList && root.classList.contains("auth-restoring"));
  }

  /* Skip the iframe when a saved session is already known, and also while the
     IndexedDB probe is still out — preloading before we know would put a
     returning user back on the slow path. Once the probe confirms there is no
     session, the iframe may load so the sign-in button is ready. */
  function shouldDisarm() {
    if (hasSavedSession()) return true;
    return !global.__sbSessionProbeDone;
  }

  function disarmProactiveAuthIframe(authInstance) {
    try {
      var delegate = authInstance && (authInstance._delegate || authInstance);
      var resolver = delegate && delegate._popupRedirectResolver;
      if (!resolver || resolver.__sbNoProactive) return;
      Object.defineProperty(resolver, "_shouldInitProactively", {
        configurable: true,
        get: function () { return false; }
      });
      resolver.__sbNoProactive = true;
    } catch (e) {}
  }

  function notifyWaiters() {
    var after = global.__sbAfterAuthBoot;
    global.__sbAfterAuthBoot = null;
    if (typeof after === "function") after();
  }

  function finishProbe(session, confident) {
    if (global.__sbSessionProbeDone) return;
    global.__sbSessionProbeDone = true;
    if (session && session.uid) {
      global.__sbCachedSession = { uid: session.uid, expirationTime: session.expirationTime || 0 };
      rememberHint(true);
      setRestoring(true);
      paintGateStatus("Signing you in");
    } else if (confident) {
      global.__sbCachedSession = null;
      rememberHint(false);
      setRestoring(false);
      paintGateStatus("");
    }
    if (typeof global.__sbBootFastAuth === "function") {
      var start = global.__sbBootFastAuth;
      global.__sbBootFastAuth = null;
      start();
    }
  }

  function considerRows(rows) {
    var best = null;
    (rows || []).forEach(function (row) {
      var session = sessionFromRecord(row);
      if (!session) return;
      if (!best || session.expirationTime > best.expirationTime) best = session;
    });
    finishProbe(best, true);
  }

  function openAndRead() {
    var req;
    try { req = global.indexedDB.open(DB_NAME); }
    catch (e) { finishProbe(null, false); return; }
    req.onupgradeneeded = function (event) {
      try { event.target.transaction.abort(); } catch (e) {}
      finishProbe(null, true);
    };
    req.onerror = function () { finishProbe(null, false); };
    req.onsuccess = function () {
      var db = req.result;
      try {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.close();
          finishProbe(null, true);
          return;
        }
        var tx = db.transaction(STORE_NAME, "readonly");
        var store = tx.objectStore(STORE_NAME);
        if (store.getAll) {
          var all = store.getAll();
          all.onsuccess = function () { db.close(); considerRows(all.result || []); };
          all.onerror = function () { db.close(); finishProbe(null, false); };
          return;
        }
        var rows = [];
        var cursor = store.openCursor();
        cursor.onsuccess = function () {
          var current = cursor.result;
          if (current) { rows.push(current.value); current.continue(); }
          else { db.close(); considerRows(rows); }
        };
        cursor.onerror = function () { db.close(); finishProbe(null, false); };
      } catch (e) {
        try { db.close(); } catch (err) {}
        finishProbe(null, false);
      }
    };
  }

  function probeSession() {
    if (global.__sbSessionProbeStarted) return;
    global.__sbSessionProbeStarted = true;
    if (!global.indexedDB) { finishProbe(null, false); return; }
    if (typeof global.indexedDB.databases === "function") {
      try {
        global.indexedDB.databases().then(function (list) {
          var exists = (list || []).some(function (db) { return db && db.name === DB_NAME; });
          if (!exists) finishProbe(null, true);
          else openAndRead();
        }).catch(function () { openAndRead(); });
        return;
      } catch (e) {}
    }
    openAndRead();
  }

  function usableConfig() {
    var cfg = global.ASTRAL_CONFIG;
    if (cfg && cfg.firebase) cfg = cfg.firebase;
    if (!cfg || !cfg.apiKey || !cfg.projectId || !cfg.authDomain) return null;
    if (/PASTE_|YOUR_PROJECT_ID/.test(cfg.apiKey + " " + cfg.projectId + " " + cfg.authDomain)) return null;
    return cfg;
  }

  function bootAuth() {
    if (global.__sbAuthBooted) return;
    if (global.__sbAuthBootFailed) { notifyWaiters(); return; }
    var cfg = usableConfig();
    if (!cfg || !global.firebase || typeof global.firebase.initializeApp !== "function" || typeof global.firebase.auth !== "function") {
      global.__sbAuthBootFailed = true;
      notifyWaiters();
      return;
    }

    function start() {
      if (global.__sbAuthBooted || global.__sbAuthBootFailed) return;
      global.__sbAuthBooted = true;
      try {
        if (!global.firebase.apps || !global.firebase.apps.length) global.firebase.initializeApp(cfg);
        var auth = global.firebase.auth();
        /* Same turn as auth(): the iframe check happens after IndexedDB yields. */
        if (shouldDisarm()) disarmProactiveAuthIframe(auth);
        auth.onAuthStateChanged(function (user) {
          global.__sbEarlyAuthReady = true;
          global.__sbEarlyUser = user || null;
          if (!user) {
            rememberHint(false);
            global.__sbCachedSession = null;
            setRestoring(false);
            paintGateStatus("");
            return;
          }
          rememberHint(true);
          var body = global.document && global.document.body;
          if (!body || (body.classList && body.classList.contains("auth-locked"))) {
            setRestoring(true);
            paintGateStatus("Signing you in");
          }
        });
      } catch (e) {
        global.__sbAuthBooted = false;
        global.__sbAuthBootFailed = true;
        try { console.warn("Auth restore could not start:", e); } catch (err) {}
      }
      notifyWaiters();
    }

    /* A known session starts immediately. Otherwise wait until the probe
       reports, so a saved user is not sent through the iframe. */
    if (hasSavedSession() || global.__sbSessionProbeDone) start();
    else if (!global.__sbAuthStartScheduled) {
      global.__sbAuthStartScheduled = true;
      global.__sbBootFastAuth = start;
      global.setTimeout(start, 1500);
    }
  }

  function whenAuthReady(fn) {
    if (global.__sbAuthBooted || global.__sbAuthBootFailed) { fn(); return; }
    var prev = global.__sbAfterAuthBoot;
    global.__sbAfterAuthBoot = function () {
      if (typeof prev === "function") prev();
      fn();
    };
    bootAuth();
  }

  global.sbAuthBoot = {
    sessionFromRecord: sessionFromRecord,
    disarmProactiveAuthIframe: disarmProactiveAuthIframe,
    rememberHint: rememberHint,
    readHint: readHint,
    bootAuth: bootAuth,
    whenAuthReady: whenAuthReady,
    shouldDisarm: shouldDisarm
  };

  if (rootElement()) {
    if (!readHint()) setRestoring(false);
    probeSession();
    if (!readHint()) {
      global.setTimeout(function () {
        if (!global.__sbSessionProbeDone && !(global.__sbCachedSession && global.__sbCachedSession.uid)) setRestoring(false);
      }, 800);
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
