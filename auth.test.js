"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const start = html.indexOf("<script>\n(function(){");
const end = html.indexOf("})();\n</script>");
assert.ok(start >= 0 && end > start, "main app script not found");
const appJs = html.slice(start + "<script>\n".length, end + "})();".length);

test("main app script parses", function () {
  try { new vm.Script(appJs, { filename: "index.html" }); }
  catch (error) { assert.fail(error.stack || error.message); }
});

function between(fromName, toName) {
  const from = html.indexOf("  function " + fromName + "(");
  const to = html.indexOf("  function " + toName + "(", from + 1);
  assert.ok(from >= 0, "missing " + fromName);
  assert.ok(to > from, "missing " + toName);
  return html.slice(from, to);
}

test("iPhone sign-in uses the Google window and does not start the redirect loop", function () {
  const guard = between("storagePartitionedSignIn", "googleAuthProvider");
  assert.match(guard, /iPhone\|iPad\|iPod/);
  const signIn = between("signIn", "hasContent");
  assert.equal(html.includes("function prefersRedirectSignIn("), false);
  const reserve = between("reserveGoogleWindow", "googleAuthProvider");
  assert.match(reserve, /window\.open\("about:blank"/);
  assert.match(reserve, /popup\.location\.replace\(url\)/);
  const popupAt = signIn.indexOf("auth.signInWithPopup(provider)");
  const reserveAt = signIn.indexOf("reserveGoogleWindow()");
  assert.ok(reserveAt > 0 && popupAt > reserveAt, "the Google window is reserved inside the tap, before Firebase opens it");
  const afterPopup = signIn.slice(popupAt);
  assert.match(afterPopup, /if\(storagePartitionedSignIn\(\)\)\{\s*resetButton\(\);[\s\S]*?return;\s*\}\s*useRedirect\(\)/);
  assert.match(afterPopup, /if\(storagePartitionedSignIn\(\)\)\{ fail\(e\); return; \}/);
  assert.equal(afterPopup.includes("signInWithRedirect"), false);
});

test("a shared page does not redirect iPhone sign-in back through Firebase", function () {
  const shared = fs.readFileSync(path.join(__dirname, "shared.html"), "utf8");
  assert.match(shared, /signInWithPopup/);
  assert.match(shared, /if\(partitioned\) return;/);
});
