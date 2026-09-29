"use strict";

const assert = require("assert");
const { test } = require("node:test");
const notes = require("./agent-notes");
const { createAgentHandler } = require("./agent-http");

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    set: function (key, value) { this.headers[String(key).toLowerCase()] = value; },
    status: function (code) { this.statusCode = code; return this; },
    json: function (body) { this.body = body; return this; },
    send: function (body) { this.body = body; return this; }
  };
  return res;
}

function memoryStore() {
  const accounts = {};
  const tokens = [];
  return {
    accounts: accounts,
    tokens: tokens,
    authenticateAgent: async function (token) {
      const row = tokens.find(function (entry) { return entry.token === token; });
      if (!row) {
        const err = new Error("That agent token is not valid.");
        err.status = 401;
        err.code = "UNAUTHENTICATED";
        throw err;
      }
      return { uid: row.uid, tokenId: row.id, name: row.name };
    },
    listTokens: async function (uid) {
      return tokens.filter(function (entry) { return entry.uid === uid; }).map(function (entry) {
        return { id: entry.id, name: entry.name, prefix: entry.prefix, createdAt: entry.createdAt, lastUsedAt: 0 };
      });
    },
    createToken: async function (uid, name) {
      const row = { token: "sb_testtoken" + tokens.length, id: "tok" + tokens.length, uid: uid, name: name || "Hermes", prefix: "sb_test…", createdAt: 10 };
      tokens.push(row);
      return { token: row.token, id: row.id, name: row.name, prefix: row.prefix, createdAt: row.createdAt, mcpPath: "/mcp" };
    },
    revokeToken: async function (uid, tokenId) {
      const index = tokens.findIndex(function (entry) { return entry.uid === uid && entry.id === tokenId; });
      if (index < 0) {
        const err = new Error("That token is already gone.");
        err.status = 404;
        throw err;
      }
      tokens.splice(index, 1);
    },
    readAccount: async function (uid) {
      return notes.accountFromData(accounts[uid]);
    },
    commit: async function (uid, mutator) {
      const out = mutator(notes.accountFromData(accounts[uid]));
      if (out.changed) accounts[uid] = out.account;
      return out;
    }
  };
}

function handlerFor(store) {
  return createAgentHandler({
    store: store,
    now: function () { return Date.UTC(2026, 8, 29, 15, 0, 0); },
    verifyUser: async function (req) {
      const header = req.headers.authorization || "";
      if (header.indexOf("Firebase ") < 0) {
        const err = new Error("Sign in to manage agent tokens.");
        err.status = 401;
        throw err;
      }
      return { uid: "user-1" };
    }
  });
}

async function call(handler, req) {
  const res = mockRes();
  await handler(Object.assign({ headers: {}, body: null }, req), res);
  return res;
}

test("MCP initialize, tool list, and a note round trip", async function () {
  const store = memoryStore();
  store.tokens.push({ token: "sb_owner", id: "tok", uid: "user-1", name: "Hermes", prefix: "sb_owne…", createdAt: 1 });
  const handler = handlerFor(store);
  const headers = { authorization: "Bearer sb_owner", origin: "https://secondbrainnotes.com" };

  const init = await call(handler, {
    method: "POST",
    url: "/mcp",
    headers: headers,
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hermes", version: "1" } } }
  });
  assert.equal(init.statusCode, 200);
  assert.equal(init.body.result.serverInfo.name, "second-brain");
  assert.equal(init.body.result.protocolVersion, "2025-03-26");
  assert.match(init.body.result.instructions, /Second Brain/);

  const listed = await call(handler, {
    method: "POST",
    url: "/agent/mcp",
    headers: headers,
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" }
  });
  const names = listed.body.result.tools.map(function (tool) { return tool.name; });
  assert.ok(names.indexOf("search_notes") >= 0);
  assert.ok(names.indexOf("create_note") >= 0);
  assert.equal(listed.body.result.resultType, "complete");

  const created = await call(handler, {
    method: "POST",
    url: "/mcp",
    headers: headers,
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_note", arguments: { title: "Hermes notes", content: "Use Second Brain instead of TickTick" } } }
  });
  assert.equal(created.body.result.isError, false);
  const payload = JSON.parse(created.body.result.content[0].text);
  assert.equal(payload.created.title, "Hermes notes");
  assert.equal(store.accounts["user-1"].items[0].title, "Hermes notes");

  const found = await call(handler, {
    method: "GET",
    url: "/v1/notes?query=TickTick",
    headers: headers
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.body.notes[0].id, payload.created.id);

  const ready = await call(handler, {
    method: "POST",
    url: "/mcp",
    headers: headers,
    body: { jsonrpc: "2.0", method: "notifications/initialized" }
  });
  assert.equal(ready.statusCode, 202);

  const discover = await call(handler, {
    method: "POST",
    url: "/mcp",
    headers: headers,
    body: { jsonrpc: "2.0", id: "d", method: "server/discover", params: {} }
  });
  assert.ok(discover.body.result.supportedVersions.indexOf("2026-07-28") >= 0);
});

test("missing and revoked-style tokens are rejected and a foreign origin is blocked", async function () {
  const handler = handlerFor(memoryStore());
  const missing = await call(handler, { method: "POST", url: "/mcp", headers: {}, body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.equal(missing.statusCode, 401);
  assert.match(missing.headers["www-authenticate"], /Bearer/);

  const blocked = await call(handler, {
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer sb_owner", origin: "https://evil.example" },
    body: { jsonrpc: "2.0", id: 1, method: "ping" }
  });
  assert.equal(blocked.statusCode, 403);
});

test("a signed-in person can create and revoke a token without the secret being listed later", async function () {
  const store = memoryStore();
  const handler = handlerFor(store);
  const headers = { authorization: "Firebase user-1", origin: "http://localhost:4173" };
  const created = await call(handler, { method: "POST", url: "/tokens", headers: headers, body: { name: "Home Hermes" } });
  assert.equal(created.statusCode, 200);
  assert.match(created.body.token, /^sb_/);
  const listed = await call(handler, { method: "GET", url: "/tokens", headers: headers });
  assert.equal(listed.body.tokens[0].name, "Home Hermes");
  assert.equal(listed.body.tokens[0].token, undefined);
  const revoked = await call(handler, { method: "POST", url: "/tokens/revoke", headers: headers, body: { id: created.body.id } });
  assert.equal(revoked.body.revoked, true);
  assert.equal(store.tokens.length, 0);
});

test("the health check names the MCP path and a tool mistake stays a tool error", async function () {
  const store = memoryStore();
  store.tokens.push({ token: "sb_owner", id: "tok", uid: "user-1", name: "Hermes" });
  const handler = handlerFor(store);
  const health = await call(handler, { method: "GET", url: "/" });
  assert.equal(health.body.mcp, "/mcp");
  const bad = await call(handler, {
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer sb_owner" },
    body: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_note", arguments: { note_id: "missing" } } }
  });
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /confirm is true/);
});
