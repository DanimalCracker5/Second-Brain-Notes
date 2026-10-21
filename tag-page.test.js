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

test("clicking a sidebar tag opens a tag page instead of only filtering the drawer", function () {
  const chip = grab("renderTagChip", "renderTagCloud");
  assert.match(chip, /viewingTagId=tag\.id/);
  assert.match(chip, /viewingHome=false/);
  assert.match(chip, /state\.filterTag=tag\.id/);
  assert.match(chip, /tagPageStatus=""/);
  const render = grab("renderMain", "buildWorkoutRoutine");
  const tagAt = render.indexOf("renderTagPage()");
  const homeAt = render.indexOf("if(viewingHome)");
  const noteAt = render.indexOf("var it=current()");
  assert.ok(tagAt >= 0 && tagAt < homeAt && homeAt < noteAt, "tag page is shown before home and before the open note");
  assert.match(grab("showHome", "revealItem"), /viewingTagId=null/);
  assert.match(grab("revealItem", "syncHomeButton"), /viewingTagId=null/);
});

test("the tag page is a short list with detail, compact, status, and sort", function () {
  const page = grab("renderTagPage", "renderHome");
  assert.match(page, /id="tagPageList"/);
  assert.match(page, /Detail/);
  assert.match(page, /Compact/);
  assert.match(page, /tagPageSortOptions\(\)/);
  assert.match(page, /buildHomeNoteRow\(it, \{compact:tagPageView==="compact"\}\)/);
  assert.match(page, /Nothing in this tag yet/);
  assert.doesNotMatch(page, /Customize/);
  assert.doesNotMatch(page, /home-grid/);
});

const sandbox = {
  viewingTagId: "work",
  tagPageSort: "updated",
  tagPageStatus: "",
  isTodoNote: function (it) { return !!(it && (it.todo || it.type === "todo")); },
  itemDueDate: function (it) { return it.dueDate || ""; },
  state: {
    items: [
      { id: "a", title: "Bravo", hidden: false, tagIds: ["work"], updated: 2, type: "note" },
      { id: "b", title: "Alpha", hidden: false, tagIds: ["work"], updated: 5, type: "todo", todo: true, done: false, dueDate: "2020-01-01" },
      { id: "c", title: "Done todo", hidden: false, tagIds: ["work"], updated: 9, type: "todo", todo: true, done: true },
      { id: "d", title: "Other tag", hidden: false, tagIds: ["other"], updated: 20, type: "note" },
      { id: "e", title: "Hidden", hidden: true, tagIds: ["work"], updated: 30, type: "note" }
    ]
  }
};
vm.createContext(sandbox);
vm.runInContext(grab("tagPageNotes", "tagPageCount"), sandbox, { filename: "tagPageNotes" });

test("tagPageNotes keeps notes on the open tag and honors status and sort", function () {
  assert.deepEqual(sandbox.tagPageNotes().map(function (it) { return it.id; }), ["c", "b", "a"]);
  sandbox.tagPageStatus = "open";
  assert.deepEqual(sandbox.tagPageNotes().map(function (it) { return it.id; }), ["b"]);
  sandbox.tagPageStatus = "done";
  assert.deepEqual(sandbox.tagPageNotes().map(function (it) { return it.id; }), ["c"]);
  sandbox.tagPageStatus = "";
  sandbox.tagPageSort = "title";
  assert.deepEqual(sandbox.tagPageNotes().map(function (it) { return it.id; }), ["b", "a", "c"]);
  sandbox.tagPageSort = "due";
  assert.deepEqual(sandbox.tagPageNotes().map(function (it) { return it.id; }), ["b", "c", "a"]);
});
