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

test("clicking a tag while a note is open leaves the note for that tag's list", function () {
  const chip = grab("renderTagChip", "renderTagCloud");
  assert.match(chip, /if\(!viewingHome\)\{\s*state\.filterTag=tag\.id/);
  assert.match(chip, /syncHomeTagFromSidebar\(\)/);
  const sync = grab("syncHomeTagFromSidebar", "revealItem");
  assert.match(sync, /if\(!viewingHome\)/);
  assert.match(sync, /viewingHome=true/);
  assert.match(sync, /homeTagId=next/);
  const box = {
    viewingHome: false,
    viewingTagId: null,
    homeTagId: null,
    state: { filterTag: "yt" },
    app: { classList: { contains: function () { return false; }, remove: function (name) { box.removed = name; } } },
    tagById: function (id) { return { id: id, name: "Youtube" }; },
    usesOverlaySidebar: function () { return true; },
    exitSidebarFocus: function () { box.exited = true; }
  };
  vm.createContext(box);
  vm.runInContext(sync, box, { filename: "sync-from-note" });
  box.syncHomeTagFromSidebar();
  assert.equal(box.viewingHome, true);
  assert.equal(box.homeTagId, "yt");
  assert.equal(box.exited, true);
  assert.equal(box.removed, "open");
});
