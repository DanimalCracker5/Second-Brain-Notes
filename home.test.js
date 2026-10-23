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

const sandbox = { state: {} };
vm.createContext(sandbox);
vm.runInContext(
  [grab("homeWidgetCatalog", "homeStarterWidgets"),
   grab("homeStarterWidgets", "defaultHomeLayout"),
   grab("defaultHomeLayout", "normalizeHomeLayout"),
   grab("normalizeHomeLayout", "homeLayout"),
   grab("homeLayout", "homeWidgetOn"),
   grab("homeWidgetOn", "homeWidgetDef")].join("\n"),
  sandbox,
  { filename: "home-layout" }
);

test("a fresh home puts widgets first and the notes list last", function () {
  const widgets = sandbox.defaultHomeLayout().widgets;
  const types = widgets.map(function (widget) { return widget.type; });
  assert.deepEqual(types.slice(0, -1), sandbox.homeStarterWidgets());
  assert.equal(types[types.length - 1], "notes");
  assert.ok(widgets.every(function (widget) { return widget.enabled === true; }));
  ["todos", "search", "revisit", "time", "today", "done", "types", "scratch", "agents"].forEach(function (type) {
    assert.ok(types.indexOf(type) >= 0, type);
  });
});

test("homeWidgetOn reads the saved notes toggle", function () {
  sandbox.state = { homeLayout: { widgets: [{ type: "notes", enabled: false }] } };
  assert.equal(sandbox.homeWidgetOn("notes"), false);
  sandbox.state = { homeLayout: sandbox.defaultHomeLayout() };
  assert.equal(sandbox.homeWidgetOn("notes"), true);
});

test("normalizeHomeLayout keeps a turned-off notes list and drops unknown widgets", function () {
  const layout = sandbox.normalizeHomeLayout({
    widgets: [
      { type: "bogus", enabled: true },
      { type: "capture", enabled: true },
      { type: "notes", enabled: false },
      { type: "notes", enabled: true },
      { type: "nope" }
    ]
  });
  assert.deepEqual(layout.widgets, [
    { type: "capture", enabled: true },
    { type: "notes", enabled: false }
  ]);
});

test("normalizeHomeLayout puts the notes list last when it is missing", function () {
  const layout = sandbox.normalizeHomeLayout({
    widgets: [
      { type: "notes", enabled: true },
      { type: "glance", enabled: true },
      { type: "capture", enabled: false }
    ]
  });
  assert.deepEqual(layout.widgets.map(function (widget) { return widget.type; }), ["glance", "capture", "notes"]);
  assert.equal(layout.widgets[2].enabled, true);
  const missing = sandbox.normalizeHomeLayout({ widgets: [{ type: "glance", enabled: true }] });
  assert.equal(missing.widgets[missing.widgets.length - 1].type, "notes");
  assert.equal(missing.widgets[missing.widgets.length - 1].enabled, true);
  assert.equal(missing.widgets[0].type, "glance");
});

test("ensureHomeExtras adds the new widgets once and leaves later removals alone", function () {
  sandbox.state = {
    homeLayout: { widgets: [{ type: "capture", enabled: true }, { type: "notes", enabled: true }] }
  };
  assert.equal(sandbox.ensureHomeExtras(), true);
  const types = sandbox.state.homeLayout.widgets.map(function (widget) { return widget.type; });
  assert.equal(types[0], "capture");
  assert.equal(types[types.length - 1], "notes");
  assert.ok(types.indexOf("todos") > 0 && types.indexOf("todos") < types.length - 1);
  assert.equal(sandbox.state.homeExtrasVersion, 1);
  sandbox.state.homeLayout.widgets = sandbox.state.homeLayout.widgets.filter(function (widget) { return widget.type !== "todos"; });
  assert.equal(sandbox.ensureHomeExtras(), false);
  assert.ok(!sandbox.state.homeLayout.widgets.some(function (widget) { return widget.type === "todos"; }));
});

