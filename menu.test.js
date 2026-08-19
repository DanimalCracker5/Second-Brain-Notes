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

function grab(name, next) {
  const from = html.indexOf("  function " + name + "(");
  assert.ok(from >= 0, "missing " + name);
  const to = next ? html.indexOf("  function " + next + "(", from + 1) : html.length;
  assert.ok(to > from, "missing end of " + name);
  return html.slice(from, to).trim();
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(grab("menuFit", "menuScrollBody"), sandbox, { filename: "menuFit" });

test("menuFit clamps a tall menu to the space below a top-of-screen button", function () {
  const fit = sandbox.menuFit({ top: 80, bottom: 120, left: 16, width: 36 }, 900, 390, 700, 240);
  assert.equal(fit.flipped, false);
  assert.ok(fit.maxH <= 700 - 120 - 6 - 10, "max height must fit under the button");
  assert.ok(fit.maxH >= 120);
  assert.ok(fit.top + fit.height <= 700 - 10, "bottom edge stays on-screen");
  assert.ok(fit.left >= 10);
});

test("menuFit flips above when the button is near the bottom", function () {
  const fit = sandbox.menuFit({ top: 620, bottom: 660, left: 16, width: 36 }, 400, 390, 700, 240);
  assert.equal(fit.flipped, true);
  assert.ok(fit.top >= 10);
  assert.ok(fit.top + fit.height <= 620 - 6, "flipped menu stays above the button");
  assert.ok(fit.maxH < 400 || fit.height <= fit.maxH);
});

test("menuFit never reports a viewport taller than the phone itself", function () {
  const fit = sandbox.menuFit({ top: 300, bottom: 340, left: 8, width: 36 }, 2000, 390, 667, 240);
  assert.ok(fit.maxH <= 667 - 20);
  assert.ok(fit.height <= fit.maxH);
});

test("floating menus scroll inside an inner pane", function () {
  const cssStart = html.indexOf("/* ---------- floating menu ---------- */");
  const css = html.slice(cssStart, html.indexOf("/* ---------- due-date calendar ---------- */"));
  assert.match(css, /\.menu-body\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.menu\{[^}]*max-height:/);
  assert.match(grab("openMenu", "mkItem"), /wrapMenuBody\(m\)/);
});

test("note pencil menu nests AI handoff and backups behind submenus", function () {
  const src = grab("showItemActions", "convertNoteTodo");
  assert.match(src, /view==="ai"/);
  assert.match(src, /view==="backup"/);
  assert.match(src, /Bring into AI/);
  assert.match(src, /Document backup/);
  assert.match(src, /Hide from notes list/);
  const chatgpt = src.indexOf('mkItem(ICON_SPARK,"ChatGPT"');
  const aiView = src.indexOf('view==="ai"');
  assert.ok(chatgpt > aiView, "ChatGPT belongs in the AI submenu, not the root list");
});
