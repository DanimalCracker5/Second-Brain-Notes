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
  [grab("homeWidgetCatalog", "defaultHomeLayout"),
   grab("defaultHomeLayout", "normalizeHomeLayout"),
   grab("normalizeHomeLayout", "homeLayout"),
   grab("homeLayout", "homeWidgetOn"),
   grab("homeWidgetOn", "homeWidgetDef")].join("\n"),
  sandbox,
  { filename: "home-layout" }
);

test("a fresh home shows the notes list and nothing else", function () {
  assert.deepEqual(sandbox.defaultHomeLayout().widgets, [{ type: "notes", enabled: true }]);
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

test("normalizeHomeLayout puts the notes list back on when it is missing", function () {
  const layout = sandbox.normalizeHomeLayout({ widgets: [{ type: "glance", enabled: true }] });
  assert.deepEqual(layout.widgets[0], { type: "notes", enabled: true });
  assert.equal(layout.widgets[1].type, "glance");
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
