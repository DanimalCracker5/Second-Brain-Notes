"use strict";

/* Pure note operations for the agent connection.
   The Cloud Function loads an account, calls runTool, and writes the result
   back. Nothing in this file talks to Firebase, so the same code runs in tests. */

const AGENT_ITEM_ID = "__default_agent__";
const MAX_TITLE = 200;
const MAX_TEXT = 100000;
const MAX_BLOCKS = 40;
const CODE_LANGUAGES = ["javascript", "html", "css", "python", "csharp", "json", "sql"];
const BLOCK_TYPES = ["paragraph", "text", "heading", "chapter", "comment", "prompt", "group", "code"];

const INSTRUCTIONS = [
  "This is the owner's Second Brain: their notes and todos.",
  "A todo is a note with a checkbox and an optional due date.",
  "Search or list before you read. Read one note when you need the full text.",
  "Append is the normal way to add wording. Replace only when they asked for a rewrite.",
  "Creating or editing shows up on the devices where they are signed in.",
  "Do not delete anything unless they explicitly asked, and then pass confirm true.",
  "Hidden notes and the in-app assistant are left out unless include_hidden is true.",
  "Dates are calendar days. Prefer YYYY-MM-DD. today and tomorrow use UTC."
].join(" ");

function toolError(message) {
  const err = new Error(message);
  err.toolError = true;
  return err;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function cleanText(value, max) {
  if (value == null) return "";
  const text = String(value).replace(/\u0000/g, "").slice(0, max || MAX_TEXT);
  return text;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
  });
}

function textBlock(text, id) {
  const plain = cleanText(text, MAX_TEXT);
  return { id: id, type: "text", text: plain, html: escapeHtml(plain).replace(/\n/g, "<br>") };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateKey(date) {
  return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
}

function parseDueDate(value, now) {
  if (value == null) return null;
  const raw = String(value).trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === "clear" || lower === "none" || lower === "null") return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parts = raw.split("-").map(Number);
    const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (dateKey(check) !== raw) throw toolError("That due date is not a real calendar day. Use YYYY-MM-DD.");
    return raw;
  }
  const base = new Date(now);
  if (lower === "today" || lower === "tonight") return dateKey(base);
  if (lower === "tomorrow") {
    base.setUTCDate(base.getUTCDate() + 1);
    return dateKey(base);
  }
  const relative = lower.match(/^in\s+(\d+)\s+days?$/);
  if (relative) {
    base.setUTCDate(base.getUTCDate() + Math.min(3650, Number(relative[1]) || 0));
    return dateKey(base);
  }
  throw toolError("Could not read that due date. Use YYYY-MM-DD, today, tomorrow, or in N days.");
}

function accountFromData(data) {
  const src = data && typeof data === "object" ? data : {};
  const deletedTags = src.deletedTags && typeof src.deletedTags === "object" && !Array.isArray(src.deletedTags) ? clone(src.deletedTags) : {};
  const tags = (Array.isArray(src.tags) ? clone(src.tags) : []).filter(function (tag) {
    return tag && tag.id && !deletedTags[tag.id];
  });
  const items = Array.isArray(src.items) ? clone(src.items) : [];
  items.forEach(function (item) {
    if (!item || !Array.isArray(item.tagIds)) return;
    item.tagIds = item.tagIds.filter(function (id) { return !deletedTags[id]; });
  });
  return {
    items: items,
    tags: tags,
    deletedItems: src.deletedItems && typeof src.deletedItems === "object" ? clone(src.deletedItems) : {},
    deletedTags: deletedTags,
    version: Math.max(1, Number(src.version) || 1),
    versionChangedAt: Number(src.versionChangedAt) || Number(src.updated) || 0,
    updated: Number(src.updated) || 0
  };
}

function isTodo(item) {
  return !!(item && (item.todo || item.type === "todo"));
}

function plainBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "code") return block.code || "";
  if (block.type === "chapter" || block.type === "group") return [block.title, block.text].filter(Boolean).join("\n");
  if (block.type === "embed" || block.type === "link") return [block.title, block.description, block.url].filter(Boolean).join("\n");
  if (block.type === "attachment") return "";
  return block.text || "";
}

