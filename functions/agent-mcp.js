"use strict";

const notes = require("./agent-notes");

const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"];
const SERVER_INFO = { name: "second-brain", version: "1.0.0" };

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id, result: result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id == null ? null : id, error: { code: code, message: message } };
}

function negotiate(params) {
  const requested = params && (params.protocolVersion || (params._meta && params._meta["io.modelcontextprotocol/protocolVersion"]));
  if (SUPPORTED_VERSIONS.indexOf(requested) >= 0) return requested;
  return "2025-03-26";
}

function publicTools() {
  return notes.toolDefs().map(function (tool) {
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  });
}

function toolResult(id, text, isError) {
  return rpcResult(id, {
    resultType: "complete",
    content: [{ type: "text", text: text }],
    isError: !!isError
  });
}

function isNotification(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return false;
  if (message.method.indexOf("notifications/") === 0) return true;
  return !Object.prototype.hasOwnProperty.call(message, "id");
}

/* One JSON-RPC message from an MCP client. ctx.callTool(name, args) returns
   the runTool result. Auth has already succeeded. */
async function handleMessage(message, ctx) {
  if (!message || message.jsonrpc !== "2.0") {
    return { status: 400, body: rpcError(null, -32600, "Invalid JSON-RPC request.") };
  }
  if (message.method == null && (message.result != null || message.error != null)) {
    return { status: 202, empty: true };
  }
  if (typeof message.method !== "string") {
    return { status: 400, body: rpcError(message.id, -32600, "Invalid JSON-RPC request.") };
  }
  if (isNotification(message)) return { status: 202, empty: true };

  const id = message.id;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  if (message.method === "initialize") {
    return { status: 200, body: rpcResult(id, {
      protocolVersion: negotiate(params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: notes.INSTRUCTIONS
    }) };
  }
  if (message.method === "server/discover") {
    return { status: 200, body: rpcResult(id, {
      resultType: "complete",
      supportedVersions: SUPPORTED_VERSIONS.slice(),
      capabilities: { tools: { listChanged: false } },
      instructions: notes.INSTRUCTIONS,
      ttlMs: 3600000,
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }
    }) };
  }
  if (message.method === "ping" || message.method === "logging/setLevel") {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (message.method === "tools/list") {
    return { status: 200, body: rpcResult(id, {
      resultType: "complete",
      tools: publicTools(),
      ttlMs: 3600000,
      cacheScope: "public"
    }) };
  }
  if (message.method === "tools/call") {
    const name = String(params.name || "");
    let args = params.arguments == null ? {} : params.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch (e) { args = {}; }
    }
    if (!name || !args || typeof args !== "object" || Array.isArray(args)) {
      return { status: 200, body: toolResult(id, "Tool name and arguments are required.", true) };
    }
    try {
      const out = await ctx.callTool(name, args);
      return { status: 200, body: toolResult(id, JSON.stringify(out.result, null, 2), false) };
    } catch (err) {
      if (err && err.toolError) return { status: 200, body: toolResult(id, err.message, true) };
      throw err;
    }
  }
  return { status: 200, body: rpcError(id, -32601, "Method not found: " + message.method) };
}

module.exports = {
  SUPPORTED_VERSIONS: SUPPORTED_VERSIONS,
  handleMessage: handleMessage,
  publicTools: publicTools
};
