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

test("main app script still parses after paste handling", function () {
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

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngFile(name) {
  const bytes = Buffer.from(PNG_1X1, "base64");
  return new File([bytes], name || "image.png", { type: "image/png" });
}

function clipboardFrom(parts) {
  const files = parts.files || [];
  const items = (parts.items || files.map(function (file) {
    return { kind: "file", type: file.type, getAsFile: function () { return file; } };
  })).concat(parts.extraItems || []);
  const data = Object.assign({ "text/plain": "", "text/html": "" }, parts.data || {});
  return {
    files: files,
    items: items,
    getData: function (type) { return data[type] == null ? "" : data[type]; }
  };
}

const sandbox = {
  MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
  File: File,
  Uint8Array: Uint8Array,
  atob: function (value) { return Buffer.from(value, "base64").toString("binary"); }
};
vm.createContext(sandbox);
vm.runInContext(grab("namedClipboardFile", "buildNoteParagraph"), sandbox, { filename: "clipboard" });

test("clipboardPasteFiles reads Windows screenshot files and dedupes items", function () {
  const file = pngFile("image.png");
  const files = sandbox.clipboardPasteFiles(clipboardFrom({ files: [file] }));
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "image.png");
});

test("clipboardPasteFiles names an unnamed screenshot blob", function () {
  const blob = pngFile("");
  Object.defineProperty(blob, "name", { value: "" });
  const unnamed = new File([Buffer.from(PNG_1X1, "base64")], "", { type: "image/png" });
  const files = sandbox.clipboardPasteFiles(clipboardFrom({
    files: [],
    items: [{ kind: "file", type: "image/png", getAsFile: function () { return unnamed; } }]
  }));
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^pasted-file\.png$/);
  assert.equal(files[0].type, "image/png");
});

test("clipboardNoteFiles prefers Explorer files over the Windows path text", function () {
  const file = pngFile("holiday.jpg");
  const files = sandbox.clipboardNoteFiles(clipboardFrom({
    files: [file],
    data: { "text/plain": "C:\\Users\\Daniel\\Pictures\\holiday.jpg" }
  }));
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "holiday.jpg");
});

test("clipboardNoteFiles does not steal a normal text paste that happens to mention an image", function () {
  const files = sandbox.clipboardNoteFiles(clipboardFrom({
    files: [],
    items: [],
    data: {
      "text/plain": "See the photo below",
      "text/html": "<p>See the photo below</p><img src=\"data:image/png;base64," + PNG_1X1 + "\">"
    }
  }));
  assert.equal(files.length, 0);
});

test("clipboardNoteFiles turns a data-URI screenshot into a file", function () {
  const files = sandbox.clipboardNoteFiles(clipboardFrom({
    files: [],
    items: [],
    data: {
      "text/plain": "",
      "text/html": "<html><body><!--StartFragment--><img src=\"data:image/png;base64," + PNG_1X1 + "\"><!--EndFragment--></body></html>"
    }
  }));
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "pasted-image.png");
  assert.equal(files[0].type, "image/png");
  assert.ok(files[0].size > 0);
});

test("pastePlainText always preventDefaults so a photo cannot land in the editor", function () {
  const calls = [];
  sandbox.document = { execCommand: function () { calls.push("insert"); } };
  const event = {
    clipboardData: clipboardFrom({
      files: [pngFile("image.png")],
      data: { "text/plain": "" }
    }),
    preventDefault: function () { calls.push("prevent"); }
  };
  sandbox.pastePlainText(event);
  assert.deepEqual(calls, ["prevent"]);
});

test("pastePlainText still inserts copied text", function () {
  const calls = [];
  sandbox.document = {
    execCommand: function (name, _show, value) { calls.push([name, value]); }
  };
  const event = {
    clipboardData: clipboardFrom({
      files: [],
      items: [],
      data: { "text/plain": "hello\r\nwindows" }
    }),
    preventDefault: function () { calls.push("prevent"); }
  };
  sandbox.pastePlainText(event);
  assert.deepEqual(calls, ["prevent", ["insertText", "hello\nwindows"]]);
});

test("pasteNoteFilesFromClipboard uploads into the open note and skips settings", function () {
  const attached = [];
  const note = { id: "note-1", type: "note", blocks: [{ id: "p1", type: "text", text: "", html: "" }], attachments: [] };
  sandbox.current = function () { return note; };
  sandbox.itemUsesNoteBlocks = function (it) { return it && it.type === "note"; };
  sandbox.ensureNoteBlocks = function () {};
  sandbox.addNoteAttachments = function (target, files) { attached.push({ id: target.id, names: Array.from(files).map(function (file) { return file.name; }) }); };
  sandbox.rememberPasteCaret = function () {};
  sandbox.noteFromEditorNode = function () { return note; };

  const photoEvent = {
    target: {
      closest: function (selector) { return selector === ".note-editor" ? { getAttribute: function () { return "note-1"; } } : null; }
    },
    clipboardData: clipboardFrom({ files: [pngFile("snap.png")] }),
    preventDefault: function () { photoEvent.prevented = true; }
  };
  assert.equal(sandbox.pasteNoteFilesFromClipboard(photoEvent), true);
  assert.equal(photoEvent.prevented, true);
  assert.deepEqual(attached, [{ id: "note-1", names: ["snap.png"] }]);

  attached.length = 0;
  const settingsEvent = {
    target: {
      closest: function (selector) { return selector.indexOf("#settingsModal") >= 0 ? {} : null; }
    },
    clipboardData: clipboardFrom({ files: [pngFile("snap.png")] }),
    preventDefault: function () { settingsEvent.prevented = true; }
  };
  assert.equal(sandbox.pasteNoteFilesFromClipboard(settingsEvent), false);
  assert.equal(settingsEvent.prevented, undefined);
  assert.equal(attached.length, 0);
});

test("note fields keep a document-level paste listener", function () {
  assert.match(html, /document\.addEventListener\("paste"/);
  assert.match(html, /pasteNoteFilesFromClipboard/);
  assert.match(grab("pastePlainText", "noteFromEditorNode"), /event\.preventDefault\(\)/);
});