function itemText(item) {
  if (!item) return "";
  if (item.type === "code") return item.code || item.body || "";
  if (Array.isArray(item.blocks) && item.blocks.length) return item.blocks.map(plainBlock).filter(Boolean).join("\n");
  if (Array.isArray(item.todos)) {
    return item.todos.map(function (task) { return task && (task.text || task.title) || ""; }).filter(Boolean).join("\n");
  }
  return item.body || "";
}

function syncBody(item) {
  item.body = (item.blocks || []).map(plainBlock).filter(Boolean).join("\n");
}

function tagName(account, id) {
  const tag = (account.tags || []).find(function (entry) { return entry && entry.id === id; });
  return tag && tag.name ? String(tag.name) : "";
}

function hasContent(item) {
  if (!item) return false;
  if (String(item.title || "").trim()) return true;
  if (itemText(item).trim()) return true;
  if (isTodo(item)) return true;
  return Array.isArray(item.attachments) && item.attachments.length > 0;
}

function selectable(account, options) {
  const includeHidden = !!(options && options.includeHidden);
  return (account.items || []).filter(function (item) {
    if (!item || !item.id) return false;
    if (item.type === "agent" || item.id === AGENT_ITEM_ID) return false;
    if (item.hidden && !includeHidden) return false;
    if (!hasContent(item)) return false;
    return true;
  });
}

function summary(account, item) {
  const row = {
    id: item.id,
    title: item.title || "",
    kind: isTodo(item) ? "todo" : (item.type || "note"),
    updated: Number(item.updated) || 0
  };
  const tags = (item.tagIds || []).map(function (id) { return tagName(account, id); }).filter(Boolean);
  if (tags.length) row.tags = tags;
  if (isTodo(item)) {
    row.done = !!item.done;
    row.due_date = item.dueDate || "";
  } else if (item.dueDate) row.due_date = item.dueDate;
  if (item.hidden) row.hidden = true;
  return row;
}

function publicBlocks(item) {
  return (item.blocks || []).map(function (block) {
    if (!block || block.type === "attachment") return null;
    const out = { id: block.id, type: block.type === "text" ? "paragraph" : block.type };
    if (block.title) out.title = block.title;
    if (block.type === "code") out.text = block.code || "";
    else if (block.text) out.text = block.text;
    if (block.level) out.level = block.level;
    if (block.url) out.url = block.url;
    if (block.language && block.type === "code") out.language = block.language;
    return out;
  }).filter(Boolean);
}

function readPayload(account, item) {
  const row = summary(account, item);
  const body = itemText(item);
  row.body = body.length > 60000 ? body.slice(0, 60000) : body;
  if (body.length > 60000) row.truncated = true;
  if (Array.isArray(item.blocks)) row.blocks = publicBlocks(item);
  const attachments = (item.attachments || []).length;
  if (attachments) row.attachments = attachments;
  return row;
}

