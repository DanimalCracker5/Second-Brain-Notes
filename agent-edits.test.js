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
  ["emptyPlaceholderTextBlock", "noteBodyIsVisuallyEmpty"],
  ["noteBodyIsVisuallyEmpty", "writeNoteBody"],
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
vm.runInContext(grab("looksLikeEditCapabilityQuestion", "collabApiMessages"), sandbox, { filename: "looksLikeEditCapabilityQuestion" });
sandbox.collab = { pendingDictation: "" };
sandbox.collabConversation = function () { return sandbox._chatLog || []; };
sandbox.itemText = function (it) { return (it && it.body) || ((it && it.blocks) || []).map(function (b) { return b.text || ""; }).join("\n"); };

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
  assert.equal(sandbox.looksLikeNoteWriteClaim("Got it — I'll turn the note into a simple reminder to buy something sweet."), true);
  assert.equal(sandbox.looksLikeNoteWriteClaim("I can help with that tomorrow."), false);
});

test("looksLikeNoteWriteRequest catches change-it and that's-the-whole-note", function () {
  assert.equal(sandbox.looksLikeNoteWriteRequest("Change it; that's what I asked you to do, isn't it?"), true);
  assert.equal(sandbox.looksLikeNoteWriteRequest("That's the whole note."), true);
  assert.equal(sandbox.looksLikeNoteWriteRequest("What's the weather?"), false);
});

test("fallbackNoteWriteText skips meta follow-ups and uses the dictated wording", function () {
  const log = [
    { role: "user", text: "Buy something sweet when I get home." },
    { role: "assistant", text: "I'll turn the note into a reminder." },
    { role: "user", text: "That's the whole note." },
    { role: "user", text: "Did you write that?" },
    { role: "user", text: "Change it." }
  ];
  assert.equal(sandbox.fallbackNoteWriteText(log), "Buy something sweet when I get home.");
});

test("noteBodyIsVisuallyEmpty treats an empty paragraph as empty even with a transcript group", function () {
  const empty = { type: "note", blocks: [{ id: "p1", type: "text", text: "", html: "" }] };
  const withTranscript = {
    type: "note",
    blocks: [
      { id: "p1", type: "text", text: "", html: "" },
      { id: "g1", type: "group", title: "Transcribed audio", text: "raw ramble" }
    ]
  };
  const filled = { type: "note", blocks: [{ id: "p1", type: "text", text: "Buy sweets", html: "Buy sweets" }] };
  assert.equal(sandbox.noteBodyIsVisuallyEmpty(empty), true);
  assert.equal(sandbox.noteBodyIsVisuallyEmpty(withTranscript), true);
  assert.equal(sandbox.noteBodyIsVisuallyEmpty(filled), false);
});

test("shouldForceNoteWrite treats follow-ups on an empty note as a write", function () {
  const empty = { type: "note", blocks: [{ id: "p1", type: "text", text: "", html: "" }] };
  assert.equal(sandbox.shouldForceNoteWrite(empty, "Change it."), true);
  assert.equal(sandbox.shouldForceNoteWrite(empty, "Did you write that?"), true);
  assert.equal(sandbox.shouldForceNoteWrite(empty, "Note that the shared tasks list is excessive"), true);
  assert.equal(sandbox.shouldForceNoteWrite(empty, "Please. Prototype an intro / hook"), true);
  assert.equal(sandbox.shouldForceNoteWrite(empty, "What's the weather?"), false);
  assert.equal(sandbox.shouldForceNoteWrite(empty, "Why"), false);
});

test("short tone answers are not treated as note content", function () {
  sandbox._chatLog = [
    { role: "user", text: "Please. Prototype an intro / hook" },
    { role: "assistant", text: "What tone should the hook have—cinematic, casual, or energetic?" },
    { role: "user", text: "Casual" }
  ];
  sandbox.collab.pendingDictation = "";
  assert.equal(sandbox.looksLikeGenerativeNoteRequest("Please. Prototype an intro / hook"), true);
  assert.equal(sandbox.looksLikeClarifyingAnswer("Casual"), true);
  assert.equal(sandbox.looksLikeDirectNoteContent("Casual"), false);
  assert.equal(sandbox.looksLikeDirectNoteContent("Please. Prototype an intro / hook"), false);
  assert.equal(sandbox.looksLikeDirectNoteContent("Note that the shared tasks list is excessive"), true);
  assert.equal(sandbox.fallbackNoteWriteText(sandbox._chatLog), "");
  assert.equal(sandbox.recentGenerativeNoteRequest(sandbox._chatLog), true);
  assert.equal(sandbox.shouldForceNoteWrite({ type: "note", blocks: [{ id: "p1", type: "text", text: "", html: "" }] }, "Casual"), true);
});

test("looksLikeNoteToolDenial catches the Luna refusal", function () {
  assert.equal(sandbox.looksLikeNoteToolDenial("I'm unable to access the note-editing tool in this chat."), true);
  assert.equal(sandbox.looksLikeNoteToolDenial("I can't call the editing tool because it isn't exposed in this chat's available tools."), true);
  assert.equal(sandbox.looksLikeNoteToolDenial("I'm sorry, but I can't access the note-editing action in this turn."), true);
  assert.equal(sandbox.looksLikeNoteToolDenial("It's in the note now."), false);
});

test("capability questions are not dumped into the note", function () {
  const empty = { type: "note", blocks: [{ id: "p1", type: "text", text: "", html: "" }] };
  assert.equal(sandbox.looksLikeEditCapabilityQuestion("What bro can you edit it or not"), true);
  assert.equal(sandbox.looksLikeNoteWriteRequest("What bro can you edit it or not"), false);
  assert.equal(sandbox.looksLikeDirectNoteContent("What bro can you edit it or not"), false);
  sandbox._chatLog = [
    { role: "user", text: "Please. Prototype an intro / hook" },
    { role: "assistant", text: "What tone should the hook have?" },
    { role: "user", text: "Casual" },
    { role: "user", text: "Make a better hook" },
    { role: "user", text: "What bro can you edit it or not" }
  ];
  sandbox.collab.pendingDictation = "";
  assert.equal(sandbox.fallbackNoteWriteText(sandbox._chatLog), "");
  assert.equal(sandbox.lastGenerativeNoteRequest(sandbox._chatLog), "Make a better hook");
  assert.equal(sandbox.shouldForceNoteWrite(empty, "What bro can you edit it or not"), true);
  assert.equal(sandbox.looksLikeEchoedUserText("What bro can you edit it or not", "What bro can you edit it or not"), true);
  assert.equal(sandbox.extractDraftedNoteCopy("I'm sorry, but I can't access the note-editing action in this turn.", "Make a better hook"), "");
  assert.equal(sandbox.extractDraftedNoteCopy("A kid finds a cartridge labeled First Look and the screen never loads.", "Make a better hook"), "A kid finds a cartridge labeled First Look and the screen never loads.");
});

test("looksLikeCasualChat leaves real note content alone", function () {
  assert.equal(sandbox.looksLikeCasualChat("Why"), true);
  assert.equal(sandbox.looksLikeCasualChat("What's the weather?"), true);
  assert.equal(sandbox.looksLikeCasualChat("Note that the shared tasks list is excessive"), false);
});
