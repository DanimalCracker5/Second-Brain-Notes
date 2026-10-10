"use strict";

/* Tests for the Queue view (sidebar entry, todos grouped by status) and the
   "Added by Assistant" origin badge on note/todo rows. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function grab(name, next) {
  const from = html.indexOf("  " + name);
  assert.ok(from >= 0, "missing " + name);
  const to = next ? html.indexOf(next, from + 1) : html.length;
  assert.ok(to > from, "missing end of " + name);
  return html.slice(from, to).trim();
}

const sandbox = {
  isTodoNote: function (it) { return !!(it && (it.todo || it.type === "todo")); },
  cleanStatus: function (value) {
    var s = String(value == null ? "" : value).trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    if (!s || s === "clear" || s === "none" || s === "null") return "";
    return ["queued", "in progress", "ready to test", "failed test", "passed test"].indexOf(s) >= 0 ? s : "";
  },
  $: function () { return null; }
};
sandbox.state = { items: [] };
vm.createContext(sandbox);

/* The Queue helpers live between the QUEUE_GROUPS constant and
   updateSidebarButtons. */
vm.runInContext(grab("var QUEUE_GROUPS=", "function updateSidebarButtons"), sandbox, { filename: "queue" });

function todoOf(status, extra) {
  const item = Object.assign({ id: "t1", type: "note", todo: true, done: false, title: "Todo", status: "", hidden: false, updated: 1 }, extra || {});
  if (status !== undefined) item.status = status;
  return item;
}

test("queue groups cover all four statuses with empty-state copy", function () {
  const groups = vm.runInContext("queueGroups([])", sandbox);
  assert.deepEqual(groups.map(function (g) { return g.label; }), ["In progress", "Queued", "Ready to test", "Failed test"]);
  groups.forEach(function (group) {
    assert.ok(group.empty && group.empty.length > 4, "empty state text for " + group.label);
    assert.deepEqual(group.items, []);
  });
});

test("queueItems keeps open todos with a status and drops the rest", function () {
  vm.runInContext("function todoSeed(title,status,hidden,done){ var it={id:title,type:'note',todo:true,done:!!done,title:title,status:status,hidden:!!hidden}; return it; } state.items = [todoSeed('a','in progress'), todoSeed('b','queued'), todoSeed('c',''), todoSeed('d','passed test'), todoSeed('e','failed test',true), todoSeed('f','in progress',false,true)]", sandbox);
  const ids = vm.runInContext("queueItems().map(function(it){ return it.id; })", sandbox);
  assert.deepEqual(ids, ["a", "b"]);
});

test("queueGroups slots each status into its group", function () {
  const labels = vm.runInContext("queueGroups(queueItems()).map(function(g){ return g.label+':'+g.items.length; })", sandbox);
  assert.deepEqual(labels, ["In progress:1", "Queued:1", "Ready to test:0", "Failed test:0"]);
});

test("the sidebar ships a Queue entry and rows render the assistant badge", function () {
  assert.ok(html.includes('id="queueNavBtn"'), "Queue nav button in the sidebar");
  assert.ok(html.includes('state.sidebarView==="queue"'), "queue sidebar view wired");
  assert.ok(html.includes('originBadge.textContent="Added by Assistant"'), "badge rendered on rows");
  const homeRowFrom = html.indexOf("function buildHomeNoteRow");
  assert.ok(homeRowFrom >= 0 && html.indexOf("origin-badge", homeRowFrom) < homeRowFrom + 1600, "badge present in the home notes widget");
  assert.ok(/\.origin-badge\{/.test(html), "badge CSS exists");
  assert.ok(html.includes("setQueueLiveWatch"), "queue live watch exists");
  assert.ok(html.includes("__sbBootDone"), "boot watchdog for the login hang exists");
});
