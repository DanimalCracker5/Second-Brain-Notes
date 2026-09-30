"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function grab(name) {
  const marker = "\n  function " + name + "(";
  const from = html.indexOf(marker);
  assert.ok(from >= 0, "missing " + name);
  const end = html.indexOf("\n  }", from);
  assert.ok(end > from, "missing end of " + name);
  return html.slice(from + 1, end + 4);
}

const sandbox = {
  cleanText: function (value) { return typeof value === "string" ? value.trim() : ""; }
};
vm.createContext(sandbox);
[
  "promptStatuses",
  "normalizePromptStatus",
  "promptStatusLabel",
  "effectivePromptStatus",
  "sanitizePromptStatusCollapsed",
  "promptPreview",
  "promptReading",
  "collectItemPrompts",
  "promptHubGroups",
  "parsePromptWriterReply"
].forEach(function (name) {
  vm.runInContext(grab(name), sandbox, { filename: name });
});

function note(id, title, blocks, extra) {
  return Object.assign({ id: id, title: title, updated: 1, blocks: blocks }, extra || {});
}

test("prompt statuses stay in stage order", function () {
  assert.deepEqual(sandbox.promptStatuses().map(function (status) { return status.label; }), [
    "Brainstorming",
    "Draft",
    "Ready To Run",
    "Attempted",
    "Complete"
  ]);
});

test("status aliases normalize and unknown values do not", function () {
  assert.equal(sandbox.normalizePromptStatus(" Ready To Run "), "ready");
  assert.equal(sandbox.normalizePromptStatus("completed"), "complete");
  assert.equal(sandbox.normalizePromptStatus("brainstorm"), "brainstorming");
  assert.equal(sandbox.normalizePromptStatus("nope"), "");
  assert.equal(sandbox.effectivePromptStatus({ status: "" }), "draft");
  assert.equal(sandbox.effectivePromptStatus({ status: "attempted" }), "attempted");
});

test("the hub omits empty prompts and statuses nobody is using", function () {
  const groups = sandbox.promptHubGroups([
    note("empty", "Blank", [{ id: "p0", type: "prompt", text: "   ", status: "complete" }]),
    note("drafted", "Schrodinger", [{ id: "p1", type: "prompt", text: "Cull distant characters.", status: "draft" }], { updated: 5 }),
    note("older", "Cities", [{ id: "p2", type: "prompt", text: "Show a menu of culled characters." }], { updated: 2 }),
    note("plain", "No prompt", [{ id: "t1", type: "text", text: "Just a note" }])
  ]);
  assert.deepEqual(groups.map(function (group) { return group.id; }), ["draft"]);
  assert.deepEqual(groups[0].prompts.map(function (entry) { return entry.itemId; }), ["drafted", "older"]);
  assert.equal(groups[0].prompts[1].status, "draft");
  assert.match(groups[0].prompts[0].preview, /Cull distant/);
});

test("a note shows under every status that has one of its prompts", function () {
  const groups = sandbox.promptHubGroups([
    note("mix", "Cat mode", [
      { id: "a", type: "prompt", text: "Still thinking", status: "brainstorming" },
      { id: "b", type: "prompt", text: "Ready for Cursor", status: "ready" },
      { id: "c", type: "prompt", text: "Second ready prompt", status: "ready to run" }
    ]),
    note("done", "Finished", [{ id: "d", type: "prompt", text: "Shipped", status: "complete" }])
  ]);
  assert.deepEqual(groups.map(function (group) { return group.label; }), ["Brainstorming", "Ready To Run", "Complete"]);
  const ready = groups.filter(function (group) { return group.id === "ready"; })[0];
  assert.equal(ready.prompts.length, 2);
  assert.deepEqual(ready.prompts.map(function (entry) { return entry.blockId; }), ["b", "c"]);
  assert.ok(!groups.some(function (group) { return group.id === "draft" || group.id === "attempted"; }));
});

test("an unapproved brainstorm prompt stays out of the hub until it is published", function () {
  const hidden = sandbox.promptHubGroups([
    note("brain", "Private", [{
      id: "p",
      type: "prompt",
      text: "Secret draft",
      status: "attempted",
      brainstorm: true,
      brainstormNew: true
    }])
  ]);
  assert.deepEqual(hidden, []);
  const published = sandbox.promptHubGroups([
    note("brain", "Private", [{
      id: "p",
      type: "prompt",
      text: "Secret draft",
      status: "attempted",
      brainstorm: true,
      approved: { text: "The approved prompt", status: "complete" }
    }])
  ]);
  assert.equal(published.length, 1);
  assert.equal(published[0].id, "complete");
  assert.equal(published[0].prompts[0].preview, "The approved prompt");
  const open = sandbox.promptHubGroups([
    note("brain", "Private", [{
      id: "p",
      type: "prompt",
      text: "Secret draft",
      status: "attempted",
      brainstorm: true
    }], { brainstorming: true })
  ]);
  assert.equal(open[0].id, "attempted");
  assert.equal(open[0].prompts[0].preview, "Secret draft");
});

test("prompt replies parse questions and a finished prompt", function () {
  const fenced = sandbox.parsePromptWriterReply("```json\n{\"questions\":[\"Who is the menu for?\"],\"prompt\":\"\"}\n```");
  assert.deepEqual(fenced.questions, ["Who is the menu for?"]);
  assert.equal(fenced.prompt, "");
  const objects = sandbox.parsePromptWriterReply("Sure.\n{\"questions\":[{\"text\":\"Which characters?\"},{\"question\":\"Which characters?\"}],\"prompt\":\"Write the menu.\"}");
  assert.deepEqual(objects.questions, ["Which characters?"]);
  assert.equal(objects.prompt, "Write the menu.");
  assert.equal(sandbox.parsePromptWriterReply("not json"), null);
});

test("sidebar prompts caret sits between types and notes and starts hidden", function () {
  const drawerFrom = html.indexOf('<aside class="drawer">');
  const drawerTo = html.indexOf('<div class="main">');
  const drawer = html.slice(drawerFrom, drawerTo);
  const typesAt = drawer.indexOf('id="typesToggleBtn"');
  const promptsAt = drawer.indexOf('id="promptsSection"');
  const notesAt = drawer.indexOf('id="notesToggleBtn"');
  assert.ok(promptsAt > typesAt, "prompts follow types");
  assert.ok(notesAt > promptsAt, "notes follow prompts");
  assert.match(drawer, /id="promptsSection"[^>]*hidden/);
  assert.match(drawer, /id="promptsToggleBtn"[^>]*aria-controls="promptsHub"/);
  assert.match(drawer, /id="promptsHub" hidden/);
  assert.match(html, /id="openrouterKey"/);
  assert.match(html, /id="promptQuestionsModal"/);
  assert.match(grab("buildNotePrompt"), /statusBtn\.hidden=!filled/);
  assert.match(grab("buildNotePrompt"), /startPromptWriter/);
  assert.match(grab("renderPromptHub"), /promptHubGroups/);
  assert.match(grab("renderList"), /renderPromptHub\(\)/);
});
