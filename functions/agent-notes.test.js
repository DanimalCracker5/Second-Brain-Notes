"use strict";

const assert = require("assert");
const { test } = require("node:test");
const notes = require("./agent-notes");

const NOW = Date.UTC(2026, 8, 29, 15, 0, 0);

function ctx() {
  let n = 0;
  return {
    now: NOW,
    id: function () {
      n += 1;
      return "id" + n;
    }
  };
}

function run(account, name, args) {
  return notes.runTool(account, name, args, ctx());
}

test("search skips hidden notes, empty seeds, and the built-in assistant", function () {
  const account = notes.accountFromData({
    items: [
      { id: "n1", type: "note", title: "Ship plan", body: "Hermes should see this", blocks: [{ id: "b", type: "text", text: "Hermes should see this" }], updated: 2 },
      { id: "hid", type: "note", title: "Secret", body: "Hermes hidden", hidden: true, blocks: [{ id: "h", type: "text", text: "Hermes hidden" }], updated: 3 },
      { id: "empty", type: "note", title: "", body: "", blocks: [{ id: "e", type: "text", text: "" }], updated: 1 },
      { id: "__default_agent__", type: "agent", title: "Assistant", body: "Hermes memory", updated: 4 }
    ]
  });
  const found = run(account, "search_notes", { query: "Hermes" }).result;
  assert.deepEqual(found.notes.map(function (note) { return note.id; }), ["n1"]);
  const hidden = run(account, "search_notes", { query: "Hermes", include_hidden: true }).result;
  assert.deepEqual(hidden.notes.map(function (note) { return note.id; }).sort(), ["hid", "n1"]);
});

test("create, append, and replace keep attachment blocks and bump revisions", function () {
  const created = run({ items: [], tags: [], deletedItems: {}, version: 4 }, "create_note", {
    title: "Trip",
    content: "Pack the charger",
    tags: ["travel"]
  });
  assert.equal(created.changed, true);
  assert.equal(created.account.version, 5);
  assert.equal(created.account.tags[0].name, "travel");
  const note = created.account.items[0];
  note.blocks.push({ id: "pic", type: "attachment", attachmentId: "img1" });
  note.attachments = [{ id: "img1" }];
  const appended = run(created.account, "update_note", { note_id: note.id, text: "And the passport", mode: "append" });
  assert.equal(appended.result.updated.body.indexOf("Pack the charger") >= 0, true);
  assert.equal(appended.result.updated.body.indexOf("passport") >= 0, true);
  assert.equal(appended.changedItems[0].blocks.some(function (block) { return block.type === "attachment"; }), true);
  assert.equal(appended.changedItems[0].blockSync, undefined);
  const replaced = run(appended.account, "update_note", { note_id: note.id, text: "Only this", mode: "replace" });
  assert.equal(replaced.result.updated.body, "Only this");
  assert.equal(replaced.changedItems[0].blockSync, "authoritative");
  assert.equal(replaced.changedItems[0].blocks.some(function (block) { return block.attachmentId === "img1"; }), true);
  assert.ok(replaced.changedItems[0].version > note.version);
});

test("todos can be created, completed, and filtered as overdue", function () {
  const created = run({ items: [], tags: [] }, "create_todo", { title: "File taxes", due_date: "2026-09-01", detail: "Gather forms" });
  const todo = created.result.created;
  assert.equal(todo.kind, "todo");
  assert.equal(todo.due_date, "2026-09-01");
  assert.equal(todo.done, false);
  const open = run(created.account, "list_todos", { filter: "overdue" }).result;
  assert.equal(open.todos[0].id, todo.id);
  const done = run(created.account, "update_todo", { todo_id: todo.id, done: true });
  assert.equal(done.result.updated.done, true);
  assert.equal(run(done.account, "list_todos", { filter: "open" }).result.count, 0);
  assert.equal(run(done.account, "list_todos", { filter: "done" }).result.count, 1);
});

