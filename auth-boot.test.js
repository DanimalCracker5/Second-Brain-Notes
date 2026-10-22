"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const bootSource = fs.readFileSync(path.join(__dirname, "auth-boot.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function freshBoot() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Number,
    String,
    isFinite,
    queueMicrotask: (fn) => Promise.resolve().then(fn)
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const store = {};
  sandbox.localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; }
  };
  vm.runInNewContext(bootSource, sandbox, { filename: "auth-boot.js" });
  return sandbox;
}

function resolverOnPrototype() {
  const proto = {};
  Object.defineProperty(proto, "_shouldInitProactively", {
    configurable: false,
    get() { return true; }
  });
  return Object.create(proto);
}

function firebaseDouble(resolver) {
  const auth = {
    _delegate: { _popupRedirectResolver: resolver },
    onAuthStateChanged(fn) { auth.listener = fn; }
  };
  let sawAfterYield;
  const firebase = {
    apps: [],
    initializeApp() { firebase.apps.push({}); },
    auth() {
      Promise.resolve().then(() => { sawAfterYield = resolver._shouldInitProactively; });
      return auth;
    }
  };
  return {
    firebase,
    auth,
    afterYield: () => sawAfterYield
  };
}

const config = { firebase: { apiKey: "k", authDomain: "app.firebaseapp.com", projectId: "p" } };

test("session records need a uid and refresh token", function () {
  const boot = freshBoot();
  const session = boot.sbAuthBoot.sessionFromRecord({
    fbase_key: "firebase:authUser:k:[DEFAULT]",
    value: { uid: "abc", stsTokenManager: { refreshToken: "r", expirationTime: 1_700_000_000_000 } }
  });
  assert.deepEqual(session, { uid: "abc", expirationTime: 1_700_000_000_000 });
  assert.equal(boot.sbAuthBoot.sessionFromRecord({ value: { uid: "abc" } }), null);
  assert.equal(boot.sbAuthBoot.sessionFromRecord({ uid: "abc", stsTokenManager: { refreshToken: "" } }), null);
  const seconds = boot.sbAuthBoot.sessionFromRecord({
    uid: "abc",
    stsTokenManager: { refreshToken: "r", expirationTime: 1_700_000_000 }
  });
  assert.equal(seconds.expirationTime, 1_700_000_000_000);
});

test("a saved session disables the proactive iframe before auth yields", async function () {
  const boot = freshBoot();
  const resolver = resolverOnPrototype();
  const double = firebaseDouble(resolver);
  boot.firebase = double.firebase;
  boot.ASTRAL_CONFIG = config;
  boot.__sbCachedSession = { uid: "abc", expirationTime: Date.now() + 60_000 };
  boot.sbAuthBoot.bootAuth();
  assert.equal(resolver._shouldInitProactively, false);
  assert.equal(Object.getPrototypeOf(resolver)._shouldInitProactively, true);
  assert.equal(boot.__sbAuthBooted, true);
  await Promise.resolve();
  assert.equal(double.afterYield(), false);
});

test("a confirmed signed-out visit still allows the iframe preload", async function () {
  const boot = freshBoot();
  const resolver = resolverOnPrototype();
  const double = firebaseDouble(resolver);
  boot.firebase = double.firebase;
  boot.ASTRAL_CONFIG = config;
  boot.__sbSessionProbeDone = true;
  boot.__sbCachedSession = null;
  boot.sbAuthBoot.bootAuth();
  assert.equal(resolver._shouldInitProactively, true);
  await Promise.resolve();
  assert.equal(double.afterYield(), true);
});

test("auth waits for the session probe, then skips the iframe when a user is stored", async function () {
  const boot = freshBoot();
  const resolver = resolverOnPrototype();
  const double = firebaseDouble(resolver);
  boot.firebase = double.firebase;
  boot.ASTRAL_CONFIG = config;
  let ready = false;
  boot.sbAuthBoot.whenAuthReady(function () { ready = true; });
  assert.equal(double.firebase.apps.length, 0);
  assert.equal(ready, false);
  boot.__sbCachedSession = { uid: "abc", expirationTime: Date.now() + 60_000 };
  boot.__sbSessionProbeDone = true;
  boot.__sbBootFastAuth();
  assert.equal(ready, true);
  assert.equal(resolver._shouldInitProactively, false);
  await Promise.resolve();
  assert.equal(double.afterYield(), false);
});

test("the page boots auth before Firestore and paints the edge loader for a returning session", function () {
  assert.match(html, /<html lang="en" class="auth-restoring">/);
  const boot = html.indexOf('src="./auth-boot.js');
  const authSdk = html.indexOf("firebase-auth-compat.js");
  const bootCall = html.indexOf("sbAuthBoot.bootAuth()");
  const firestore = html.indexOf("firebase-firestore-compat.js");
  assert.ok(boot >= 0 && boot < authSdk, "session probe starts before the auth SDK");
  assert.ok(authSdk < bootCall && bootCall < firestore, "auth starts before Firestore downloads");
  assert.match(html, /class="auth-frame"/);
  assert.match(html, /auth-edge-spin second/);
  assert.match(html, /rel="preconnect" href="https:\/\/identitytoolkit\.googleapis\.com"/);
  assert.match(html, /rel="preconnect" href="https:\/\/securetoken\.googleapis\.com"/);
  assert.equal(html.includes('setAuthGate(true,"Signing you in…")'), false);
  assert.match(html, /whenAuthReady\(begin\)/);
  assert.match(html, /disarmProactiveAuthIframe\(auth\)/);
  assert.match(html, /__sbRestoreFade/);
});
