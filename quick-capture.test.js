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

test("sidebar search is a growing note field with type and tag controls", function () {
  const drawer = html.slice(html.indexOf('<aside class="drawer">'), html.indexOf('<div class="main">'));
  assert.match(drawer, /<textarea id="noteSearch"/);
  assert.match(drawer, /id="noteSearchTypeBtn"/);
  assert.match(drawer, /id="noteSearchStatusBtn"/);
  assert.match(drawer, /id="noteSearchTagBtn"/);
  assert.match(drawer, /id="noteSearchMeta"/);
  assert.ok(drawer.indexOf('id="noteSearchWrap"') < drawer.indexOf('id="tagsToggleBtn"'));
  assert.match(html, /\.note-search\.is-expanded textarea\{[^}]*max-height:min\(42vh,240px\)/);
  assert.match(html, /function syncNoteSearchChrome\(fromResize\)/);
});

const sandbox = {
  state: { enabledTypes: { todo: true, note: true, script: true, file: true }, tags: [{ id: "astral", name: "Astral" }, { id: "gone", name: "Skip" }], quickCaptureTagIds: ["astral", "missing"], filterTag: "queue" },
  tagById: function (id) {
    return sandbox.state.tags.find(function (tag) { return tag.id === id; }) || null;
  },
  typeModuleList: function () {
    return [{ type: "file", label: "File", menuLabel: "File", create: function () { return { type: "file", title: "", tagIds: [] }; } }];
  },
  typeModule: function (id) {
    return sandbox.typeModuleList().find(function (def) { return def.type === id; }) || null;
  },
  newTodoItem: function () { return { type: "note", todo: true, done: false, tagIds: sandbox.state.filterTag ? [sandbox.state.filterTag] : [], blocks: [] }; },
  newNoteItem: function () { return { type: "note", tagIds: sandbox.state.filterTag ? [sandbox.state.filterTag] : [], blocks: [] }; },
  newYoutubeScriptNote: function () { return { type: "note", template: "youtube-script", tagIds: [], blocks: [{ type: "chapter", title: "Intro", text: "" }] }; },
  newAudioItem: function () { return { type: "audio", title: "", tagIds: [] }; },
  newAgentItem: function () { return { type: "agent", title: "New Agent", tagIds: [] }; },
  newWorkoutRoutine: function () { return { type: "workout", title: "", tagIds: [], blocks: [] }; },
  textBlock: function (text) { return { type: "text", text: text }; },
  syncNoteBody: function (note) { note.body = (note.blocks || []).map(function (block) { return block.text || ""; }).join("\n"); },
  escapeHtml: function (value) { return String(value).replace(/</g, "&lt;"); },
  parseDueDateText: function (text) { return /tomorrow/i.test(text) ? "2099-01-02" : ""; },
  cleanStatus: function (value) {
    var s = String(value == null ? "" : value).trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    if (!s || s === "clear" || s === "none" || s === "null") return "";
    return ["brainstorming", "queued", "in progress", "ready to test", "failed test", "passed test"].indexOf(s) >= 0 ? s : "";
  },
  quickNoteFallbackTitle: function (text) { return String(text || "").trim().split(/\s+/).slice(0, 6).join(" "); },
  Date: Date
};
vm.createContext(sandbox);
vm.runInContext(
  [
    grab("quickCaptureChoices", "quickCaptureExpands"),
    grab("quickCaptureExpands", "quickCaptureTagIds"),
    grab("quickCaptureTagIds", "defaultQuickCaptureType"),
    grab("fillQuickCaptureBody", "newQuickCaptureItem"),
    grab("newQuickCaptureItem", "addQuickNoteFromSearch")
  ].join("\n"),
  sandbox,
  { filename: "quick-capture" }
);

test("quick capture stays one line until the text no longer fits", function () {
  assert.equal(sandbox.quickCaptureExpands("", 200, 120), false);
  assert.equal(sandbox.quickCaptureExpands("   ", 40, 120), false);
  assert.equal(sandbox.quickCaptureExpands("short", 40, 120), false);
  assert.equal(sandbox.quickCaptureExpands("when i am not talking to an npc", 180, 120), true);
  assert.equal(sandbox.quickCaptureExpands("line one\nstill going", 40, 120), true);
  assert.equal(sandbox.quickCaptureExpands("waiting for layout", 400, 0), false);
});

test("quick capture keeps the active filter tag and any tags picked in the draft", function () {
  const todo = sandbox.newQuickCaptureItem("Ship the polish pass tomorrow", "todo");
  assert.equal(todo.todo, true);
  assert.equal(todo.dueDate, "2099-01-02");
  assert.equal(todo.blocks[0].text, "Ship the polish pass tomorrow");
  assert.deepEqual(todo.tagIds, ["queue", "astral"]);

  const note = sandbox.newQuickCaptureItem("A plain note", "note");
  assert.equal(note.todo, undefined);
  assert.equal(note.dueDate, undefined);
  assert.equal(note.blocks[0].text, "A plain note");

  const script = sandbox.newQuickCaptureItem("Intro line\nsecond line", "script");
  assert.equal(script.template, "youtube-script");
  assert.equal(script.blocks[0].text, "Intro line\nsecond line");
  assert.match(script.blocks[0].html, /Intro line<br>second line/);
  assert.deepEqual(script.tagIds, ["astral"]);

  const file = sandbox.newQuickCaptureItem("Reference clip", "file");
  assert.equal(file.type, "file");
  assert.equal(file.title, "Reference clip");
  assert.deepEqual(file.tagIds, ["astral"]);
});

test("quick capture type list follows the types that are turned on", function () {
  const labels = sandbox.quickCaptureChoices().map(function (row) { return row.label; });
  assert.deepEqual(labels, ["Todo", "Note", "YouTube Script", "File"]);
});

test("quick capture stamps a todo status and leaves other kinds alone", function () {
  sandbox.state.quickCaptureStatus = "brainstorming";
  const todo = sandbox.newQuickCaptureItem("Sketch the opening", "todo");
  assert.equal(todo.status, "brainstorming");
  const note = sandbox.newQuickCaptureItem("Sketch the opening", "note");
  assert.equal(note.status, undefined);
  sandbox.state.quickCaptureStatus = "someday";
  assert.equal(sandbox.newQuickCaptureItem("Sketch", "todo").status, "");
  sandbox.state.quickCaptureStatus = "";
});
