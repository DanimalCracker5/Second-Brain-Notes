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