test("opening the site starts on home instead of a note", function () {
  assert.match(html, /var viewingHome=true/);
  const render = grab("renderMain", "buildWorkoutRoutine");
  const homeAt = render.indexOf("if(viewingHome)");
  const noteAt = render.indexOf("var it=current()");
  assert.ok(homeAt >= 0 && noteAt > homeAt, "home is rendered before the open note");
  assert.match(grab("revealItem", "syncHomeButton"), /viewingHome=false/);
  assert.match(grab("createItem", "openNewFolder"), /revealItem\(it\.id\)/);
});

test("home has a notes-list toggle and a way back from a note", function () {
  assert.match(html, /id="homeBtn"/);
  assert.match(html, /id="homeBrand"/);
  assert.match(html, /id="homeNotesToggle"/);
  assert.match(html, /Notes list/);
  assert.match(grab("buildHomeHeader", "buildHomeNoteRow"), /setHomeWidgetEnabled\("notes"/);
  assert.match(grab("buildHomeAddPanel", "renderHome"), /Add a widget/);
  assert.match(html, /data-home-widget/);
});

test("home notes honor tag, type, status, and search filters, then the chosen sort", function () {
  const box = {
    homeQuery: "",
    homeTypeFilter: "",
    homeTagId: null,
    homeStatusStage: null,
    homeStatusFilter: "",
    state: {
      listSort: "title",
      tags: [
        { id: "t1", name: "Work", hidden: false },
        { id: "t2", name: "Quiet", hidden: true }
      ],
      items: [
        { id: "a", title: "Bravo", type: "note", hidden: false, tagIds: ["t1"], updated: 2, text: "unique-body" },
        { id: "b", title: "Alpha", type: "todo", hidden: false, tagIds: [], updated: 5, done: false, dueDate: "2000-01-01", text: "" },
        { id: "c", title: "Charlie", type: "todo", hidden: false, tagIds: ["t1"], updated: 3, done: true, text: "done" },
        { id: "d", title: "Hidden tag", type: "note", hidden: false, tagIds: ["t2"], updated: 9, text: "" },
        { id: "e", title: "Secret", type: "note", hidden: true, tagIds: ["t1"], updated: 8, text: "" }
      ]
    },
    isInTrash: function () { return false; },
    itemKindForAgent: function (it) { return it.type === "todo" ? "todo" : "note"; },
    isTodoNote: function (it) { return it.type === "todo"; },
    itemDueDate: function (it) { return it.dueDate || ""; },
    dueDateClass: function (value) { return value === "2000-01-01" ? "overdue" : ""; },
    tagById: function (id) { return box.state.tags.filter(function (tag) { return tag.id === id; })[0]; },
    itemText: function (it) { return it.text || ""; },
    firstTagName: function () { return ""; }
  };
  vm.createContext(box);
  vm.runInContext(
    [grab("homeNoteVisible", "homeNotes"), grab("homeNotes", "homeContinueItem")].join("\n"),
    box,
    { filename: "home-notes-filter" }
  );
  const ids = function () { return box.homeNotes().map(function (it) { return it.id; }); };
  assert.deepEqual(ids(), ["b", "a", "c"]);
  box.homeTagId = "t1";
  assert.deepEqual(ids(), ["a", "c"]);
  box.homeTypeFilter = "todo";
  assert.deepEqual(ids(), ["c"]);
  box.homeTagId = null;
  box.homeTypeFilter = "";
  box.homeStatusFilter = "overdue";
  assert.deepEqual(ids(), ["b"]);
  box.homeStatusFilter = "due";
  assert.deepEqual(ids(), ["b"]);
  box.homeStatusFilter = "done";
  assert.deepEqual(ids(), ["c"]);
  box.homeStatusFilter = "open";
  assert.deepEqual(ids(), ["b"]);
  box.homeStatusFilter = "";
  box.homeQuery = "unique-body";
  assert.deepEqual(ids(), ["a"]);
  box.homeQuery = "";
  box.state.listSort = "updated";
  assert.deepEqual(ids(), ["b", "c", "a"]);
});

test("the home notes list has a horizontal tag rail, filters, and sorting", function () {
  const toolbar = grab("buildHomeNotesToolbar", "restoreHomeTagRail");
  const widget = grab("buildHomeNotesWidget", "addHomeCapture");
  assert.match(toolbar, /id="homeTagRail"/);
  assert.match(toolbar, /Filter by tag/);
  assert.match(toolbar, /Filter notes/);
  assert.match(toolbar, /id="homeNotesSort"/);
  assert.match(toolbar, /setHomeNotesTag\(tag\.id\)/);
  assert.match(toolbar, /setHomeNotesType\(row\[0\]\)/);
  assert.match(toolbar, /setHomeNotesStatus\(row\[0\]\)/);
  assert.match(toolbar, /setListSort\(select\.value\)/);
  assert.match(widget, /buildHomeNotesToolbar\(\)/);
  assert.match(html, /\.home-tag-rail\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(html, /\.home-tag-rail\{[^}]*overflow-x:\s*auto/);
  assert.match(grab("restoreHomeTagRail", "buildHomeNotesWidget"), /right-rail\.clientWidth\+12/);
  assert.match(grab("renderHome", "renderMain"), /restoreHomeTagRail\(sheet\.querySelector\("#homeTagRail"\)\)/);
  assert.match(grab("buildHomeTagsWidget", "buildHomeGlanceWidget"), /setHomeNotesTag\(tag\.id\)/);
  assert.match(grab("buildHomeTypesWidget", "buildHomeScratchWidget"), /setHomeNotesType\(kind\)/);
});

test("the notes list is rendered under the widget grid", function () {
  const from = html.indexOf("  function renderHome(");
  const to = html.indexOf("  var lastMainId=", from);
  assert.ok(from >= 0 && to > from);
  const render = html.slice(from, to);
  const gridAt = render.indexOf('grid.className="home-grid"');
  const filterAt = render.indexOf('widget.type!=="notes"');
  const slotAt = render.indexOf('slot.className="home-notes-slot"');
  assert.ok(gridAt >= 0 && filterAt > gridAt && slotAt > filterAt);
  assert.ok(render.indexOf("sheet.appendChild(grid)") < render.indexOf("sheet.appendChild(slot)"));
  assert.match(grab("moveHomeWidget", "removeHomeWidget"), /type==="notes"/);
});

test("picking a tag on home opens that tag's notes without the widgets", function () {
  const open = grab("setHomeNotesTag", "setHomeNotesType");
  assert.match(open, /homeTagId=homeTagId===id\?null:id/);
  assert.match(open, /state\.filterTag=homeTagId/);
  assert.match(open, /renderMain\(\)/);
  const box = {
    homeTagId: null,
    state: { filterTag: null, sidebarView: "hidden" },
    renderList: function () { box.listed = (box.listed || 0) + 1; },
    renderMain: function () { box.mains = (box.mains || 0) + 1; }
  };
  vm.createContext(box);
  vm.runInContext(open, box, { filename: "set-home-notes-tag" });
  box.setHomeNotesTag("astral");
  assert.equal(box.homeTagId, "astral");
  assert.equal(box.state.filterTag, "astral");
  assert.equal(box.state.sidebarView, "all");
  assert.equal(box.mains, 1);
  box.setHomeNotesTag("astral");
  assert.equal(box.homeTagId, null);
  assert.equal(box.state.filterTag, null);
  const stage = grab("buildHomeTagStage", "renderHome");
  assert.match(stage, /buildHomeNotesToolbar\(true\)/);
  assert.match(stage, /buildHomeNoteRow\(it, entering\?index:null\)/);
  assert.match(stage, /Nothing matches\./);
  assert.match(grab("buildHomeNoteRow", "setHomeNotesTag"), /openHomeItem\(it\.id\)/);
  const header = grab("buildHomeTagStageHeader", "buildHomeTagStage");
  assert.match(header, /id="homeTagBack"/);
  assert.match(header, /showHome\(\)/);
  assert.match(header, /Open one, or go back home/);
  assert.match(header, /Nothing in this tag yet/);
  const render = grab("renderHome", "renderMain");
  const stageAt = render.indexOf("buildHomeTagStage(openTag, entering)");
  const gridAt = render.indexOf('grid.className="home-grid"');
  assert.ok(stageAt >= 0 && gridAt > stageAt, "the tag page is chosen before the widget grid");
  assert.match(render, /sheet\.classList\.add\("tag-stage"\)/);
  assert.match(render, /if\(openTag\)\{[\s\S]*return;/);
  assert.match(html, /\.home-sheet\.tag-stage::before/);
  assert.match(html, /\.tag-stage \.home-notes\.enter \.home-note\{[^}]*animation:fadeUp/);
});

test("homeOpenTag drops a tag that no longer exists", function () {
  const box = {
    homeTagId: "t1",
    tagById: function (id) { return id === "t1" ? { id: "t1", name: "Astral" } : null; }
  };
  vm.createContext(box);
  vm.runInContext(grab("homeOpenTag", "buildHomeTagStageHeader"), box, { filename: "home-open-tag" });
  assert.equal(box.homeOpenTag().name, "Astral");
  box.homeTagId = "gone";
  assert.equal(box.homeOpenTag(), null);
  assert.equal(box.homeTagId, null);
});

test("Home steps out of a tag back to the widgets, and out of a note back to that tag", function () {
  const box = {
    viewingHome: true,
    homeTagId: "astral",
    state: { filterTag: "astral" },
    activeAudioRecorder: null,
    renderList: function () { box.listed = (box.listed || 0) + 1; },
    renderMain: function () { box.mains = (box.mains || 0) + 1; },
    exitSidebarFocus: function () { box.exited = true; },
    app: { classList: { remove: function () { box.closed = true; } } }
  };
  vm.createContext(box);
  vm.runInContext(grab("showHome", "syncHomeTagFromSidebar"), box, { filename: "show-home" });
  box.showHome();
  assert.equal(box.homeTagId, null);
  assert.equal(box.state.filterTag, null);
  assert.equal(box.viewingHome, true);
  assert.equal(box.exited, undefined);
  assert.equal(box.mains, 1);
  box.viewingHome = false;
  box.homeTagId = "astral";
  box.state.filterTag = "other";
  box.showHome();
  assert.equal(box.homeTagId, "astral");
  assert.equal(box.state.filterTag, "other");
  assert.equal(box.viewingHome, true);
  assert.equal(box.exited, true);
});

test("a sidebar tag opened from home shows that tag on the page", function () {
  const box = {
    viewingHome: true,
    homeTagId: null,
    state: { filterTag: "astral" },
    app: {
      classList: {
        contains: function () { return box.focus; },
        remove: function (name) { box.removed = name; }
      }
    },
    focus: false,
    tagById: function (id) { return { id: id }; },
    usesOverlaySidebar: function () { return box.overlay; },
    overlay: true
  };
  vm.createContext(box);
  vm.runInContext(grab("syncHomeTagFromSidebar", "revealItem"), box, { filename: "sync-home-tag" });
  box.syncHomeTagFromSidebar();
  assert.equal(box.homeTagId, "astral");
  assert.equal(box.removed, "open");
  box.viewingHome = false;
  box.homeTagId = null;
  box.removed = null;
  box.viewingTagId = "stale";
  box.exitSidebarFocus = function () { box.exited = true; };
  box.syncHomeTagFromSidebar();
  assert.equal(box.viewingHome, true);
  assert.equal(box.homeTagId, "astral");
  assert.equal(box.viewingTagId, null);
  assert.equal(box.exited, true);
  assert.equal(box.removed, "open");
  box.viewingHome = false;
  box.state.filterTag = null;
  box.homeTagId = "keep";
  box.exited = false;
  box.removed = null;
  box.syncHomeTagFromSidebar();
  assert.equal(box.viewingHome, false);
  assert.equal(box.homeTagId, "keep");
  assert.equal(box.exited, false);
  box.viewingHome = true;
  box.homeTagId = null;
  box.state.filterTag = "astral";
  box.focus = true;
  box.syncHomeTagFromSidebar();
  assert.equal(box.homeTagId, null);
  assert.match(grab("renderTagChip", "renderTagCloud"), /syncHomeTagFromSidebar\(\)/);
  assert.match(grab("openListTools", "addSelectedNotesToTag"), /syncHomeTagFromSidebar\(\)/);
});
