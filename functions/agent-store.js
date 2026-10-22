"use strict";

const crypto = require("crypto");
const notes = require("./agent-notes");

const MAX_TOKENS = 8;

function httpError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status || 400;
  return err;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function cleanName(name) {
  const text = String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  return text || "Hermes";
}

function prefixOf(token) {
  return String(token).slice(0, 7) + "…";
}

function publicToken(data) {
  return {
    id: data.tokenId,
    name: data.name || "Hermes",
    prefix: data.prefix || "",
    createdAt: Number(data.createdAt) || 0,
    lastUsedAt: Number(data.lastUsedAt) || 0
  };
}

function createStore(db) {
  const tokens = db.collection("agentTokens");

  async function authenticateAgent(token) {
    const raw = String(token || "");
    if (raw.indexOf("sb_") !== 0 || raw.length < 20) {
      throw httpError("UNAUTHENTICATED", "Use a Second Brain agent token from Settings → Connect an agent. It starts with sb_.", 401);
    }
    const snap = await tokens.doc(hashToken(raw)).get();
    if (!snap.exists) throw httpError("UNAUTHENTICATED", "That agent token is not valid. Create a new one in Second Brain → Settings → Connect an agent.", 401);
    const data = snap.data() || {};
    if (data.revokedAt) throw httpError("UNAUTHENTICATED", "That agent token was revoked.", 401);
    if (!data.uid) throw httpError("UNAUTHENTICATED", "That agent token is not valid.", 401);
    const now = Date.now();
    if (!data.lastUsedAt || now - Number(data.lastUsedAt) > 60000) {
      await snap.ref.set({ lastUsedAt: now }, { merge: true });
    }
    return { uid: data.uid, tokenId: data.tokenId, name: data.name || "Hermes" };
  }

  async function listTokens(uid) {
    const snap = await tokens.where("uid", "==", uid).get();
    return snap.docs.map(function (doc) { return publicToken(doc.data() || {}); })
      .filter(function (row) { return row.id; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  async function createToken(uid, name) {
    const existing = await tokens.where("uid", "==", uid).get();
    if (existing.size >= MAX_TOKENS) {
      throw httpError("LIMIT", "You already have " + MAX_TOKENS + " agent tokens. Revoke one before creating another.", 409);
    }
    const token = "sb_" + crypto.randomBytes(32).toString("base64url");
    const tokenId = crypto.randomBytes(9).toString("base64url");
    const createdAt = Date.now();
    const record = {
      uid: uid,
      tokenId: tokenId,
      name: cleanName(name),
      prefix: prefixOf(token),
      createdAt: createdAt,
      lastUsedAt: 0,
      revokedAt: null
    };
    await tokens.doc(hashToken(token)).set(record);
    return {
      token: token,
      id: tokenId,
      name: record.name,
      prefix: record.prefix,
      createdAt: createdAt,
      mcpPath: "/mcp"
    };
  }

  async function revokeToken(uid, tokenId) {
    const snap = await tokens.where("uid", "==", uid).get();
    const doc = snap.docs.find(function (entry) { return (entry.data() || {}).tokenId === tokenId; });
    if (!doc) throw httpError("NOT_FOUND", "That token is already gone.", 404);
    await doc.ref.delete();
  }

  function userRef(uid) {
    return db.collection("users").doc(uid);
  }

  async function readAccount(uid) {
    const snap = await userRef(uid).get();
    return notes.accountFromData(snap.exists ? snap.data() : {});
  }

  async function commit(uid, mutator) {
    const ref = userRef(uid);
    return db.runTransaction(async function (tx) {
      const snap = await tx.get(ref);
      const account = notes.accountFromData(snap.exists ? snap.data() : {});
      const out = mutator(account);
      if (!out || !out.changed) return out;
      tx.set(ref, {
        items: out.account.items,
        tags: out.account.tags,
        deletedItems: out.account.deletedItems,
        deletedTags: out.account.deletedTags || {},
        version: out.account.version,
        versionChangedAt: out.account.versionChangedAt,
        updated: out.account.updated
      }, { merge: true });
      (out.changedItems || []).forEach(function (item) {
        tx.set(ref.collection("liveNotes").doc(item.id), {
          item: item,
          updated: out.account.updated,
          updatedBy: "agent",
          version: Number(item.version) || 1
        });
      });
      (out.deletedIds || []).forEach(function (id) {
        tx.delete(ref.collection("liveNotes").doc(id));
      });
      return out;
    });
  }

  return {
    authenticateAgent: authenticateAgent,
    listTokens: listTokens,
    createToken: createToken,
    revokeToken: revokeToken,
    readAccount: readAccount,
    commit: commit
  };
}

module.exports = {
  createStore: createStore,
  hashToken: hashToken,
  cleanName: cleanName,
  prefixOf: prefixOf
};
