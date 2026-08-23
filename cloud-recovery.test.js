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

const sandbox = {
  AGENT_DEFAULT_ID: "__default_agent__",
  itemModule: function () { return null; },
  itemText: function (item) { return (item && item.body) || ""; },
  itemHasAttachments: function () { return false; },
  cloneData: function (value) { return JSON.parse(JSON.stringify(value || {})); }
};
vm.createContext(sandbox);
[
  ["hasContent", "unlinkedDeviceItems"],
  ["itemRevision", "notesMissingFrom"],
  ["mergeCloudWithBackup", "recoverCloudAccount"],
  ["accountPreferences", "applyAccountPreferences"]
].forEach(function (pair) {
  vm.runInContext(grab(pair[0], pair[1]), sandbox, { filename: pair[0] });
});

function note(id, title) {
  return { id: id, type: "note", title: title, body: title + " body", updated: 1 };
}
function untitled(id) {
  return { id: id, type: "note", title: "", body: "", updated: 1 };
}
function assistant() {
  return { id: "__default_agent__", type: "agent", title: "Assistant", body: "", updated: 1 };
}

test("empty Untitled notes and the built-in Assistant are not real account notes", function () {
  assert.equal(sandbox.countRealAccountItems([untitled("a"), assistant()]), 0);
  assert.equal(sandbox.countRealAccountItems([untitled("a"), note("n1", "Ship plan")]), 1);
});

test("richestAccountBackup prefers the snapshot with the owner's notes", function () {
  const empty = { created: 9, data: { items: [untitled("x"), assistant()] } };
  const older = { created: 1, data: { items: [note("n1", "One"), note("n2", "Two")] } };
  const newerSmall = { created: 8, data: { items: [note("n1", "One")] } };
  const richest = sandbox.richestAccountBackup([empty, newerSmall, older]);
  assert.ok(richest);
  assert.equal(richest.count, 2);
  assert.equal(richest.data.items[1].title, "Two");
});

test("mergeCloudWithBackup restores missing owner notes onto an emptied live account", function () {
  const live = { items: [untitled("seed")], folders: [], tags: [], deletedItems: {}, version: 4 };
  const backup = {
    items: [note("n1", "Meeting"), note("n2", "Ideas"), untitled("old-empty")],
    folders: [],
    tags: [{ id: "t1", name: "work" }],
    version: 3
  };
  const merged = sandbox.mergeCloudWithBackup(live, backup);
  assert.equal(sandbox.countRealAccountItems(merged.items), 2);
  assert.ok(merged.items.every(function (item) { return item.id !== "seed"; }));
  assert.equal(merged.tags[0].name, "work");
  assert.ok(merged.version > 4);
});

test("mergeCloudWithBackup does not revive tombstoned notes", function () {
  const live = {
    items: [],
    deletedItems: { gone: { version: 9, versionChangedAt: 50, deletedAt: 50 } }
  };
  const backup = {
    items: [
      { id: "gone", type: "note", title: "Deleted on purpose", body: "nope", version: 2, versionChangedAt: 10, updated: 10 },
      note("keep", "Still here")
    ]
  };
  const merged = sandbox.mergeCloudWithBackup(live, backup);
  assert.deepEqual(merged.items.map(function (item) { return item.id; }), ["keep"]);
});

test("backupEntryData reads nested and legacy backup shapes", function () {
  const nested = sandbox.backupEntryData({ data: { items: [note("n1", "A")] } });
  const legacy = sandbox.backupEntryData({ items: [note("n2", "B")], created: 1 });
  assert.equal(nested.items[0].id, "n1");
  assert.equal(legacy.items[0].id, "n2");
});
