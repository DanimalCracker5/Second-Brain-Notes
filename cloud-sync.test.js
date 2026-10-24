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

test("main app script still parses after dual-device sync", function () {
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

let copySeq = 0;
const sandbox = {
  AGENT_DEFAULT_ID: "__default_agent__",
  itemModule: function () { return null; },
  itemText: function (item) { return (item && item.body) || ""; },
  itemHasAttachments: function () { return false; },
  cloneData: function (value) { return JSON.parse(JSON.stringify(value || {})); },
  uid: function () { copySeq += 1; return "copy-" + copySeq; },
  currentUser: { uid: "user-1" },
  state: {},
  normalizeItem: function () {},
  migrateFoldersToTags: function () {},
  tagLayoutSignature: function () { return ""; },
  accountPreferences: function (data) {
    if (!data) return null;
    if (data.preferences && typeof data.preferences === "object") return data.preferences;
    if (data.theme || typeof data.motion === "boolean") return { theme: data.theme, motion: data.motion };
    return null;
  },
  cleanStatus: function (value) { return value || ""; },
  isTodoNote: function (it) { return !!(it && it.todo); }
};
vm.createContext(sandbox);
[
  ["hasContent", "unlinkedDeviceItems"],
  ["cloneData", "useData"]
].forEach(function (pair) {
  vm.runInContext(grab(pair[0], pair[1]), sandbox, { filename: pair[0] });
});
vm.runInContext(grab("tagLayoutSignature", "rememberTagOrder"), sandbox, { filename: "tagLayoutSignature" });

function note(id, title, extra) {
  return Object.assign({
    id: id,
    type: "note",
    title: title,
    body: title + " body",
    updated: 10,
    version: 2,
    versionChangedAt: 10
  }, extra || {});
}

function clip(id, title, extra) {
  return Object.assign({
    id: id,
    type: "audio",
    title: title,
    body: title + " body",
    updated: 10,
    version: 2,
    versionChangedAt: 10
  }, extra || {});
}

function reset(items, baselineItems) {
  copySeq = 0;
  sandbox.state = {
    items: items.map(function (item) { return sandbox.cloneData(item); }),
    folders: [],
    tags: [],
    deletedItems: {},
    deletedTags: {},
    version: 4,
    versionChangedAt: 10,
    lastCloudSync: 10,
    lastLocalChange: 10
  };
  sandbox.currentUser = { uid: "user-1" };
  if (baselineItems) {
    sandbox.state.syncBaseline = sandbox.buildSyncBaseline({ items: baselineItems }, 10);
  } else {
    sandbox.state.syncBaseline = null;
  }
}

function byId(items) {
  const out = {};
  (items || []).forEach(function (item) { if (item && item.id) out[item.id] = item; });
  return out;
}

test("independent edits to different notes both survive", function () {
  const shared = [note("a", "Alpha"), note("b", "Beta")];
  const local = [note("a", "Alpha"), note("b", "Beta on PC", { version: 3, versionChangedAt: 20 })];
  const cloud = [note("a", "Alpha on phone", { version: 3, versionChangedAt: 20 }), note("b", "Beta")];
  reset(local, shared);
  const result = sandbox.reconcileWithCloud({ items: cloud, folders: [], tags: [], deletedItems: {}, version: 5 });
  assert.equal(result.conflicts.length, 0);
  const items = byId(result.data.items);
  assert.equal(items.a.title, "Alpha on phone");
  assert.equal(items.b.title, "Beta on PC");
  assert.equal(result.needsCloudWrite, true);
});

test("only the other device changed a note — keep the cloud version", function () {
  const shared = [note("a", "Alpha")];
  reset([note("a", "Alpha")], shared);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha on phone", { version: 4, versionChangedAt: 30 })],
    folders: [], tags: [], deletedItems: {}, version: 6
  });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.data.items[0].title, "Alpha on phone");
});

