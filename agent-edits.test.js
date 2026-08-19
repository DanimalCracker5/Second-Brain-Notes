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
  cleanText: function (value) { return typeof value === "string" ? value.trim() : ""; },
  escapeHtml: function (s) { return (s || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); },
  ensureNoteBlocks: function (it) { if (!Array.isArray(it.blocks)) it.blocks = [{ id: "p1", type: "text", text: "", html: "" }]; },
  syncNoteBody: function (it) { it.body = (it.blocks || []).map(function (block) { return block.text || ""; }).filter(Boolean).join("\n"); },
  textBlock: function (text) { return { id: "new-" + Math.random().toString(36).slice(2, 6), type: "text", text: text || "", html: text || "" }; },
  joinText: function (before, after) {
    const head = String(before || ""), tail = String(after || "");
    if (!head) return tail;
    if (!tail) return head;
    return head.replace(/\s+$/, "") + "\n\n" + tail.replace(/^\s+/, "");
  },
  setBlockText: function (block, text) { block.text = text; block.html = text; }
};
vm.createContext(sandbox);
[
  ["parseToolArguments", "agentEditText"],
  ["agentEditText", "emptyPlaceholderTextBlock"],
  ["emptyPlaceholderTextBlock", "writeNoteBody"],
  ["firstWritableTarget", "resolveAgentTargetId"],
  ["resolveAgentTargetId", "writeTarget"],
  ["writeNoteBody", "firstWritableTarget"]
].forEach(function (pair) {
  vm.runInContext(grab(pair[0], pair[1]), sandbox, { filename: pair[0] });
});
sandbox.itemUsesNoteBlocks = function (it) { return !!(it && (it.type === "note" || it.type === "workout")); };
sandbox.createNoteBlock = function (type, seed) { return sandbox.textBlock(seed && seed.text || ""); };
sandbox.sec = function () { return {}; };
sandbox.newTask = function () { return { text: "" }; };
sandbox.ensureTodoTaskDetails = function () {};
vm.runInContext(grab("insertAfterTarget", "collabSystemPrompt"), sandbox, { filename: "insertAfterTarget" });
vm.runInContext(grab("looksLikeNoteWriteClaim", "collabApiMessages"), sandbox, { filename: "looksLikeNoteWriteClaim" });

test("parseToolArguments accepts objects, JSON, and trailing commas", function () {
  assert.deepEqual(sandbox.parseToolArguments({ text: "Hi" }), { text: "Hi" });
  assert.equal(sandbox.parseToolArguments('{"text":"When I get home"}').text, "When I get home");
  assert.equal(sandbox.parseToolArguments('{"text":"ok",}').text, "ok");
  assert.deepEqual(sandbox.parseToolArguments("not json"), {});
});

test("agentEditText reads common aliases", function () {
  assert.equal(sandbox.agentEditText("plain"), "plain");
  assert.equal(sandbox.agentEditText(["a", "b"]), "a\nb");
  assert.equal(sandbox.agentEditText({ content: "from content" }), "from content");
  assert.equal(sandbox.agentEditText({ body: "from body" }), "from body");
});

test("resolveAgentTargetId maps body aliases onto the body target", function () {
  const targets = [
    { id: "title", label: "Title", kind: "title" },
    { id: "body", label: "Whole note body", kind: "body" },
    { id: "p1", label: "Paragraph 1", kind: "block", block: { type: "text" } }
  ];
  assert.equal(sandbox.resolveAgentTargetId("body", targets, "replace"), "body");
  assert.equal(sandbox.resolveAgentTargetId("content", targets, "replace"), "body");
  assert.equal(sandbox.resolveAgentTargetId("paragraph 1", targets, "replace"), "body");
  assert.equal(sandbox.resolveAgentTargetId("made-up", targets, "replace"), "made-up");
  assert.equal(sandbox.resolveAgentTargetId("end", targets, "insert_after"), "end");
});

test("writeNoteBody fills an empty todo/note paragraph", function () {
  const note = { type: "note", todo: true, title: "", blocks: [{ id: "p1", type: "text", text: "", html: "" }] };
  sandbox.writeNoteBody(note, "When I get home, pull in and merge everything from the Hub.", "replace");
  assert.equal(note.blocks.length, 1);
  assert.equal(note.blocks[0].text, "When I get home, pull in and merge everything from the Hub.");
  assert.equal(note.body, "When I get home, pull in and merge everything from the Hub.");
});

test("writeNoteBody keeps a transcript group when replacing", function () {
  const note = {
    type: "note",
    blocks: [
      { id: "p1", type: "text", text: "", html: "" },
      { id: "g1", type: "group", title: "Transcribed audio", text: "raw ramble" }
    ]
  };
  sandbox.writeNoteBody(note, "Cleaned up todo.", "replace");
  assert.equal(note.blocks[0].text, "Cleaned up todo.");
  assert.equal(note.blocks[1].type, "group");
  assert.equal(note.blocks[1].text, "raw ramble");
});

test("insertAfterTarget fills the empty placeholder instead of adding a second paragraph", function () {
  const note = { type: "note", todo: true, blocks: [{ id: "p1", type: "text", text: "", html: "" }] };
  sandbox.insertAfterTarget(note, "end", "When I get home, pull in and merge everything from the Hub.", "paragraph", {});
  assert.equal(note.blocks.length, 1);
  assert.equal(note.blocks[0].id, "p1");
  assert.equal(note.blocks[0].text, "When I get home, pull in and merge everything from the Hub.");
});

test("looksLikeNoteWriteClaim catches I-added replies", function () {
  assert.equal(sandbox.looksLikeNoteWriteClaim("Yes, it's done now. I added: 'When I get home, pull in and merge everything from the Hub.'"), true);
  assert.equal(sandbox.looksLikeNoteWriteClaim("I can help with that tomorrow."), false);
});
