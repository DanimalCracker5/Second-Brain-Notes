"use strict";

const notes = require("./agent-notes");
const mcp = require("./agent-mcp");

const READ_TOOLS = { list_notes: true, search_notes: true, read_note: true, list_todos: true };
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 120;

function defaultOriginAllowed(origin) {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host === "secondbrainnotes.com" || host.endsWith(".secondbrainnotes.com")) return true;
    if (host.endsWith(".github.io")) return true;
    if (host.endsWith(".web.app") || host.endsWith(".firebaseapp.com")) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function requestPath(req) {
  const raw = String((req && (req.path || req.url)) || "/").split("?")[0];
  const trimmed = raw.replace(/\/+$/, "") || "/";
  return trimmed.replace(/^\/agent(?=\/|$)/, "") || "/";
}

function bearer(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function queryOf(req) {
  const url = String((req && req.url) || "");
  const q = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";
  const out = {};
  q.split("&").forEach(function (pair) {
    if (!pair) return;
    const bits = pair.split("=");
    const key = decodeURIComponent(bits[0] || "");
    if (!key) return;
    out[key] = decodeURIComponent(bits.slice(1).join("=") || "");
  });
  return out;
}

function jsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = req.rawBody != null ? req.rawBody : req.body;
  if (raw == null || raw === "") return {};
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (text.length > 1000000) {
    const err = new Error("That request is too large.");
    err.status = 413;
    err.code = "REQUEST_TOO_LARGE";
    throw err;
  }
  try { return JSON.parse(text); } catch (e) {
    const err = new Error("The request body was not valid JSON.");
    err.status = 400;
    err.code = "BAD_JSON";
    throw err;
  }
}

function httpError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status || 400;
  return err;
}