function snippet(text, query) {
  const hay = String(text || "").replace(/\s+/g, " ").trim();
  const needle = String(query || "").trim().toLowerCase();
  if (!hay) return "";
  const idx = needle ? hay.toLowerCase().indexOf(needle.split(/\s+/)[0]) : 0;
  const at = idx < 0 ? 0 : idx;
  const start = Math.max(0, at - 50);
  const slice = hay.slice(start, start + 180);
  return (start ? "…" : "") + slice + (start + 180 < hay.length ? "…" : "");
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function words(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(function (word) { return word.length >= 2 || String(query || "").trim().length === 1; });
}

function matchesQuery(account, item, query) {
  const parts = words(query);
  if (!parts.length) return false;
  const blob = [item.title || "", itemText(item), (item.tagIds || []).map(function (id) { return tagName(account, id); }).join(" ")].join("\n").toLowerCase();
  return parts.every(function (part) { return blob.indexOf(part) >= 0; });
}

function kindOf(item) {
  return isTodo(item) ? "todo" : (item.type || "note");
}

function filterKind(items, type) {
  const wanted = String(type || "all").toLowerCase();
  if (!wanted || wanted === "all") return items;
  return items.filter(function (item) { return kindOf(item) === wanted; });
}

function bumpItem(item, now) {
  item.version = Math.max(1, Number(item.version) || 1) + 1;
  item.versionChangedAt = now;
  item.updated = now;
}

function bumpAccount(account, now) {
  account.version = Math.max(1, Number(account.version) || 1) + 1;
  account.versionChangedAt = now;
  account.updated = now;
}

function ensureBlocks(item, id) {
  item.attachments = Array.isArray(item.attachments) ? item.attachments : [];
  if (!Array.isArray(item.blocks) || !item.blocks.length) item.blocks = [textBlock(item.body || "", id())];
}

function editableNote(item) {
  if (!item) throw toolError("That note was not found.");
  if (item.type === "agent" || item.id === AGENT_ITEM_ID) throw toolError("The in-app assistant is not editable from this connection.");
  normalizeLegacy(item);
  if (item.type && item.type !== "note") {
    throw toolError("This connection edits notes and todos. \"" + (item.title || item.type) + "\" is a " + item.type + " item.");
  }
  return item;
}

function normalizeLegacy(item) {
  if (!item) return item;
  if (item.type === "todo") {
    if (!Array.isArray(item.blocks) || !item.blocks.length) {
      item.body = item.body || (item.todos || []).map(function (task) { return task && (task.text || task.title) || ""; }).filter(Boolean).join("\n");
    }
    item.type = "note";
    item.todo = true;
    if (typeof item.done !== "boolean") item.done = false;
  }
  if (item.type === "script") {
    if (!Array.isArray(item.blocks) || !item.blocks.length) {
      item.body = item.body || (item.sections || []).map(function (section) {
        return [section && section.title, section && section.body].filter(Boolean).join("\n");
      }).filter(Boolean).join("\n\n");
    }
    item.type = "note";
  }
  return item;
}

function ensureTags(account, names, id) {
  const ids = [];
  const list = Array.isArray(names) ? names : (typeof names === "string" ? names.split(",") : []);
  list.slice(0, 12).forEach(function (name) {
    const clean = cleanText(name, 40).trim().replace(/^#+/, "");
    if (!clean) return;
    let tag = (account.tags || []).find(function (entry) { return entry && String(entry.name || "").toLowerCase() === clean.toLowerCase(); });
    if (!tag) {
      tag = { id: id(), name: clean, hue: 0, color: "#000000", createdAt: Date.now() };
      account.tags = account.tags || [];
      account.tags.push(tag);
    }
    if (ids.indexOf(tag.id) < 0) ids.push(tag.id);
  });
  return ids;
}

function blockFromInput(input, id) {
  if (!input || typeof input !== "object") throw toolError("Each block needs a type and text.");
  const type = String(input.type || "paragraph").toLowerCase();
  if (BLOCK_TYPES.indexOf(type) < 0) throw toolError("Unknown block type \"" + type + "\". Use paragraph, heading, chapter, comment, prompt, group, or code.");
  const text = cleanText(input.text != null ? input.text : input.content, 20000);
  if (type === "paragraph" || type === "text") return textBlock(text, id());
  if (type === "heading") return { id: id(), type: "heading", text: text, level: Math.max(1, Math.min(3, Number(input.level) || 2)) };
  if (type === "chapter") {
    const block = { id: id(), type: "chapter", title: cleanText(input.title, 200), text: text };
    block.html = escapeHtml(block.text).replace(/\n/g, "<br>");
    return block;
  }
  if (type === "comment" || type === "prompt") return { id: id(), type: type, text: text };
  if (type === "group") return { id: id(), type: "group", title: cleanText(input.title, 200) || "Untitled group", text: text, collapsed: false };
  const language = CODE_LANGUAGES.indexOf(String(input.language || "").toLowerCase()) >= 0 ? String(input.language).toLowerCase() : "javascript";
  return { id: id(), type: "code", language: language, code: cleanText(input.text != null ? input.text : input.code, 20000) };
}

function blocksFromArgs(args, id) {
  if (!Array.isArray(args.blocks) || !args.blocks.length) return null;
  return args.blocks.slice(0, MAX_BLOCKS).map(function (block) { return blockFromInput(block, id); });
}

function applyBody(item, text, mode, id) {
  ensureBlocks(item, id);
  const incoming = cleanText(text, MAX_TEXT);
  const content = item.blocks.filter(function (block) { return block && block.type !== "attachment"; });
  const attachments = item.blocks.filter(function (block) { return block && block.type === "attachment"; });
  if (mode === "append") {
    const onlyEmpty = content.length === 1 && content[0].type === "text" && !String(content[0].text || "").trim();
    if (onlyEmpty) item.blocks = [textBlock(incoming, content[0].id)].concat(attachments);
    else item.blocks = content.concat([textBlock(incoming, id())]).concat(attachments);
    return;
  }
  if (mode === "prepend") {
    item.blocks = [textBlock(incoming, id())].concat(content).concat(attachments);
    return;
  }
  item.blocks = [textBlock(incoming, content[0] && content[0].type === "text" ? content[0].id : id())].concat(attachments);
  item.blockSync = "authoritative";
}

function findItem(account, id) {
  return (account.items || []).find(function (item) { return item && item.id === id; }) || null;
}

function resolveItem(account, args, options) {
  const noteId = cleanText(args.note_id || args.todo_id || args.id, 80).trim();
  if (noteId) {
    const item = findItem(account, noteId);
    if (!item || item.type === "agent") throw toolError("No note with id " + noteId + ".");
    if (item.hidden && !(options && options.includeHidden) && !(args && (args.include_hidden || args.includeHidden))) {
      throw toolError("That note is hidden. Pass include_hidden if you meant to use it.");
    }
    return item;
  }
  const query = cleanText(args.query || args.title, 200).trim();
  if (!query) throw toolError("Pass note_id, or a title to match.");
  const pool = selectable(account, { includeHidden: !!(args.include_hidden || args.includeHidden) });
  const exact = pool.filter(function (item) { return String(item.title || "").trim().toLowerCase() === query.toLowerCase(); });
  const found = exact.length ? exact : pool.filter(function (item) { return matchesQuery(account, item, query); });
  if (!found.length) throw toolError("No note matched \"" + query + "\".");
  if (found.length > 1) {
    throw toolError("Several notes matched. Pass note_id. " + found.slice(0, 8).map(function (item) {
      return item.id + " (" + (item.title || "Untitled") + ")";
    }).join("; "));
  }
  return found[0];
}

function applyTags(account, item, args, id) {
  if (args.tags == null && args.tag == null) return;
  const ids = ensureTags(account, args.tags != null ? args.tags : args.tag, id);
  item.tagIds = ids;
}

function applyTodoFields(item, args, now) {
  let touched = false;
  if (Object.prototype.hasOwnProperty.call(args, "done")) {
    item.todo = true;
    item.done = !!args.done;
    item.completed = item.done ? now : null;
    touched = true;
  }
  if (args.due_date != null || args.dueDate != null) {
    const due = parseDueDate(args.due_date != null ? args.due_date : args.dueDate, now);
    if (due != null) {
      item.todo = true;
      if (typeof item.done !== "boolean") item.done = false;
      item.dueDate = due;
      touched = true;
    }
  }
  return touched;
}

function listNotes(account, args) {
  let items = selectable(account, { includeHidden: !!(args.include_hidden || args.includeHidden) });
  items = filterKind(items, args.type || args.kind);
  items.sort(function (a, b) { return (Number(b.updated) || 0) - (Number(a.updated) || 0); });
  const limit = clampLimit(args.limit, 50, 100);
  const page = items.slice(0, limit).map(function (item) { return summary(account, item); });
  return { notes: page, count: page.length, total: items.length };
}

function searchNotes(account, args) {
  const query = cleanText(args.query, 200).trim();
  if (!query) throw toolError("Pass a query with the words to find.");
  let items = selectable(account, { includeHidden: !!(args.include_hidden || args.includeHidden) }).filter(function (item) {
    return matchesQuery(account, item, query);
  });
  items = filterKind(items, args.type || args.kind);
  items.sort(function (a, b) { return (Number(b.updated) || 0) - (Number(a.updated) || 0); });
  const limit = clampLimit(args.limit, 12, 20);
  const notes = items.slice(0, limit).map(function (item) {
    const row = summary(account, item);
    row.snippet = snippet([item.title || "", itemText(item)].join(" — "), query);
    return row;
  });
  return { query: query, notes: notes, count: notes.length };
}

function createNote(account, args, ctx) {
  const title = cleanText(args.title, MAX_TITLE).trim();
  if (!title) throw toolError("A note needs a title.");
  const kind = String(args.kind || args.type || "note").toLowerCase() === "todo" ? "todo" : "note";
  const id = ctx.id;
  const now = ctx.now;
  const built = blocksFromArgs(args, id);
  const content = cleanText(args.content != null ? args.content : args.text, MAX_TEXT);
  const blocks = built || [textBlock(kind === "todo" ? cleanText(args.detail != null ? args.detail : content, MAX_TEXT) : content, id())];
  const item = {
    id: id(),
    type: "note",
    title: title,
    body: "",
    attachments: [],
    blocks: blocks,
    tagIds: [],
    updated: now,
    version: 1,
    versionChangedAt: now,
    dueDate: ""
  };
  if (kind === "todo") {
    item.todo = true;
    item.done = false;
    item.completed = null;
  }
  applyTodoFields(item, args, now);
  if (kind === "todo" && !item.todo) {
    item.todo = true;
    item.done = false;
    item.completed = null;
  }
  applyTags(account, item, args, id);
  syncBody(item);
  account.items.unshift(item);
  bumpAccount(account, now);
  return { changed: true, changedItems: [item], result: { created: readPayload(account, item) } };
}

function updateNote(account, args, ctx) {
  const item = normalizeLegacy(resolveItem(account, args));
  editableNote(item);
  const now = ctx.now;
  let changed = false;
  if (args.title != null && cleanText(args.title, MAX_TITLE).trim()) {
    item.title = cleanText(args.title, MAX_TITLE).trim();
    changed = true;
  }
  const text = args.text != null ? args.text : (args.content != null ? args.content : args.detail);
  if (Array.isArray(args.blocks) && args.blocks.length) {
    const attachments = (item.blocks || []).filter(function (block) { return block && block.type === "attachment"; });
    item.blocks = blocksFromArgs(args, ctx.id).concat(attachments);
    item.blockSync = "authoritative";
    syncBody(item);
    changed = true;
  } else if (text != null) {
    const mode = String(args.mode || "append").toLowerCase();
    if (["append", "prepend", "replace"].indexOf(mode) < 0) throw toolError("mode must be append, prepend, or replace.");
    applyBody(item, text, mode, ctx.id);
    syncBody(item);
    changed = true;
  }
  if (applyTodoFields(item, args, now)) changed = true;
  if (args.tags != null || args.tag != null) {
    applyTags(account, item, args, ctx.id);
    changed = true;
  }
  if (!changed) throw toolError("Pass text, title, blocks, tags, done, or due_date.");
  bumpItem(item, now);
  bumpAccount(account, now);
  return { changed: true, changedItems: [item], result: { updated: readPayload(account, item) } };
}

function listTodos(account, args) {
  const filter = String(args.filter || "open").toLowerCase();
  const today = dateKey(new Date(ctxNow(args, account)));
  let items = selectable(account, { includeHidden: !!(args.include_hidden) }).filter(isTodo);
  if (filter === "open") items = items.filter(function (item) { return !item.done; });
  else if (filter === "done") items = items.filter(function (item) { return !!item.done; });
  else if (filter === "overdue") items = items.filter(function (item) { return !item.done && item.dueDate && item.dueDate < today; });
  else if (filter !== "all" && filter !== "upcoming") throw toolError("filter must be open, done, overdue, upcoming, or all.");
  if (filter === "upcoming") items = items.filter(function (item) { return !item.done && item.dueDate && item.dueDate >= today; });
  items.sort(function (a, b) { return String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || ((Number(b.updated) || 0) - (Number(a.updated) || 0)); });
  const limit = clampLimit(args.limit, 50, 100);
  const todos = items.slice(0, limit).map(function (item) { return summary(account, item); });
  return { todos: todos, count: todos.length, filter: filter };
}

function ctxNow(args, account) {
  return Number(args && args.__now) || Number(account && account.updated) || Date.now();
}

function updateTodo(account, args, ctx) {
  const next = Object.assign({}, args, { note_id: args.todo_id || args.note_id || args.id });
  if (args.detail != null && args.text == null && args.content == null) next.text = args.detail;
  if (args.detail != null && !next.mode) next.mode = "replace";
  const pool = selectable(account, { includeHidden: true }).filter(isTodo);
  if (!next.note_id && next.query) {
    const exact = pool.filter(function (item) { return String(item.title || "").trim().toLowerCase() === String(next.query).trim().toLowerCase(); });
    const found = exact.length ? exact : pool.filter(function (item) { return matchesQuery(account, item, next.query); });
    if (found.length === 1) next.note_id = found[0].id;
  }
  return updateNote(account, next, ctx);
}

function deleteNote(account, args, ctx) {
  const confirmed = args.confirm === true || args.confirm === "true" || args.confirm === 1;
  if (!confirmed) throw toolError("Refusing to delete until confirm is true. Only do that when the owner explicitly asked to delete the note.");
  const item = resolveItem(account, args);
  if (item.type === "agent" || item.id === AGENT_ITEM_ID) throw toolError("The in-app assistant cannot be deleted from this connection.");
  const now = ctx.now;
  const rev = Math.max(1, Number(item.version) || 1);
  account.deletedItems = account.deletedItems || {};
  account.deletedItems[item.id] = { version: rev + 1, versionChangedAt: now, deletedAt: now };
  account.items = account.items.filter(function (entry) { return !entry || entry.id !== item.id; });
  account.deletedItems = pruneTombstones(account.deletedItems);
  bumpAccount(account, now);
  return { changed: true, changedItems: [], deletedIds: [item.id], result: { deleted: { id: item.id, title: item.title || "" } } };
}

function pruneTombstones(map) {
  const rows = Object.keys(map || {}).map(function (id) { return { id: id, entry: map[id] }; });
  rows.sort(function (a, b) { return (Number(b.entry && b.entry.deletedAt) || 0) - (Number(a.entry && a.entry.deletedAt) || 0); });
  const out = {};
  rows.slice(0, 400).forEach(function (row) { if (row.entry) out[row.id] = row.entry; });
  return out;
}

function readNote(account, args) {
  const item = resolveItem(account, args);
  return { note: readPayload(account, item) };
}

function withClock(account, args, ctx) {
  const copy = Object.assign({}, args || {});
  copy.__now = ctx.now;
  return copy;
}

function runTool(account, name, args, ctx) {
  const source = accountFromData(account);
  const clock = ctx && Number(ctx.now) ? ctx.now : Date.now();
  let n = 0;
  const context = {
    now: clock,
    id: ctx && typeof ctx.id === "function" ? ctx.id : function () {
      n += 1;
      return clock.toString(36) + n.toString(36);
    }
  };
  const input = withClock(source, args, context);
  let out;
  if (name === "list_notes") out = { changed: false, result: listNotes(source, input) };
  else if (name === "search_notes") out = { changed: false, result: searchNotes(source, input) };
  else if (name === "read_note") out = { changed: false, result: readNote(source, input) };
  else if (name === "create_note" || name === "create_todo") {
    if (name === "create_todo") input.kind = "todo";
    out = createNote(source, input, context);
  } else if (name === "update_note") out = updateNote(source, input, context);
  else if (name === "list_todos") out = { changed: false, result: listTodos(source, input) };
  else if (name === "update_todo") out = updateTodo(source, input, context);
  else if (name === "delete_note") out = deleteNote(source, input, context);
  else throw toolError("Unknown tool \"" + name + "\".");
  return {
    account: source,
    changed: !!out.changed,
    changedItems: out.changedItems || [],
    deletedIds: out.deletedIds || [],
    result: out.result
  };
}

function toolDefs() {
  const due = { type: "string", description: "YYYY-MM-DD, today, tomorrow, in N days, or clear." };
  return [
    {
      name: "list_notes",
      description: "List the owner's Second Brain notes and todos by id and title. Does not return full bodies.",
      inputSchema: { type: "object", properties: {
        type: { type: "string", description: "Optional kind filter: note, todo, code, or all." },
        limit: { type: "integer", description: "Max rows, default 50, max 100." },
        include_hidden: { type: "boolean", description: "Include notes the owner has hidden." }
      } }
    },
    {
      name: "search_notes",
      description: "Search titles, tags, and note text. Returns ids and short snippets. Use this before read_note.",
      inputSchema: { type: "object", properties: {
        query: { type: "string", description: "Words to find. Every word must match." },
        type: { type: "string", description: "Optional kind filter: note, todo, code, or all." },
        limit: { type: "integer", description: "Max rows, default 12, max 20." },
        include_hidden: { type: "boolean" }
      }, required: ["query"] }
    },
    {
      name: "read_note",
      description: "Read one note or todo, including its text. Pass an id from list_notes or search_notes.",
      inputSchema: { type: "object", properties: {
        note_id: { type: "string" },
        query: { type: "string", description: "Title to match if you do not have an id." },
        include_hidden: { type: "boolean" }
      } }
    },
    {
      name: "create_note",
      description: "Create a note or todo in the owner's Second Brain. It appears on their signed-in devices.",
      inputSchema: { type: "object", properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["note", "todo"], description: "Defaults to note." },
        content: { type: "string", description: "Body text when you are not passing blocks." },
        due_date: due,
        tags: { type: "array", items: { type: "string" } },
        blocks: { type: "array", description: "Optional structured blocks: paragraph, heading, chapter, comment, prompt, group, or code.", items: { type: "object" } }
      }, required: ["title"] }
    },
    {
      name: "update_note",
      description: "Add to or rewrite a note or todo. mode append is the default. mode replace rewrites the body. You can also set the title, tags, done, or due date.",
      inputSchema: { type: "object", properties: {
        note_id: { type: "string" },
        query: { type: "string" },
        text: { type: "string" },
        mode: { type: "string", enum: ["append", "prepend", "replace"] },
        title: { type: "string" },
        blocks: { type: "array", items: { type: "object" } },
        tags: { type: "array", items: { type: "string" } },
        done: { type: "boolean" },
        due_date: due
      } }
    },
    {
      name: "list_todos",
      description: "List todos with done state and due dates.",
      inputSchema: { type: "object", properties: {
        filter: { type: "string", enum: ["open", "done", "overdue", "upcoming", "all"], description: "Defaults to open." },
        limit: { type: "integer" },
        include_hidden: { type: "boolean" }
      } }
    },
    {
      name: "update_todo",
      description: "Mark a todo done or not done, set or clear its due date, or replace its text.",
      inputSchema: { type: "object", properties: {
        todo_id: { type: "string" },
        query: { type: "string" },
        done: { type: "boolean" },
        due_date: due,
        detail: { type: "string", description: "Replaces the todo body when set." },
        title: { type: "string" }
      } }
    },
    {
      name: "create_todo",
      description: "Create a todo note. Same as create_note with kind todo.",
      inputSchema: { type: "object", properties: {
        title: { type: "string" },
        detail: { type: "string" },
        due_date: due,
        tags: { type: "array", items: { type: "string" } }
      }, required: ["title"] }
    },
    {
      name: "delete_note",
      description: "Delete a note or todo. Only call this when the owner explicitly asked to delete it, and pass confirm true.",
      inputSchema: { type: "object", properties: {
        note_id: { type: "string" },
        query: { type: "string" },
        confirm: { type: "boolean", description: "Must be true." }
      }, required: ["confirm"] }
    }
  ];
}

module.exports = {
  INSTRUCTIONS: INSTRUCTIONS,
  AGENT_ITEM_ID: AGENT_ITEM_ID,
  accountFromData: accountFromData,
  runTool: runTool,
  toolDefs: toolDefs,
  toolError: toolError,
  parseDueDate: parseDueDate,
  dateKey: dateKey
};
