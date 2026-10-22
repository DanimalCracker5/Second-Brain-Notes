"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { test } = require("node:test");
const web = require("./browser");

function freshItem() {
  let n = 0;
  const item = { type: "web", title: "Web session" };
  web.ensureSession(item, function () { n += 1; return "tab-" + n; });
  return item;
}

test("addresses become web URLs and searches stay searches", function () {
  assert.equal(web.normalizeAddress("example.com"), "https://example.com/");
  assert.equal(web.normalizeAddress("https://example.com/a"), "https://example.com/a");
  assert.equal(web.normalizeAddress("javascript:alert(1)"), "");
  assert.equal(web.normalizeAddress("file:///etc/passwd"), "");
  assert.equal(web.normalizeAddress("data:text/html,hi"), "");
  assert.match(web.normalizeAddress("city generation"), /^https:\/\/html\.duckduckgo\.com\/html\/\?q=city%20generation$/);
  assert.equal(web.normalizeAddress("   "), "");
  assert.equal(web.normalizeAddress("https://user:pass@example.com/x"), "https://example.com/x");
});

test("a session survives a bad save and a second normalize", function () {
  let n = 0;
  const item = { type: "web", title: "Web session", web: { view: "nope", tabs: [{ url: "https://example.com/keep", title: "Keep" }] } };
  web.ensureSession(item, function () { n += 1; return "made-" + n; });
  const tab = web.activeTab(item);
  assert.equal(tab.url, "https://example.com/keep");
  assert.equal(item.web.view, "relay");
  assert.equal(tab.history[tab.index], tab.url);
  const snapshot = JSON.stringify(item.web);
  web.ensureSession(item, function () { throw new Error("new id"); });
  assert.equal(JSON.stringify(item.web), snapshot);
});

test("back and forward keep the page you were on and drop abandoned forwards", function () {
  const item = freshItem();
  const tab = web.activeTab(item);
  assert.equal(web.visit(tab, "example.com"), true);
  assert.equal(web.visit(tab, "https://example.com/a"), true);
  assert.equal(web.visit(tab, "https://example.com/b"), true);
  assert.equal(web.visit(tab, "https://example.com/b"), false);
  assert.equal(web.retreat(tab), true);
  assert.equal(tab.url, "https://example.com/a");
  assert.equal(web.advance(tab), true);
  assert.equal(tab.url, "https://example.com/b");
  assert.equal(web.retreat(tab), true);
  assert.equal(web.visit(tab, "https://example.com/c"), true);
  assert.deepEqual(tab.history, ["https://example.com/", "https://example.com/a", "https://example.com/c"]);
  assert.equal(tab.url, tab.history[tab.index]);
});

test("history stays bounded and a redirect replaces the current entry", function () {
  const item = freshItem();
  const tab = web.activeTab(item);
  for (let i = 0; i < 40; i++) web.visit(tab, "https://example.com/p" + i);
  assert.equal(tab.history.length, 25);
  assert.equal(tab.url, "https://example.com/p39");
  assert.equal(tab.index, tab.history.length - 1);
  assert.equal(web.replaceCurrent(tab, "https://example.com/final"), true);
  assert.equal(tab.history[tab.index], "https://example.com/final");
  assert.equal(tab.history.length, 25);
});

test("relayed documents keep a base URL and lose frame-blocking tags", function () {
  const html = web.rewriteDocument(
    "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"><meta http-equiv=\"refresh\" content=\"0;url=https://evil.test\"><base href=\"https://evil.test/\"></head><body><title>Cat</title></body></html>",
    "https://example.com/?q=\"1\"",
    "tok123"
  );
  assert.equal(html.indexOf("Content-Security-Policy"), -1);
  assert.equal(html.indexOf("http-equiv=\"refresh\""), -1);
  assert.equal(html.indexOf("https://evil.test/"), -1);
  assert.ok(html.indexOf("tok123") >= 0);
  assert.ok(html.indexOf("https://example.com/?q=&quot;1&quot;") >= 0);
  assert.equal(web.guardSource("tok123").indexOf("</script>"), -1);
  assert.equal(web.extractTitle("<html><title>Cat &amp; Dog</title></html>"), "Cat & Dog");
});

test("the notes app registers web sessions and syncs them live", function () {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(index, /web\/browser\.js/);
  assert.match(index, /web\/browser\.css/);
  assert.match(index, /SecondBrainWeb\.install\(moduleHost\(\)\)/);
  assert.match(index, /getIdToken:function\(\)/);
  assert.match(index, /item\.type==="note"\|\|item\.type==="script"\|\|item\.type==="web"/);
  const config = fs.readFileSync(path.join(__dirname, "..", "astral.config.js"), "utf8");
  assert.match(config, /cloudfunctions\.net\/browse/);
});