test("a deleted tag stays deleted and a later create mints a new id", function () {
  const account = notes.accountFromData({
    items: [{ id: "n1", type: "note", title: "Trip", body: "Pack", tagIds: ["t1", "t2"], blocks: [{ id: "b", type: "text", text: "Pack" }] }],
    tags: [{ id: "t1", name: "travel" }, { id: "t2", name: "home" }],
    deletedTags: { t1: { deletedAt: 10, name: "travel" } }
  });
  assert.deepEqual(account.tags.map(function (tag) { return tag.id; }), ["t2"]);
  assert.deepEqual(account.items[0].tagIds, ["t2"]);
  const created = run(account, "create_note", { title: "Again", content: "Go", tags: ["travel"] });
  const travel = created.account.tags.filter(function (tag) { return tag.name === "travel"; });
  assert.equal(travel.length, 1);
  assert.notEqual(travel[0].id, "t1");
  assert.equal(created.account.deletedTags.t1.name, "travel");
});

test("delete requires confirm and leaves a tombstone the client will honor", function () {
  const created = run({ items: [], tags: [], deletedItems: {} }, "create_note", { title: "Scratch" });
  const id = created.result.created.id;
  assert.throws(function () { run(created.account, "delete_note", { note_id: id }); }, /confirm is true/);
  const deleted = run(created.account, "delete_note", { note_id: id, confirm: true });
  assert.equal(deleted.account.items.length, 0);
  assert.ok(deleted.account.deletedItems[id].deletedAt);
  assert.equal(deleted.deletedIds[0], id);
});

test("ambiguous titles ask for an id and code items are not rewritten", function () {
  const account = notes.accountFromData({
    items: [
      { id: "a", type: "note", title: "Plan", body: "one", blocks: [{ id: "a1", type: "text", text: "one" }], updated: 1 },
      { id: "b", type: "note", title: "Plan", body: "two", blocks: [{ id: "b1", type: "text", text: "two" }], updated: 2 },
      { id: "c", type: "code", title: "Script", code: "print(1)", updated: 3 }
    ]
  });
  assert.throws(function () { run(account, "update_note", { query: "Plan", text: "nope" }); }, /Pass note_id/);
  assert.throws(function () { run(account, "update_note", { note_id: "c", text: "nope" }); }, /code item/);
  const read = run(account, "read_note", { note_id: "c" }).result;
  assert.equal(read.note.body, "print(1)");
});

test("relative due dates use the injected clock", function () {
  assert.equal(notes.parseDueDate("tomorrow", NOW), "2026-09-30");
  assert.equal(notes.parseDueDate("clear", NOW), "");
  assert.throws(function () { notes.parseDueDate("someday", NOW); }, /YYYY-MM-DD/);
});

/* ----- todo status ----- */

function todoAccount(items) {
  return notes.accountFromData({ items: items });
}

/* runTool clones the account; tests that chain calls must use the returned account. */
function runKeep(account, name, args) {
  return notes.runTool(account, name, args, ctx());
}

function baseTodo(id, extra) {
  return Object.assign({ id: id, type: "note", todo: true, done: false, title: "Test todo", body: "", blocks: [{ id: id + "b", type: "text", text: "" }], dueDate: "", updated: 1, version: 1, versionChangedAt: 1 }, extra || {});
}

test("cleanStatus accepts the five statuses, normalizes aliases, and clears junk", function () {
  notes.TODO_STATUSES.forEach(function (status) {
    assert.equal(notes.cleanStatus(status), status);
  });
  assert.equal(notes.cleanStatus(" In_Progress "), "in progress");
  assert.equal(notes.cleanStatus("queued"), "queued");
  assert.equal(notes.cleanStatus("clear"), "");
  assert.equal(notes.cleanStatus(""), "");
  assert.equal(notes.cleanStatus(null), "");
  assert.equal(notes.cleanStatus("someday"), "");
});

test("todo reads expose status and todos without the field read as empty", function () {
  const account = todoAccount([baseTodo("t1", { status: "queued" }), baseTodo("t2")]);
  const listed = run(account, "list_todos", { filter: "all" }).result.todos;
  assert.equal(listed.length, 2);
  assert.equal(listed[0].status, "queued");
  assert.equal(listed[1].status, "");
  const read = run(account, "read_note", { note_id: "t1" }).result.note;
  assert.equal(read.status, "queued");
});

