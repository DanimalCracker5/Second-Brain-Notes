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

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(grab("menuFit", "menuScrollBody"), sandbox, { filename: "menuFit" });

test("menuFit clamps a tall menu to the space below a top-of-screen button", function () {
  const fit = sandbox.menuFit({ top: 80, bottom: 120, left: 16, width: 36 }, 900, 390, 700, 240);
  assert.equal(fit.flipped, false);
  assert.ok(fit.maxH <= 700 - 120 - 6 - 10, "max height must fit under the button");
  assert.ok(fit.maxH >= 120);
  assert.ok(fit.top + fit.height <= 700 - 10, "bottom edge stays on-screen");
  assert.ok(fit.left >= 10);
});

test("menuFit flips above when the button is near the bottom", function () {
  const fit = sandbox.menuFit({ top: 620, bottom: 660, left: 16, width: 36 }, 400, 390, 700, 240);
  assert.equal(fit.flipped, true);
  assert.ok(fit.top >= 10);
  assert.ok(fit.top + fit.height <= 620 - 6, "flipped menu stays above the button");
  assert.ok(fit.maxH < 400 || fit.height <= fit.maxH);
});

test("menuFit never reports a viewport taller than the phone itself", function () {
  const fit = sandbox.menuFit({ top: 300, bottom: 340, left: 8, width: 36 }, 2000, 390, 667, 240);
  assert.ok(fit.maxH <= 667 - 20);
  assert.ok(fit.height <= fit.maxH);
});

test("floating menus scroll inside an inner pane", function () {
  const cssStart = html.indexOf("/* ---------- floating menu ---------- */");
  const css = html.slice(cssStart, html.indexOf("/* ---------- due-date calendar ---------- */"));
  assert.match(css, /\.menu-body\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.menu\{[^}]*max-height:/);
  assert.match(grab("openMenu", "mkItem"), /wrapMenuBody\(m\)/);
});

test("note pencil menu nests AI handoff and backups behind submenus", function () {
  const src = grab("showItemActions", "convertNoteTodo");
  assert.match(src, /view==="ai"/);
  assert.match(src, /view==="backup"/);
  assert.match(src, /Bring into AI/);
  assert.match(src, /Document backup/);
  assert.match(src, /Hide from notes list/);
  const chatgpt = src.indexOf('mkItem(ICON_SPARK,"ChatGPT"');
  const aiView = src.indexOf('view==="ai"');
  assert.ok(chatgpt > aiView, "ChatGPT belongs in the AI submenu, not the root list");
});

function drawerHtml() {
  const from = html.indexOf('<aside class="drawer">');
  const to = html.indexOf('<div class="main">');
  assert.ok(from >= 0 && to > from, "drawer markup missing");
  return html.slice(from, to);
}

test("sidebar search sits above the tags, types, and notes carets", function () {
  const drawer = drawerHtml();
  const searchAt = drawer.indexOf('id="noteSearchWrap"');
  const tagsAt = drawer.indexOf('id="tagsToggleBtn"');
  const typesAt = drawer.indexOf('id="typesToggleBtn"');
  const notesAt = drawer.indexOf('id="notesToggleBtn"');
  assert.ok(searchAt >= 0 && tagsAt > searchAt, "search belongs above tags");
  assert.ok(typesAt > tagsAt, "types follow tags");
  assert.ok(notesAt > typesAt, "all notes follows types");
});

test("all notes section has a collapse caret like tags and types", function () {
  const drawer = drawerHtml();
  assert.match(drawer, /id="notesToggleBtn"[^>]*aria-controls="notesListWrap"/);
  assert.match(drawer, /id="notesToggleBtn"[\s\S]*<span id="listLabel">All notes<\/span>[\s\S]*<path d="m6 9 6 6 6-6"\/>/);
  assert.match(drawer, /id="notesListWrap"/);
});

test("sidebar exposes a bulk delete control for selected notes", function () {
  const drawer = drawerHtml();
  assert.match(drawer, /id="selectNotesBtn"/);
  assert.match(drawer, /id="deleteNotesBtn"/);
  assert.match(grab("deleteSelectedNotes", "delItem"), /Unlock these items before deleting them/);
  assert.match(grab("openListTools", "prepareManualOrder"), /Select all in this list/);
});

function deleteSandbox() {
  const box = {
    state: {
      items: [
        { id: "a", title: "Keep", locked: false },
        { id: "b", title: "Delete me", locked: false },
        { id: "c", title: "Locked", locked: true },
        { id: "d", title: "Also delete", locked: false }
      ],
      selectedItemIds: ["b", "c", "d"],
      selectingNotes: true,
      tagAssignMode: false,
      currentId: "b"
    },
    activeAudioRecorder: null,
    confirm: function () { return true; },
    captureAutoBackup: function () {},
    forEachItemContentDocument: function () {},
    cleanupContentAttachments: function () {},
    recordDeletedItem: function (item) { box.deleted.push(item.id); },
    newNoteItem: function () { return { id: "seed", title: "Untitled" }; },
    visibleItems: function () { return box.state.items; },
    persist: function () { box.persisted = true; },
    renderList: function () {},
    renderMain: function () { box.rerendered = true; },
    showToast: function (message) { box.toast = message; },
    deleted: [],
    persisted: false,
    rerendered: false,
    toast: ""
  };
  vm.createContext(box);
  vm.runInContext(grab("deleteSelectedNotes", "delItem"), box, { filename: "deleteSelectedNotes" });
  return box;
}

test("deleteSelectedNotes removes unlocked selected notes and skips locked ones", function () {
  const box = deleteSandbox();
  box.deleteSelectedNotes();
  assert.deepEqual(box.state.items.map(function (item) { return item.id; }), ["a", "c"]);
  assert.deepEqual(box.deleted, ["b", "d"]);
  assert.equal(box.state.currentId, "a");
  assert.equal(box.state.selectingNotes, false);
  assert.deepEqual(box.state.selectedItemIds, []);
  assert.equal(box.persisted, true);
  assert.equal(box.rerendered, true);
  assert.equal(box.toast, "Deleted 2 notes");
});

test("deleteSelectedNotes leaves notes alone when confirm is cancelled", function () {
  const box = deleteSandbox();
  box.confirm = function () { return false; };
  box.deleteSelectedNotes();
  assert.deepEqual(box.state.items.map(function (item) { return item.id; }), ["a", "b", "c", "d"]);
  assert.equal(box.state.selectingNotes, true);
  assert.equal(box.persisted, false);
});