test("only this device changed a note — keep the local version", function () {
  const shared = [note("a", "Alpha")];
  reset([note("a", "Alpha on PC", { version: 4, versionChangedAt: 30 })], shared);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha")],
    folders: [], tags: [], deletedItems: {}, version: 5
  });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.data.items[0].title, "Alpha on PC");
  assert.equal(result.needsCloudWrite, true);
});

test("the same note edited on both devices is merged in place, not copied", function () {
  const shared = [note("a", "Alpha")];
  reset([note("a", "Alpha on PC", { version: 5, versionChangedAt: 40 })], shared);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha on phone", { version: 4, versionChangedAt: 30 })],
    folders: [], tags: [], deletedItems: {}, version: 6
  });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].title, "Alpha on PC");
});

test("an unmergeable item edited on both devices keeps a conflict copy", function () {
  const shared = [clip("a", "Voice memo")];
  reset([clip("a", "Voice memo on PC", { version: 5, versionChangedAt: 40 })], shared);
  const result = sandbox.reconcileWithCloud({
    items: [clip("a", "Voice memo on phone", { version: 4, versionChangedAt: 30 })],
    folders: [], tags: [], deletedItems: {}, version: 6
  });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, "a");
  assert.equal(result.data.items[0].title, "Voice memo on phone");
  sandbox.preferLocalConflicts(result);
  assert.equal(result.data.items[0].title, "Voice memo on PC");
  const copies = sandbox.attachConflictCopies(result.data, result.conflicts);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].conflictOf, "a");
  assert.match(copies[0].title, /from another device/);
  assert.equal(copies[0].body, "Voice memo on phone body");
  assert.equal(result.data.items.length, 2);
});

test("a second conflict for the same unmergeable item updates the existing copy", function () {
  const shared = [clip("a", "Voice memo")];
  reset([
    clip("a", "Voice memo on PC", { version: 5, versionChangedAt: 40 }),
    { id: "copy-keep", type: "audio", title: "Voice memo (from another device)", body: "old phone", conflictOf: "a", updated: 20, version: 1 }
  ], shared);
  const result = sandbox.reconcileWithCloud({
    items: [clip("a", "Voice memo on phone v2", { version: 6, versionChangedAt: 50 })],
    folders: [], tags: [], deletedItems: {}, version: 7
  });
  sandbox.preferLocalConflicts(result);
  const copies = sandbox.attachConflictCopies(result.data, result.conflicts);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].id, "copy-keep");
  assert.equal(copies[0].body, "Voice memo on phone v2 body");
  assert.equal(result.data.items.filter(function (item) { return item.conflictOf === "a"; }).length, 1);
});

test("without a baseline, the higher revision still wins", function () {
  reset([note("a", "Alpha on PC", { version: 9, versionChangedAt: 40 })]);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha on phone", { version: 4, versionChangedAt: 90 })],
    folders: [], tags: [], deletedItems: {}, version: 6
  });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.data.items[0].title, "Alpha on PC");
});

test("a cloud drop without a tombstone does not delete the local note", function () {
  const shared = [note("a", "Alpha"), note("b", "Beta")];
  reset([note("a", "Alpha"), note("b", "Beta")], shared);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha")],
    folders: [], tags: [], deletedItems: {}, version: 8
  });
  assert.ok(result.data.items.some(function (item) { return item.id === "b"; }));
});

test("a tombstoned delete of an unchanged note is kept", function () {
  const shared = [note("a", "Alpha"), note("b", "Beta")];
  reset([note("a", "Alpha")], shared);
  sandbox.state.deletedItems = { b: { version: 3, versionChangedAt: 50, deletedAt: 50 } };
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha"), note("b", "Beta")],
    folders: [], tags: [], deletedItems: {}, version: 5
  });
  assert.equal(result.conflicts.length, 0);
  assert.ok(!result.data.items.some(function (item) { return item.id === "b"; }));
  assert.ok(result.data.deletedItems.b);
});