test("the agent sets and clears a todo status through updates", function () {
  let account = todoAccount([baseTodo("t1")]);
  account = runKeep(account, "update_todo", { todo_id: "t1", status: "in progress" }).account;
  assert.equal(run(account, "read_note", { note_id: "t1" }).result.note.status, "in progress");
  const second = runKeep(account, "update_todo", { todo_id: "t1", status: "passed test" });
  account = second.account;
  assert.equal(second.result.updated.status, "passed test");
  account = runKeep(account, "update_todo", { todo_id: "t1", status: "clear" }).account;
  assert.equal(run(account, "read_note", { note_id: "t1" }).result.note.status, "");
  account = runKeep(account, "update_todo", { todo_id: "t1", status: "" }).account;
  assert.equal(run(account, "read_note", { note_id: "t1" }).result.note.status, "");
  assert.throws(function () { run(account, "update_todo", { todo_id: "t1", status: "someday" }); }, /Unknown status/);
});

test("status is accepted on todo creation and rejected on plain notes", function () {
  const account = { items: [], tags: [], deletedItems: {}, version: 1 };
  const kept = runKeep(account, "create_todo", { title: "Verify dropdown", detail: "Open the todo and pick a status", status: "ready to test" });
  const created = kept.result.created;
  assert.equal(created.status, "ready to test");
  assert.equal(Array.isArray(created.blocks), true);
  assert.equal(run(kept.account, "read_note", { note_id: created.id }).result.note.status, "ready to test");
  assert.equal(kept.account.items.find(function (item) { return item.id === created.id; }).status, "ready to test");
  assert.throws(function () { run(account, "create_note", { title: "Plain", content: "Just a note", status: "queued" }); }, /only to todos/);
  assert.throws(function () { run(account, "create_todo", { title: "Todo", detail: "Body", status: "someday" }); }, /Unknown status/);
});

test("plain notes never carry a status, even after todo updates on other items", function () {
  let account = todoAccount([
    baseTodo("t1"),
    { id: "n1", type: "note", title: "Plain", body: "text", blocks: [{ id: "n1b", type: "text", text: "text" }], updated: 2 }
  ]);
  account = runKeep(account, "update_todo", { todo_id: "t1", status: "queued" }).account;
  const plain = account.items.find(function (item) { return item.id === "n1"; });
  assert.equal("status" in plain, false);
  const plainRead = run(account, "read_note", { note_id: "n1" }).result.note;
  assert.equal("status" in plainRead, false);
});

test("list_todos can filter by status, including todos with no status", function () {
  const account = todoAccount([
    baseTodo("t1", { status: "queued" }),
    baseTodo("t2", { status: "passed test" }),
    baseTodo("t3")
  ]);
  const queued = run(account, "list_todos", { filter: "all", status: "queued" }).result.todos;
  assert.deepEqual(queued.map(function (item) { return item.id; }), ["t1"]);
  const none = run(account, "list_todos", { filter: "all", status: "none" }).result.todos;
  assert.deepEqual(none.map(function (item) { return item.id; }), ["t3"]);
  assert.throws(function () { run(account, "list_todos", { status: "someday" }); }, /Unknown status/);
});

test("chapter blocks coexist with agent-set status on todos", function () {
  let account = todoAccount([baseTodo("t1", { status: "queued", blocks: [
    { id: "c1", type: "chapter", title: "Testing", text: "Run the app and check the dropdown." },
    { id: "p1", type: "paragraph", text: "Hermes wrote this." }
  ] })]);
  account = runKeep(account, "update_todo", { todo_id: "t1", status: "failed test" }).account;
  const stored = account.items.find(function (item) { return item.id === "t1"; });
  assert.equal(stored.status, "failed test");
  assert.equal(stored.blocks.length, 2);
  assert.equal(stored.blocks[0].type, "chapter");
  assert.equal(stored.blocks[0].title, "Testing");
  const read = run(account, "read_note", { note_id: "t1" }).result.note;
  assert.equal(read.status, "failed test");
  assert.equal(read.blocks.length, 2);
  const appended = runKeep(account, "update_note", { note_id: "t1", text: "\n- [ ] retest" });
  account = appended.account;
  assert.equal(appended.result.updated.status, "failed test");
  assert.equal(run(account, "read_note", { note_id: "t1" }).result.note.blocks.length >= 2, true);
});
