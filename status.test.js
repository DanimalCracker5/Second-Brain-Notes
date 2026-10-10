"use strict";

/* Tests for the status field on todo notes: canonical values, normalizeItem
   cleaning (todos only), persistence signatures, the list filter, multi-device
   merging, and chapter blocks coexisting with status. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function grab(name, next) {
  const from = html.indexOf("  function " + name + "(");
  assert.ok(from >= 0, "missing " + name);
  const to = next ? html.indexOf(next, from + 1) : html.length;
  assert.ok(to > from, "missing end of " + name);
  return html.slice(from, to).trim();
}

function functionAnchor(name) {
  return "  function " + name + "(";
}

const sandbox = {
  /* Stubs for neighbours the grabbed functions call. */
  blockForReading: function (note, block) { return block; },
  blockPlainText: function (block) { return block && block.text || ""; },
  itemKindForAgent: function (it) { return it && (it.todo || it.type === "todo") ? "todo" : (it.type || "note"); },
  itemText: function (it) { return (it.title || "") + " " + (it.body || ""); },
  firstTagName: function () { return ""; },
  itemDueDate: function () { return ""; },
  tagById: function () { return null; },
  itemModule: function () { return null; },
  uid: function () { return "id"; },
  cleanIconColor: function () { return ""; },
  migrateScriptToNote: function () {},
  migrateTodoToNote: function () {},
  ensureAudioItem: function () {},
  normalizeAgent: function () {},
  trimChatLog: function (log) { return log; },
  ensureNoteBlocks: function (note) { if (!Array.isArray(note.blocks)) note.blocks = []; note.attachments = Array.isArray(note.attachments) ? note.attachments : []; },
  canStructurallyMergeItems: function () { return true; },
  adoptItemRecency: function () {},
  mergeKeyedRecords: function (localList, remoteList, options) { return options && options.authoritativePrimary && remoteList ? remoteList : (localList || remoteList); },
  mergeAttachmentLists: function (localList, remoteList) { return localList || remoteList || []; },
  revisionWeight: function () { return 1; },
  syncStateSignature: function () { return ""; }
};
sandbox.state = { items: [], tags: [], filterTag: null, filterType: "", filterStatus: "", noteSearch: "", sidebarView: "all", listSort: "updated" };
vm.createContext(sandbox);

[
  ["isTodoNote", functionAnchor("visibleBlockText")],
  ["cleanStatus", functionAnchor("todoStatus")],
  ["todoStatus", functionAnchor("statusLabel")],
  ["statusLabel", "  /* =================== storage"],
  ["ensureItemRevision", functionAnchor("rawStateBackupPayload")],
  ["normalizeItem", functionAnchor("forEachItemContentDocument")],
  ["visibleItems", "  var $="],
  ["cloneData", functionAnchor("stableStringify")],
  ["stableStringify", functionAnchor("itemSyncSignature")],
  ["itemSyncSignature", functionAnchor("buildSyncBaseline")],
  ["itemRevision", functionAnchor("revisionIsNewer")],
  ["revisionIsNewer", functionAnchor("mergeTombstones")],
  ["mergeTombstones", functionAnchor("recordDeletedBlock")],
  ["pruneTombstones", functionAnchor("recordDeletedItem")],
  ["dropTombstonedBlocks", functionAnchor("pruneTombstones")],
  ["mergeLiveItems", functionAnchor("applyIncomingItemOnto")]
].forEach(function (pair) {
  vm.runInContext(grab(pair[0], pair[1]), sandbox, { filename: pair[0] });
});
vm.runInContext("var TODO_STATUSES=[\"queued\",\"in progress\",\"ready to test\",\"failed test\",\"passed test\"]; var lastPersistChangedIds=[]; var currentUser=null;", sandbox);
vm.runInContext(grab("syncStateSignature", functionAnchor("bumpLocalVersions")), sandbox, { filename: "syncStateSignature" });
vm.runInContext(grab("bumpLocalVersions", functionAnchor("itemSetChanged")), sandbox, { filename: "bumpLocalVersions" });

function todoOf(status, extra) {
  const item = Object.assign({ id: "t1", type: "note", todo: true, done: false, title: "Test todo", updated: 1, version: 1, versionChangedAt: 1, dueDate: "" }, extra || {});
  if (status !== undefined) item.status = status;
  return item;
}

test("status values are the five Daniel named; aliases normalize; junk becomes empty", function () {
  assert.deepEqual(sandbox.cleanStatus("queued"), "queued");
  assert.deepEqual(sandbox.cleanStatus("In Progress"), "in progress");
  assert.deepEqual(sandbox.cleanStatus("ready-to-test"), "ready to test");
  assert.deepEqual(sandbox.cleanStatus("failed_test"), "failed test");
  assert.deepEqual(sandbox.cleanStatus("passed test"), "passed test");
  assert.equal(sandbox.cleanStatus("shipped"), "");
  assert.equal(sandbox.cleanStatus(""), "");
  assert.equal(sandbox.cleanStatus("clear"), "");
  assert.equal(sandbox.cleanStatus(null), "");
});