function createAgentHandler(options) {
  const store = options.store;
  const verifyUser = options.verifyUser;
  const nowFn = options.now || function () { return Date.now(); };
  const originAllowed = options.originAllowed || defaultOriginAllowed;
  const buckets = new Map();

  function setCors(req, res) {
    const origin = req.headers && req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    } else if (!origin) {
      res.set("Access-Control-Allow-Origin", "*");
    }
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id");
    res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.set("Access-Control-Max-Age", "3600");
    res.set("Access-Control-Expose-Headers", "WWW-Authenticate");
  }

  function assertOrigin(req) {
    const origin = req.headers && req.headers.origin;
    if (origin && !originAllowed(origin)) throw httpError("FORBIDDEN_ORIGIN", "This origin cannot use Second Brain agent access.", 403);
  }

  function limit(key) {
    const now = nowFn();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= WINDOW_MS) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 5000) buckets.clear();
    if (bucket.count > MAX_PER_WINDOW) throw httpError("RATE_LIMIT", "Too many agent requests. Wait a minute and try again.", 429);
  }

  async function callTool(uid, name, args) {
    const clock = { now: nowFn() };
    if (READ_TOOLS[name]) {
      const account = await store.readAccount(uid);
      return notes.runTool(account, name, args, clock);
    }
    return store.commit(uid, function (account) {
      return notes.runTool(account, name, args, clock);
    });
  }

  async function requireAgent(req) {
    const token = bearer(req);
    if (!token) throw httpError("UNAUTHENTICATED", "Send Authorization: Bearer with a Second Brain agent token from Settings → Connect an agent.", 401);
    const auth = await store.authenticateAgent(token);
    if (!auth || !auth.uid) throw httpError("UNAUTHENTICATED", "That agent token is not valid.", 401);
    limit("agent:" + auth.uid);
    return auth;
  }

  async function requireUser(req) {
    if (typeof verifyUser !== "function") throw httpError("NOT_CONFIGURED", "Sign-in is not available on this server.", 503);
    const user = await verifyUser(req);
    if (!user || !user.uid) throw httpError("UNAUTHENTICATED", "Sign in to manage agent tokens.", 401);
    limit("user:" + user.uid);
    return user;
  }

  function sendError(res, err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error(err);
    if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="Second Brain"');
    res.status(status).json({ error: (err && err.message) || "Agent access failed.", code: (err && err.code) || "INTERNAL" });
  }

  async function handleMcp(req, res) {
    if (req.method === "GET" || req.method === "DELETE") {
      res.set("Allow", "POST");
      res.status(405).json({ error: "Second Brain MCP accepts POST.", code: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (req.method !== "POST") throw httpError("METHOD_NOT_ALLOWED", "Second Brain MCP accepts POST.", 405);
    const auth = await requireAgent(req);
    const body = jsonBody(req);
    if (Array.isArray(body)) throw httpError("BAD_REQUEST", "Send one JSON-RPC message per request.", 400);
    const outcome = await mcp.handleMessage(body, {
      callTool: function (name, args) { return callTool(auth.uid, name, args); }
    });
    if (outcome.empty) {
      res.status(outcome.status).send("");
      return;
    }
    res.status(outcome.status).json(outcome.body);
  }

  async function handleRest(req, res, path) {
    const auth = await requireAgent(req);
    const uid = auth.uid;
    const query = queryOf(req);
    const body = req.method === "GET" || req.method === "DELETE" ? {} : jsonBody(req);
    let name = "";
    let args = {};

    if (req.method === "GET" && path === "/v1/notes") {
      if (query.query) { name = "search_notes"; args = { query: query.query, type: query.type, limit: query.limit, include_hidden: query.include_hidden === "true" }; }
      else { name = "list_notes"; args = { type: query.type, limit: query.limit, include_hidden: query.include_hidden === "true" }; }
    } else if (req.method === "GET" && path.indexOf("/v1/notes/") === 0) {
      name = "read_note";
      args = { note_id: decodeURIComponent(path.slice("/v1/notes/".length)), include_hidden: query.include_hidden === "true" };
    } else if (req.method === "POST" && path === "/v1/notes") {
      name = "create_note";
      args = body;
    } else if (req.method === "PATCH" && path.indexOf("/v1/notes/") === 0) {
      name = "update_note";
      args = Object.assign({}, body, { note_id: decodeURIComponent(path.slice("/v1/notes/".length)) });
    } else if (req.method === "DELETE" && path.indexOf("/v1/notes/") === 0) {
      name = "delete_note";
      args = { note_id: decodeURIComponent(path.slice("/v1/notes/".length)), confirm: query.confirm === "true" || body.confirm === true };
    } else if (req.method === "GET" && path === "/v1/todos") {
      name = "list_todos";
      args = { filter: query.filter, limit: query.limit, include_hidden: query.include_hidden === "true" };
    } else if (req.method === "POST" && path === "/v1/todos") {
      name = "create_todo";
      args = body;
    } else if (req.method === "PATCH" && path.indexOf("/v1/todos/") === 0) {
      name = "update_todo";
      args = Object.assign({}, body, { todo_id: decodeURIComponent(path.slice("/v1/todos/".length)) });
    } else {
      throw httpError("NOT_FOUND", "Unknown agent route.", 404);
    }

    try {
      const out = await callTool(uid, name, args);
      res.json(out.result);
    } catch (err) {
      if (err && err.toolError) throw httpError("TOOL", err.message, 400);
      throw err;
    }
  }

  return async function handle(req, res) {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    const path = requestPath(req);
    try {
      assertOrigin(req);
      if (req.method === "GET" && (path === "/" || path === "")) {
        res.json({
          name: "second-brain-agent",
          mcp: "/mcp",
          instructions: "Create a token in Second Brain → Settings → Connect an agent, then point Hermes at the /mcp URL."
        });
        return;
      }
      if (path === "/mcp" || (path === "/" && req.method === "POST")) {
        await handleMcp(req, res);
        return;
      }
      if (path === "/tokens" && req.method === "GET") {
        const user = await requireUser(req);
        res.json({ tokens: await store.listTokens(user.uid) });
        return;
      }
      if (path === "/tokens" && req.method === "POST") {
        const user = await requireUser(req);
        const body = jsonBody(req);
        res.json(await store.createToken(user.uid, body && body.name));
        return;
      }
      if (path === "/tokens/revoke" && req.method === "POST") {
        const user = await requireUser(req);
        const body = jsonBody(req);
        const id = body && (body.id || body.tokenId);
        if (!id) throw httpError("BAD_REQUEST", "Pass the token id to revoke.", 400);
        await store.revokeToken(user.uid, String(id));
        res.json({ revoked: true, id: String(id) });
        return;
      }
      if (path.indexOf("/v1/") === 0) {
        await handleRest(req, res, path);
        return;
      }
      throw httpError("NOT_FOUND", "Unknown agent route.", 404);
    } catch (err) {
      sendError(res, err);
    }
  };
}

module.exports = {
  createAgentHandler: createAgentHandler,
  requestPath: requestPath,
  defaultOriginAllowed: defaultOriginAllowed
};
