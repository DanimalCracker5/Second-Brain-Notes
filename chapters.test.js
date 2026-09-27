"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function grab(name, next) {
  const from = html.indexOf("  function " + name + "(");
  assert.ok(from >= 0, "missing " + name);
  const to = next ? html.indexOf("  function " + next + "(", from + 1) : html.length;
  assert.ok(to > from, "missing end of " + name);
  return html.slice(from, to);
}

test("chapter controls stay in the document flow", function () {
  const css = html.slice(html.indexOf(".note-block-actions{"), html.indexOf(".note-heading{"));
  assert.match(css, /\.note-chapter \.note-chapter-actions\{[^}]*position:\s*static/);
  assert.match(css, /\.note-chapter \.note-chapter-actions\{[^}]*border:\s*0/);
  assert.match(css, /\.note-chapter \.note-chapter-actions\{[^}]*visibility:\s*visible/);
  assert.match(css, /\.note-chapter \.note-chapter-actions\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.note-chapter \.note-paragraph-wrap:focus-within\{[^}]*padding-bottom:\s*2px/);
  assert.doesNotMatch(css, /\.note-chapter:hover \.note-chapter-actions/);
});

test("chapter move and delete are real block actions", function () {
  const src = grab("buildNoteChapter", "buildNoteCode");
  assert.match(src, /buildNoteBlockActions\(note,block,"note-chapter-actions"\)/);
  const actions = grab("buildNoteBlockActions", "contentEditableCaretHtml");
  assert.match(actions, /Move block up/);
  assert.match(actions, /Move block down/);
  assert.match(actions, /Delete block/);
  assert.match(actions, /moveNoteBlock\(note,block,-1\)/);
  assert.match(actions, /moveNoteBlock\(note,block,1\)/);
  assert.match(actions, /deleteNoteBlock\(note,block\)/);
  assert.match(actions, /touchend/);
});

test("typing in a chapter body does not restore the caret into the title", function () {
  const src = grab("restoreOpenEditorCaret", "refreshOpenItemFromLive");
  assert.match(src, /candidate\.isContentEditable/);
  assert.match(src, /guard\.contentOffset!=null&&candidate\.isContentEditable/);
  const chapter = grab("buildNoteChapter", "buildNoteCode");
  assert.match(chapter, /rememberNoteTextSelection\(note,block,body\)/);
});