function groupedCloud() {
  return {
    items: [note("a", "Alpha", { tagIds: ["astral"] })],
    folders: [],
    tags: [
      { id: "youtube", name: "Youtube" },
      { id: "astral", name: "Astral" },
      { id: "songs", name: "Songs" }
    ],
    deletedItems: {},
    version: 8,
    preferences: {
      tagGroups: [{ id: "g1", name: "Astral Projection Game", collapsed: false, tagIds: ["astral"] }],
      tagOrder: ["youtube", "astral", "songs"]
    }
  };
}

test("a phone with no tag groups does not wipe the account's groups", function () {
  const cloud = groupedCloud();
  reset([note("a", "Alpha", { tagIds: ["astral"] })], [note("a", "Alpha", { tagIds: ["astral"] })]);
  sandbox.state.tags = [];
  sandbox.state.tagGroups = [];
  sandbox.state.tagOrder = [];
  const result = sandbox.reconcileWithCloud(cloud);
  assert.equal(result.needsCloudWrite, false);
  assert.equal(result.data.preferences.tagGroups[0].name, "Astral Projection Game");
  assert.deepEqual(result.data.preferences.tagGroups[0].tagIds, ["astral"]);
  assert.deepEqual(result.data.preferences.tagOrder, ["youtube", "astral", "songs"]);
});

test("a group created on this device is kept and the cloud groups stay", function () {
  const cloud = groupedCloud();
  reset([note("a", "Alpha", { tagIds: ["astral"] })], [note("a", "Alpha", { tagIds: ["astral"] })]);
  sandbox.state.tags = cloud.tags.concat([{ id: "journal", name: "Journal" }]);
  sandbox.state.tagGroups = cloud.preferences.tagGroups.concat([{ id: "g2", name: "Writing", collapsed: false, tagIds: ["journal"] }]);
  sandbox.state.tagOrder = ["youtube", "astral", "songs", "journal"];
  sandbox.state.syncBaseline.tagLayout = sandbox.tagLayoutSignature({
    tags: cloud.tags,
    tagOrder: cloud.preferences.tagOrder,
    tagGroups: cloud.preferences.tagGroups
  });
  const result = sandbox.reconcileWithCloud(cloud);
  assert.equal(result.needsCloudWrite, true);
  assert.deepEqual(result.data.preferences.tagGroups.map(function (group) { return group.id; }), ["g1", "g2"]);
});

test("a tag added on one device survives a body edit on the other", function () {
  const shared = [note("a", "Alpha", { tagIds: ["inbox"] })];
  reset([note("a", "Alpha on PC", { version: 5, versionChangedAt: 40, tagIds: ["inbox", "astral"] })], shared);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha on phone", { version: 4, versionChangedAt: 30, tagIds: ["inbox"] })],
    folders: [], tags: [], deletedItems: {}, version: 6
  });
  assert.deepEqual(result.data.items[0].tagIds, ["inbox", "astral"]);
});

test("removing a tag stays removed when the other device still has the old tag list", function () {
  const shared = [note("a", "Alpha", { tagIds: ["inbox", "astral"] })];
  reset([note("a", "Alpha", { version: 5, versionChangedAt: 40, tagIds: ["inbox"] })], shared);
  const result = sandbox.reconcileWithCloud({
    items: [note("a", "Alpha on phone", { version: 4, versionChangedAt: 30, tagIds: ["inbox", "astral"] })],
    folders: [], tags: [], deletedItems: {}, version: 6
  });
  assert.deepEqual(result.data.items[0].tagIds, ["inbox"]);
});

test("a large account paints before backup recovery and a failed read is not an empty library", function () {
  const load = grab("loadCloud", "cloudSaveDelay");
  assert.match(load, /showAccount\(original, \{cloud:original, recovered:0\}\)/);
  assert.match(load, /cloudAccountUnreadable=true/);
  assert.match(load, /pendingRemoteAccount&&countRealAccountItems/);
  assert.match(grab("renderList", "buildListRow"), /accountLibraryBlocked\(\)/);
  assert.match(grab("refreshAccountUsage", "noteAccountUsage"), /limit\(BACKUP_LIMIT\)/);
  assert.doesNotMatch(grab("startAccountUsageTracking", "setAuthGate"), /userRef\.onSnapshot/);
});