test("todos default to empty status when the field is missing (migration-safe)", function () {
  const item = todoOf(undefined, { blocks: [{ id: "b", type: "text", text: "old todo without a status" }] });
  sandbox.normalizeItem(item);
  assert.equal(sandbox.todoStatus(item), "");
  assert.equal(item.blocks.length, 1);
});

test("normalizeItem keeps valid status on todos and repairs invalid ones", function () {
  const item = todoOf("queued");
  sandbox.normalizeItem(item);
  assert.equal(item.status, "queued");
  const bad = todoOf("shipped");
  sandbox.normalizeItem(bad);
  assert.equal(sandbox.todoStatus(bad), "");
});

test("status never lands on plain notes — normalizeItem deletes it", function () {
  const note = { id: "n1", type: "note", title: "Plain note", blocks: [{ id: "b", type: "text", text: "words" }], status: "queued", updated: 1 };
  sandbox.normalizeItem(note);
  assert.equal("status" in note, false);
  assert.equal(sandbox.todoStatus(note), "");
});

test("chapter blocks coexist with status on todo bodies", function () {
  const item = todoOf("ready to test", {
    body: "Testing\nChapter text",
    blocks: [
      { id: "c1", type: "chapter", title: "Testing instructions", text: "Chapter text", html: "Chapter text" },
      { id: "b1", type: "text", text: "Testing" }
    ]
  });
  sandbox.normalizeItem(item);
  assert.equal(item.status, "ready to test");
  assert.equal(item.blocks.length, 2);
  assert.equal(item.blocks[0].type, "chapter");
  assert.equal(item.blocks[0].title, "Testing instructions");
});

test("changing only the status changes the sync signature and bumps the local version (persistence)", function () {
  sandbox.state.items = [todoOf("", { version: 3, versionChangedAt: 5 })];
  const before = sandbox.itemSyncSignature(sandbox.state.items[0]);
  sandbox.state.items[0].status = "in progress";
  const after = sandbox.itemSyncSignature(sandbox.state.items[0]);
  assert.notEqual(before, after);
  const weight = sandbox.bumpLocalVersions({ items: [todoOf("", { version: 3, versionChangedAt: 5 })] });
  assert.equal(weight >= 1, true);
  assert.deepEqual(sandbox.lastPersistChangedIds, ["t1"]);
  assert.equal(sandbox.state.items[0].version > 3, true);
});

test("normalizeItem leaves an unchanged status stable so repeated saves do not churn versions", function () {
  const item = todoOf("queued");
  sandbox.normalizeItem(item);
  const first = sandbox.itemSyncSignature(item);
  sandbox.normalizeItem(item);
  assert.equal(sandbox.itemSyncSignature(item), first);
});

test("visibleItems filters by status: a value, no status, and no filter", function () {
  sandbox.state.items = [
    todoOf("queued", { id: "t-q" }),
    todoOf("in progress", { id: "t-i" }),
    todoOf("", { id: "t-none" }),
    { id: "n1", type: "note", title: "Plain note", blocks: [{ id: "b", type: "text", text: "" }], updated: 1 }
  ];
  sandbox.state.filterStatus = "queued";
  assert.deepEqual(sandbox.visibleItems().map(function (it) { return it.id; }), ["t-q"]);
  sandbox.state.filterStatus = "none";
  assert.deepEqual(sandbox.visibleItems().map(function (it) { return it.id; }), ["t-none", "n1"]);
  sandbox.state.filterStatus = "";
  assert.equal(sandbox.visibleItems().length, 4);
  sandbox.state.filterStatus = "junk";
  assert.deepEqual(sandbox.visibleItems().map(function (it) { return it.id; }), []);
});

test("merging two devices keeps the status of the newer revision", function () {
  const local = todoOf("queued", { version: 5 });
  const remote = todoOf("passed test", { version: 4 });
  assert.equal(sandbox.mergeLiveItems(local, remote, {}).status, "queued");
  assert.equal(sandbox.mergeLiveItems(local, remote, { preferLocal: false }).status, "passed test");
});

test("merging an old device without status does not wipe a set status", function () {
  const old = todoOf(undefined, { version: 9 });
  const newer = todoOf("ready to test", { version: 3 });
  const merged = sandbox.mergeLiveItems(old, newer, { preferLocal: false });
  assert.equal(merged.status, "ready to test");
});
test("a deliberately cleared status on the newer device wins over a set status", function () {
  const cleared = todoOf("", { version: 9 });
  const older = todoOf("failed test", { version: 3 });
  const merged = sandbox.mergeLiveItems(cleared, older, {});
  assert.equal(merged.status, "");
});

test("merge strips status that leaked onto a plain note", function () {
  const note = { id: "n1", type: "note", title: "Note", blocks: [{ id: "b", type: "text", text: "" }], status: "queued", updated: 1, version: 1 };
  const other = { id: "n1", type: "note", title: "Note", blocks: [{ id: "b2", type: "text", text: "" }], updated: 2, version: 2 };
  const merged = sandbox.mergeLiveItems(note, other, {});
  assert.equal("status" in merged, false);
});
