"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function grab(name, next) {
  const from = html.indexOf("  function " + name + "(");
  assert.ok(from >= 0, "missing " + name);
  const to = next ? html.indexOf("  function " + next + "(", from + 1) : html.length;
  assert.ok(to > from, "missing end of " + name);
  return html.slice(from, to).trim();
}

function trashSandbox() {
  const store = {};
  const box = {
    TRASH_RETENTION_MS: 3 * 24 * 60 * 60 * 1000,
    DELETE_CONFIRM_COOLDOWN_MS: 3 * 60 * 1000,
    DELETE_CONFIRM_KEY: "second-brain-delete-confirm-at",
    state: {
      items: [
        { id: "keep", title: "Keep", todo: true, done: false },
        { id: "done", title: "Ship it", todo: true, done: true },
        { id: "old", title: "Old", todo: true, done: true, trashedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 }
      ],
      currentId: "done"
    },
    activeAudioRecorder: null,
    confirms: 0,
    confirm: function () { box.confirms += 1; return box.allow; },
    allow: true,
    localStorage: {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      setItem: function (key, value) { store[key] = String(value); }
    },
    isTodoNote: function (item) { return !!(item && item.todo); },
    visibleItems: function () { return box.state.items.filter(function (item) { return !(item && Number(item.trashedAt) > 0); }); },
    newNoteItem: function () { return { id: "seed", title: "Untitled" }; },
    forEachItemContentDocument: function () {},
    cleanupContentAttachments: function () {},
    recordDeletedItem: function (item) { box.deleted.push(item.id); },
    persist: function () { box.persisted = true; },
    renderList: function () {},
    renderMain: function () {},
    showToast: function (message) { box.toast = message; },
    deleted: [],
    persisted: false,
    toast: ""
  };
  vm.createContext(box);
  vm.runInContext(
    [grab("isInTrash", "trashItems"), grab("trashItems", "recentDeleteConfirm"), grab("recentDeleteConfirm", "rememberDeleteConfirm"), grab("rememberDeleteConfirm", "leaveIfCurrentTrashed"), grab("leaveIfCurrentTrashed", "permanentlyRemoveItems"), grab("permanentlyRemoveItems", "purgeExpiredTrash"), grab("purgeExpiredTrash", "trashCompletedTodo"), grab("trashCompletedTodo", "visibleItems")].join("\n"),
    box,
    { filename: "trash" }
  );
  return box;
}

test("completed todo goes to trash after one confirm", function () {
  const box = trashSandbox();
  box.trashCompletedTodo("done");
  assert.equal(box.confirms, 1);
  assert.ok(box.state.items.find(function (item) { return item.id === "done"; }).trashedAt > 0);
  assert.equal(box.state.currentId, "keep");
  assert.equal(box.toast, "Moved to Trash");
  box.trashCompletedTodo("keep");
  assert.equal(box.confirms, 1, "an open todo is not trashed through this path");
});

test("confirm stays quiet for three minutes", function () {
  const box = trashSandbox();
  box.state.items.push({ id: "done2", title: "Also done", todo: true, done: true });
  box.trashCompletedTodo("done");
  box.trashCompletedTodo("done2");
  assert.equal(box.confirms, 1);
  assert.ok(box.state.items.find(function (item) { return item.id === "done2"; }).trashedAt > 0);
});

test("cancelling the confirm leaves the todo in place", function () {
  const box = trashSandbox();
  box.allow = false;
  box.trashCompletedTodo("done");
  assert.equal(box.state.items.find(function (item) { return item.id === "done"; }).trashedAt, undefined);
  assert.equal(box.persisted, false);
});

test("trash older than three days is deleted", function () {
  const box = trashSandbox();
  const count = box.purgeExpiredTrash();
  assert.equal(count, 1);
  assert.deepEqual(box.deleted, ["old"]);
  assert.equal(box.state.items.some(function (item) { return item.id === "old"; }), false);
  assert.equal(box.state.items.some(function (item) { return item.id === "done"; }), true);
});

test("settings includes a trash page", function () {
  assert.match(html, /data-settings="trash"/);
  assert.match(html, /Completed todos, kept for 3 days/);
  assert.match(grab("setupTrashSettings", "setupHomeSettings"), /Restore/);
});
