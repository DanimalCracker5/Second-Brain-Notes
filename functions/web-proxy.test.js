"use strict";

const assert = require("assert");
const { test } = require("node:test");
const proxy = require("./web-proxy");

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    set: function (key, value) { this.headers[String(key).toLowerCase()] = value; },
    status: function (code) { this.statusCode = code; return this; },
    json: function (payload) { this.body = payload; if (!this.statusCode) this.statusCode = 200; },
    send: function (payload) { this.body = payload; if (!this.statusCode) this.statusCode = 200; }
  };
}

function mockReq(body, extra) {
  extra = extra || {};
  return {
    method: extra.method || "POST",
    path: extra.path || "/page",
    url: extra.path || "/page",
    headers: Object.assign({ origin: "https://secondbrainnotes.com", authorization: "Bearer t" }, extra.headers || {}),
    body: body || {}
  };
}

test("public address checks reject loopback, lan, and metadata ranges", function () {
  assert.equal(proxy.addressIsPublic("8.8.8.8"), true);
  assert.equal(proxy.addressIsPublic("1.1.1.1"), true);
  assert.equal(proxy.addressIsPublic("127.0.0.1"), false);
  assert.equal(proxy.addressIsPublic("10.1.2.3"), false);
  assert.equal(proxy.addressIsPublic("192.168.0.4"), false);
  assert.equal(proxy.addressIsPublic("172.16.5.5"), false);
  assert.equal(proxy.addressIsPublic("169.254.169.254"), false);
  assert.equal(proxy.addressIsPublic("100.64.0.1"), false);
  assert.equal(proxy.addressIsPublic("0.0.0.0"), false);
  assert.equal(proxy.addressIsPublic("::1"), false);
  assert.equal(proxy.addressIsPublic("fe80::1"), false);
  assert.equal(proxy.addressIsPublic("fd00::1"), false);
  assert.equal(proxy.addressIsPublic("::ffff:127.0.0.1"), false);
  assert.equal(proxy.addressIsPublic("2606:4700:4700::1111"), true);
});

test("decimal and hex hosts collapse to the loopback address", function () {
  assert.equal(proxy.canonicalHost("2130706433"), "127.0.0.1");
  assert.equal(proxy.canonicalHost("0x7f000001"), "127.0.0.1");
  assert.equal(proxy.targetFromUrl("http://2130706433/latest").ok, false);
  assert.equal(proxy.targetFromUrl("http://0x7f000001/").code, "PRIVATE_ADDRESS");
});

test("target policy refuses private hosts, odd ports, and non-web schemes", function () {
  ["http://127.0.0.1/", "http://localhost/", "https://metadata.google.internal/", "http://10.0.0.5/", "file:///etc/passwd", "javascript:alert(1)", "https://example.com:8080/", "https://user:pass@example.com/"].forEach(function (raw) {
    const target = proxy.targetFromUrl(raw);
    assert.equal(target.ok, false, raw);
  });
  const ok = proxy.targetFromUrl("https://example.com/a?b=1");
  assert.equal(ok.ok, true);
  assert.equal(ok.href, "https://example.com/a?b=1");
});

test("redirects stay on public web URLs and drop the body on 302", function () {
  const hop = proxy.nextHop("https://example.com/start", 302, "/next", "POST");
  assert.equal(hop.url, "https://example.com/next");
  assert.equal(hop.method, "GET");
  assert.throws(function () {
    proxy.nextHop("https://example.com/start", 302, "http://127.0.0.1/secret", "GET");
  });
  assert.equal(proxy.nextHop("https://example.com/", 200, "/nope", "GET"), null);
});

test("a public address is chosen when DNS also returns a private one", function () {
  const picked = proxy.selectPublicAddress([
    { address: "10.0.0.2", family: 4 },
    { address: "93.184.216.34", family: 4 }
  ]);
  assert.equal(picked.address, "93.184.216.34");
  assert.throws(function () {
    proxy.selectPublicAddress([{ address: "192.168.1.9", family: 4 }]);
  });
});

test("handler refuses a private URL before fetching", async function () {
  let called = false;
  const handler = proxy.createBrowseHandler({
    verifyUser: async function () { return { uid: "user" }; },
    originAllowed: function () { return true; },
    fetchPage: async function () { called = true; throw new Error("fetched"); }
  });
  const res = mockRes();
  await handler(mockReq({ url: "http://127.0.0.1/" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "PRIVATE_ADDRESS");
  assert.equal(called, false);
});

test("handler returns relayed HTML for a signed-in page request", async function () {
  const handler = proxy.createBrowseHandler({
    verifyUser: async function () { return { uid: "html-user" }; },
    originAllowed: function () { return true; },
    fetchPage: async function (url) {
      assert.equal(url, "https://example.com/");
      return {
        url: "https://example.com/final",
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<html><title>Hello</title><p>Hi</p></html>")
      };
    }
  });
  const res = mockRes();
  await handler(mockReq({ url: "https://example.com/" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.kind, "html");
  assert.equal(res.body.url, "https://example.com/final");
  assert.match(res.body.body, /Hello/);
  assert.equal(res.headers["access-control-allow-origin"], "https://secondbrainnotes.com");
});

test("handler rejects signed-out callers and unknown routes", async function () {
  const handler = proxy.createBrowseHandler({
    verifyUser: async function () {
      const err = new Error("Sign in to open this page.");
      err.status = 401;
      err.code = "UNAUTHENTICATED";
      throw err;
    },
    originAllowed: function () { return true; },
    fetchPage: async function () { throw new Error("nope"); }
  });
  const denied = mockRes();
  await handler(mockReq({ url: "https://example.com/" }), denied);
  assert.equal(denied.statusCode, 401);
  const missing = mockRes();
  await handler(mockReq({ url: "https://example.com/" }, { path: "/nope" }), missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
});
