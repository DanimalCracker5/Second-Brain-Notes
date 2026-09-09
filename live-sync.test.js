"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const shared = fs.readFileSync(path.join(__dirname, "shared.html"), "utf8");
const rules = fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8");
const storageRules = fs.readFileSync(path.join(__dirname, "storage.rules"), "utf8");
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
  cloneData: function (value) { return JSON.parse(JSON.stringify(value || {})); }
};
vm.createContext(sandbox);
[
  ["stableStringify", "itemSyncSignature"],
  ["itemSyncSignature", "buildSyncBaseline"],
  ["itemRevision", "mergeTombstones"],
  ["canStructurallyMergeItems", "useData"]
].forEach(function (pair) {
  vm.runInContext(grab(pair[0], pair[1]), sandbox, { filename: pair[0] });
});

function note(id, blocks, attachments, extra) {
  const item = {
    id: id,
    type: "note",
    title: extra && extra.title || "Note",
    blocks: blocks || [],
    attachments: attachments || [],
    version: extra && extra.version || 1,
    versionChangedAt: extra && extra.versionChangedAt || 1,
    updated: extra && extra.updated || 1
  };
  if (extra && extra.shareId) item.shareId = extra.shareId;
  if (extra && extra.shareAllowEdit) item.shareAllowEdit = true;
  return item;
}

test("mergeKeyedRecords keeps a protected local block and adds a remote photo block", function () {
  const local = [
    { id: "a", type: "text", text: "typing on phone" },
    { id: "b", type: "text", text: "unchanged" }
  ];
  const remote = [
    { id: "a", type: "text", text: "old" },
    { id: "b", type: "text", text: "unchanged" },
    { id: "p", type: "attachment", attachmentId: "pic" }
  ];
  const merged = sandbox.mergeKeyedRecords(local, remote, { protectIds: { a: true }, preferLocal: false });
  assert.equal(merged[0].text, "typing on phone");
  assert.equal(merged.some(function (block) { return block.id === "p"; }), true);
});

test("mergeLiveItems unions a laptop photo onto a note the phone is still editing", function () {
  const local = note("n1", [
    { id: "a", type: "text", text: "hello from phone", html: "hello from phone" }
  ], [], { version: 4, versionChangedAt: 40, updated: 40, title: "Trip" });
  const remote = note("n1", [
    { id: "a", type: "text", text: "hello", html: "hello" },
    { id: "p", type: "attachment", attachmentId: "img1" }
  ], [
    { id: "img1", name: "lake.jpg", type: "image/jpeg", storagePath: "users/u/notes/n1/attachments/img1" }
  ], { version: 5, versionChangedAt: 50, updated: 50, title: "Trip" });
  const merged = sandbox.mergeLiveItems(local, remote, { preferLocal: true, protectBlockIds: { a: true } });
  assert.equal(merged.blocks[0].text, "hello from phone");
  assert.equal(merged.attachments.length, 1);
  assert.equal(merged.attachments[0].id, "img1");
  assert.equal(merged.blocks.some(function (block) { return block.id === "p"; }), true);
});

test("applyIncomingItemOnto mutates the local note in place so the open editor keeps its object", function () {
  const local = note("n1", [{ id: "a", type: "text", text: "one" }], [], { version: 1 });
  const remote = note("n1", [
    { id: "a", type: "text", text: "one" },
    { id: "b", type: "text", text: "two" }
  ], [], { version: 2, versionChangedAt: 2, updated: 2 });
  const same = local;
  const result = sandbox.applyIncomingItemOnto(local, remote, { preferLocal: false });
  assert.equal(result.changed, true);
  assert.equal(result.writeBack, false);
  assert.equal(same, local);
  assert.equal(local.blocks.length, 2);
  assert.equal(local.blocks[1].text, "two");
});

test("share menu offers an iOS-style Allow editing toggle", function () {
  const src = grab("openPublicShareOptions", "showToast");
  assert.match(src, /Allow editing/);
  assert.match(src, /m-toggle/);
  assert.match(src, /shareAllowEdit/);
  assert.match(html, /\.menu \.m-toggle/);
});

test("public shares carry allowEdit and a live updatedBy token", function () {
  const payload = grab("publicSharePayload", "publishPublicShare");
  assert.match(payload, /allowEdit:!!item\.shareAllowEdit/);
  assert.match(payload, /updatedBy:liveClientId/);
});

test("same-account live notes and shared editing are allowed in Firebase rules", function () {
  assert.match(rules, /match \/liveNotes\/\{noteId\}/);
  assert.match(rules, /resource\.data\.allowEdit == true/);
  assert.match(storageRules, /match \/shares\/\{shareId\}/);
});

test("shared page listens live and can edit when allowEdit is on", function () {
  assert.match(shared, /onSnapshot/);
  assert.match(shared, /allowEdit/);
  assert.match(shared, /Sign in to edit/);
  assert.match(shared, /Add photo/);
  assert.match(shared, /firebase-auth-compat/);
  assert.match(shared, /firebase-storage-compat/);
});
