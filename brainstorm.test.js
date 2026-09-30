"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("main app script parses", function () {
  const start = html.indexOf("<script>\n(function(){");
  const end = html.indexOf("})();\n</script>");
  assert.ok(start >= 0 && end > start, "main app script not found");
  const appJs = html.slice(start + "<script>\n".length, end + "})();".length);
  try { new vm.Script(appJs, { filename: "index.html" }); }
  catch (error) { assert.fail(error.stack || error.message); }
});

function sliceBetween(startMarker, endMarker) {
  const from = html.indexOf(startMarker);
  const to = html.indexOf(endMarker, from + startMarker.length);
  assert.ok(from >= 0 && to > from, "missing " + startMarker);
  return html.slice(from, to);
}

const sandbox = { contentOwner: function () { return null; } };
vm.createContext(sandbox);
vm.runInContext(sliceBetween("  var brainstormArmed=new WeakMap();", "  function saveNoteBlockChange("), sandbox, { filename: "brainstorm" });

function note(extra) {
  return Object.assign({ id: "n1", type: "note", blocks: [] }, extra || {});
}
function chapter(text) {
  return { id: "ch1", type: "chapter", title: "Intro", text: text, html: text };
}

test("editing in brainstorming mode keeps the approved copy and shows the draft", function () {
  const item = note({ brainstorming: true });
  const block = chapter("Hello there");
  sandbox.armBrainstorm(item, block);
  block.text = "Hello there, welcome";
  block.html = "Hello there, welcome";
  assert.equal(sandbox.markBrainstormEdit(item, block), true);
  assert.equal(block.brainstorm, true);
  assert.equal(block.approved.text, "Hello there");
  assert.equal(sandbox.blockForReading(item, block).text, "Hello there, welcome");
  delete item.brainstorming;
  assert.equal(sandbox.blockForReading(item, block).text, "Hello there");
  assert.equal(sandbox.brainstormBlockVisible(item, block), true);
  const view = sandbox.brainstormView(item, block);
  assert.equal(view.text, "Hello there");
  view.text = "Hello there, published";
  assert.equal(block.approved.text, "Hello there, published");
  assert.equal(block.text, "Hello there, welcome");
});

test("a block created from empty text stays hidden until approved", function () {
  const item = note({ brainstorming: true });
  const block = { id: "p1", type: "text", text: "", html: "" };
  sandbox.armBrainstorm(item, block);
  block.text = "a private line";
  block.html = "a private line";
  assert.equal(sandbox.markBrainstormEdit(item, block), true);
  assert.equal(block.brainstormNew, true);
  assert.equal(block.approved, undefined);
  delete item.brainstorming;
  assert.equal(sandbox.brainstormBlockVisible(item, block), false);
  assert.equal(sandbox.publishedBlock(block), null);
  assert.equal(sandbox.blockForReading(item, block), null);
  item.brainstorming = true;
  assert.equal(sandbox.acceptBrainstormBlock(block), true);
  assert.equal(block.text, "a private line");
  assert.equal(block.brainstorm, undefined);
  delete item.brainstorming;
  assert.equal(sandbox.brainstormBlockVisible(item, block), true);
  assert.equal(sandbox.publishedBlock(block).text, "a private line");
});

test("delete restores the approved block and drops a new brainstorm block", function () {
  const item = note({ brainstorming: true });
  const edited = chapter("Keep me");
  sandbox.armBrainstorm(item, edited);
  edited.text = "Try this";
  edited.html = "Try this";
  sandbox.markBrainstormEdit(item, edited);
  assert.equal(sandbox.revertBrainstormBlock(edited), "reverted");
  assert.equal(edited.text, "Keep me");
  assert.equal(edited.brainstorm, undefined);

  const created = { id: "p2", type: "text", text: "new", html: "new", brainstorm: true, brainstormNew: true };
  assert.equal(sandbox.revertBrainstormBlock(created), "delete");
});

test("an unchanged block is not marked", function () {
  const item = note({ brainstorming: true });
  const block = chapter("Same");
  sandbox.armBrainstorm(item, block);
  assert.equal(sandbox.markBrainstormEdit(item, block), false);
  assert.equal(block.brainstorm, undefined);
  assert.equal(block.approved, undefined);
});

test("public text ignores brainstorm drafts", function () {
  const block = chapter("Draft");
  block.brainstorm = true;
  block.approved = { title: "Intro", text: "Published", html: "Published" };
  const published = sandbox.publishedBlock(block);
  assert.equal(published.text, "Published");
  assert.equal(published.brainstorm, undefined);
  assert.equal(published.approved, undefined);
});

test("more actions live in the modal and the title can fade into the bar", function () {
  const bar = html.slice(html.indexOf('<div class="bar">'), html.indexOf('<div class="canvas"'));
  const modal = html.slice(html.indexOf('id="moreModal"'), html.indexOf('id="syncConflictModal"'));
  assert.match(bar, /id="moreBtn"/);
  assert.match(bar, /id="barTitle"/);
  assert.match(bar, />More</);
  assert.doesNotMatch(bar, /id="copyAll"/);
  assert.doesNotMatch(bar, /id="ttsBtn"/);
  assert.doesNotMatch(bar, /id="shareBtn"/);
  assert.match(modal, /id="ttsBtn"/);
  assert.match(modal, /id="shareBtn"/);
  assert.match(modal, /id="copyAll"/);
  assert.match(modal, /id="brainstormBtn"/);
  assert.match(modal, /Enter Brainstorming Mode/);
  assert.match(html, /\.is-brainstorm\{/);
  assert.match(html, /\.bar-title\{/);
  assert.match(html, /function syncBarTitle\(/);
  assert.match(html, /canvas\.scrollTop-top/);
  assert.match(html, /Approve/);
  assert.match(html, /brainstorm-delete/);
});
