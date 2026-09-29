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

const sandbox = {};
vm.createContext(sandbox);
[
  "sanitizeTagGroups",
  "applyTagOrder",
  "placeId",
  "placeTagInDefault",
  "relocateTag",
  "nudgeTag",
  "forgetTag"
].forEach(function (name) {
  vm.runInContext(grab(name), sandbox, { filename: name });
});

function tags() {
  return [
    { id: "todo", name: "TO DO" },
    { id: "astral", name: "Astral" },
    { id: "youtube", name: "Youtube" },
    { id: "prompt", name: "Prompt" }
  ];
}

test("dragging a tag out of the default list can start a group", function () {
  const result = sandbox.relocateTag(tags(), [], "youtube", { groupId: "new", newId: "g1", name: "Videos" });
  assert.equal(result.createdId, "g1");
  assert.deepEqual(result.groups, [{ id: "g1", name: "Videos", collapsed: false, tagIds: ["youtube"] }]);
  assert.deepEqual(result.tags.map(function (tag) { return tag.id; }), ["todo", "astral", "youtube", "prompt"]);
});

test("tags reorder inside the default list and inside a group", function () {
  const down = sandbox.nudgeTag(tags(), [], "todo", 1);
  assert.deepEqual(down.tags.map(function (tag) { return tag.id; }), ["astral", "todo", "youtube", "prompt"]);
  const grouped = sandbox.relocateTag(tags(), [], "prompt", { groupId: "new", newId: "g1", name: "Work" });
  const withAstral = sandbox.relocateTag(grouped.tags, grouped.groups, "astral", { groupId: "g1", targetId: "prompt", after: false });
  assert.deepEqual(withAstral.groups[0].tagIds, ["astral", "prompt"]);
  const swapped = sandbox.nudgeTag(withAstral.tags, withAstral.groups, "astral", 1);
  assert.deepEqual(swapped.groups[0].tagIds, ["prompt", "astral"]);
  const ungrouped = sandbox.nudgeTag(swapped.tags, swapped.groups, "todo", 1);
  assert.deepEqual(ungrouped.tags.filter(function (tag) {
    return swapped.groups[0].tagIds.indexOf(tag.id) < 0;
  }).map(function (tag) { return tag.id; }), ["youtube", "todo"]);
});

test("taking the last tag out of a group destroys that group", function () {
  const made = sandbox.relocateTag(tags(), [], "youtube", { groupId: "new", newId: "g1", name: "Videos" });
  const back = sandbox.relocateTag(made.tags, made.groups, "youtube", { groupId: null, targetId: "todo", after: true });
  assert.deepEqual(back.groups, []);
  assert.deepEqual(back.removedGroupIds, ["g1"]);
  assert.deepEqual(back.tags.map(function (tag) { return tag.id; }), ["todo", "youtube", "astral", "prompt"]);
});

test("a group stays while it still has tags", function () {
  let current = sandbox.relocateTag(tags(), [], "youtube", { groupId: "new", newId: "g1", name: "Videos" });
  current = sandbox.relocateTag(current.tags, current.groups, "prompt", { groupId: "g1" });
  current = sandbox.relocateTag(current.tags, current.groups, "youtube", { groupId: null });
  assert.equal(current.removedGroupIds.length, 0);
  assert.deepEqual(current.groups[0].tagIds, ["prompt"]);
});

test("deleting the last grouped tag destroys the group", function () {
  const made = sandbox.relocateTag(tags(), [], "bug", { groupId: "new", newId: "g1", name: "Bugs" });
  const groups = made.groups.map(function (group) { return Object.assign({}, group, { tagIds: ["bug"] }); });
  const forgotten = sandbox.forgetTag(groups, "bug");
  assert.deepEqual(forgotten.groups, []);
  assert.deepEqual(forgotten.removedGroupIds, ["g1"]);
});

test("empty groups and unknown tag ids are dropped", function () {
  const clean = sandbox.sanitizeTagGroups([
    { id: "g1", name: "  Videos ", collapsed: true, tagIds: ["youtube", "missing", "youtube"] },
    { id: "g2", name: "", tagIds: [] },
    { id: "g1", name: "Duplicate", tagIds: ["prompt"] }
  ], tags());
  assert.deepEqual(clean, [{ id: "g1", name: "Videos", collapsed: true, tagIds: ["youtube"] }]);
});

test("saved tag order is restored and new tags stay on the list", function () {
  const ordered = sandbox.applyTagOrder(tags(), ["prompt", "todo", "extra"]);
  assert.deepEqual(ordered.map(function (tag) { return tag.id; }), ["prompt", "todo", "astral", "youtube"]);
});

test("sidebar renders a drop target and a caret per tag group", function () {
  assert.match(html, /id="tagGroups"/);
  assert.match(html, /tag-new-group/);
  assert.match(html, /Drop to make a group/);
  assert.match(html, /tag-group-h/);
  assert.match(html, /Remove from group/);
  assert.match(grab("renderTags"), /renderTagCloud\(ungrouped, "", entered\)/);
  assert.match(grab("updateTagDrag"), /belowDefault/);
});
