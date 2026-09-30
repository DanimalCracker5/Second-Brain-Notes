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

let seq = 0;
const sandbox = {
  uid: function () { seq += 1; return "id" + seq; },
  cleanText: function (value) { return typeof value === "string" ? value.trim() : ""; }
};
vm.createContext(sandbox);
["checklistItemsFromText", "syncChecklistText", "checklistBlock", "normalizeChecklistBlock", "richTextToPlain"].slice(0, -1).forEach(function (name, index, names) {
  const next = ["syncChecklistText", "checklistBlock", "normalizeChecklistBlock", "richTextToPlain"][index];
  vm.runInContext(grab(name, next), sandbox, { filename: name });
});
vm.runInContext(grab("canonicalBlockType", "textBlock"), sandbox, { filename: "canonicalBlockType" });

test("checklist lines become tickable items", function () {
  const items = sandbox.checklistItemsFromText("[x] socks\ncharger\n- [ ] hat\n* milk\n\n  ");
  assert.equal(items.length, 4);
  assert.equal(items[0].text, "socks");
  assert.equal(items[0].done, true);
  assert.equal(items[1].text, "charger");
  assert.equal(items[1].done, false);
  assert.equal(items[2].text, "hat");
  assert.equal(items[2].done, false);
  assert.equal(items[3].text, "milk");
});

test("checklist block keeps done state through the agent text form", function () {
  const block = sandbox.checklistBlock("Pack", null, "[x] socks\n[ ] hat");
  assert.equal(block.type, "checklist");
  assert.equal(block.title, "Pack");
  assert.equal(block.text, "[x] socks\n[ ] hat");
  const again = sandbox.checklistItemsFromText(block.text);
  assert.equal(again[0].done, true);
  assert.equal(again[1].text, "hat");
  assert.equal(again[1].done, false);
});

test("structured items win over text and blank lists still have a row", function () {
  const block = sandbox.checklistBlock("Errands", [{ text: "post office", done: true }, "bank"], "[ ] ignored");
  assert.deepEqual(block.items.map(function (item) { return item.text; }), ["post office", "bank"]);
  assert.equal(block.items[0].done, true);
  assert.equal(block.items[1].done, false);
  const empty = sandbox.checklistBlock("", [], "");
  assert.equal(empty.items.length, 1);
  assert.equal(empty.items[0].text, "");
  assert.equal(empty.text, "");
});

test("normalizeChecklistBlock repairs a saved list without dropping ids", function () {
  const block = sandbox.normalizeChecklistBlock({
    type: "checklist",
    title: 12,
    items: [{ id: "keep", text: "call back", done: 1 }, null, "nope"]
  });
  assert.equal(block.title, "");
  assert.equal(block.items.length, 1);
  assert.equal(block.items[0].id, "keep");
  assert.equal(block.items[0].done, true);
  assert.equal(block.text, "[x] call back");
  const fromText = sandbox.normalizeChecklistBlock({ type: "checklist", text: "[ ] only text" });
  assert.equal(fromText.items[0].text, "only text");
  assert.equal(fromText.items[0].done, false);
});

test("checklist aliases map onto the insert type", function () {
  assert.equal(sandbox.canonicalBlockType("Mini todo list"), "checklist");
  assert.equal(sandbox.canonicalBlockType("todo-list"), "checklist");
  assert.equal(sandbox.canonicalBlockType("text"), "paragraph");
  assert.equal(sandbox.canonicalBlockType("heading"), "heading");
  assert.equal(sandbox.canonicalBlockType(), "");
});

test("insert menu, settings, and saved notes all know about mini lists", function () {
  assert.match(html, /insertNoteBlock\(note,"checklist",insertAt\)/);
  assert.match(html, /Mini todo list/);
  assert.match(html, /id="insertChecklist"/);
  assert.match(html, /NOTE_INSERT_DEFAULTS=\{[^}]*checklist:true/);
  assert.match(html, /AGENT_NOTE_BLOCK_TYPES=\[[^\]]*checklist/);
  assert.match(html, /\["text","attachment","embed","link","heading","comment","prompt","chapter","group","checklist","code"\]/);
  assert.match(html, /if\(view\.type==="checklist"\) return buildNoteChecklist\(note,view\)/);
  const shared = fs.readFileSync(path.join(__dirname, "shared.html"), "utf8");
  assert.match(shared, /block\.type==="checklist"/);
  assert.match(shared, /\.checklist-row/);
});
