"use strict";

const pricing = require("./pricing");

const MAX_CONCURRENT_HOLDS = 2;
const MAX_REQUESTS_PER_MINUTE = 30;
const HOLD_TTL_MS = 3 * 60 * 1000;

function billingError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status || 400;
  return err;
}

function emptyBilling() {
  return {
    balanceMicros: 0,
    heldMicros: 0,
    lifetimePaidMicros: 0,
    lifetimeBilledMicros: 0,
    lifetimeProviderMicros: 0,
    windowStartMs: 0,
    windowCount: 0,
    updatedAt: 0
  };
}

function normalizeBilling(data) {
  const out = emptyBilling();
  const src = data && typeof data === "object" ? data : {};
  Object.keys(out).forEach(function (key) {
    const n = Number(src[key]);
    out[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  });
  return out;
}

function availableMicros(bill) {
  return Math.max(0, (bill.balanceMicros || 0) - (bill.heldMicros || 0));
}

function publicBilling(bill, events) {
  const normalized = normalizeBilling(bill);
  const available = availableMicros(normalized);
  return {
    balanceMicros: available,
    reservedMicros: normalized.heldMicros,
    prepaidMicros: normalized.balanceMicros,
    lifetimePaidMicros: normalized.lifetimePaidMicros,
    lifetimeBilledMicros: normalized.lifetimeBilledMicros,
    lifetimeProviderMicros: normalized.lifetimeProviderMicros,
    providerBudgetMicros: Math.floor(available / pricing.MARKUP),
    markup: pricing.MARKUP,
    events: Array.isArray(events) ? events : []
  };
}

function pruneHolds(holds, now) {
  const live = [];
  let held = 0;
  (holds || []).forEach(function (hold) {
    if (!hold || hold.status !== "held") return;
    if ((now - (hold.createdAt || 0)) > HOLD_TTL_MS) return;
    live.push(hold);
    held += Math.max(0, Number(hold.estimateMicros) || 0);
  });
  return { live: live, heldMicros: held };
}

function applyRateLimit(bill, now) {
  if (!bill.windowStartMs || now - bill.windowStartMs >= 60000) {
    bill.windowStartMs = now;
    bill.windowCount = 0;
  }
  bill.windowCount += 1;
  if (bill.windowCount > MAX_REQUESTS_PER_MINUTE) {
    throw billingError("RATE_LIMIT", "Too many hosted AI requests. Wait a moment and try again.", 429);
  }
}

function holdCredits(state, estimateMicros, meta, now) {
  now = now || Date.now();
  const bill = normalizeBilling(state.billing);
  const pruned = pruneHolds(state.holds, now);
  applyRateLimit(bill, now);
  if (pruned.live.length >= MAX_CONCURRENT_HOLDS) {
    throw billingError("BUSY", "Another hosted request is still running. Try again in a few seconds.", 429);
  }
  const estimate = Math.max(pricing.MIN_BILLED_MICROS, Math.ceil(Number(estimateMicros) || 0));
  bill.heldMicros = pruned.heldMicros;
  if (availableMicros(bill) < estimate) {
    throw billingError(
      "INSUFFICIENT_CREDITS",
      "You need more AI credits for this. Buy credits in Settings → AI credits.",
      402
    );
  }
  const hold = {
    id: meta && meta.holdId || ("h_" + now.toString(36) + Math.random().toString(36).slice(2, 8)),
    estimateMicros: estimate,
    createdAt: now,
    status: "held",
    kind: (meta && meta.kind) || "chat",
    role: (meta && meta.role) || "",
    model: (meta && meta.model) || ""
  };
  pruned.live.push(hold);
  bill.heldMicros += estimate;
  bill.updatedAt = now;
  return { billing: bill, holds: pruned.live, hold: hold };
}

function settleHold(state, holdId, providerMicros, meta, now) {
  now = now || Date.now();
  const bill = normalizeBilling(state.billing);
  const pruned = pruneHolds(state.holds, now);
  const idx = pruned.live.findIndex(function (hold) { return hold.id === holdId; });
  if (idx < 0) {
    throw billingError("HOLD_MISSING", "That hosted request is no longer reserved.", 409);
  }
  const hold = pruned.live[idx];
  const billed = pricing.billedMicros(providerMicros);
  const charge = Math.min(billed, bill.balanceMicros);
  bill.balanceMicros -= charge;
  bill.heldMicros = Math.max(0, pruned.heldMicros - hold.estimateMicros);
  bill.lifetimeBilledMicros += charge;
  bill.lifetimeProviderMicros += Math.max(0, Math.ceil(Number(providerMicros) || 0));
  bill.updatedAt = now;
  pruned.live.splice(idx, 1);
  const event = {
    ts: now,
    kind: (meta && meta.kind) || hold.kind || "chat",
    role: (meta && meta.role) || hold.role || "conscious",
    model: (meta && meta.model) || hold.model || "",
    agentId: (meta && meta.agentId) || "",
    agentName: (meta && meta.agentName) || "",
    inputTokens: Math.max(0, Math.floor(Number(meta && meta.inputTokens) || 0)),
    outputTokens: Math.max(0, Math.floor(Number(meta && meta.outputTokens) || 0)),
    chars: Math.max(0, Math.floor(Number(meta && meta.chars) || 0)),
    seconds: Math.max(0, Number(meta && meta.seconds) || 0),
    providerMicros: Math.max(0, Math.ceil(Number(providerMicros) || 0)),
    billedMicros: charge,
    holdId: holdId
  };
  return { billing: bill, holds: pruned.live, event: event, shortfall: billed - charge };
}

function releaseHold(state, holdId, now) {
  now = now || Date.now();
  const bill = normalizeBilling(state.billing);
  const pruned = pruneHolds(state.holds, now);
  const idx = pruned.live.findIndex(function (hold) { return hold.id === holdId; });
  if (idx >= 0) {
    bill.heldMicros = Math.max(0, pruned.heldMicros - pruned.live[idx].estimateMicros);
    pruned.live.splice(idx, 1);
  } else {
    bill.heldMicros = pruned.heldMicros;
  }
  bill.updatedAt = now;
  return { billing: bill, holds: pruned.live };
}

function creditPurchase(state, paidMicros, stripeId, packId, now) {
  now = now || Date.now();
  const bill = normalizeBilling(state.billing);
  const paid = Math.max(0, Math.floor(Number(paidMicros) || 0));
  if (!paid) throw billingError("INVALID_PURCHASE", "That payment could not be credited.", 400);
  if (state.processedStripeIds && state.processedStripeIds[stripeId]) {
    return { billing: bill, holds: pruneHolds(state.holds, now).live, duplicate: true };
  }
  bill.balanceMicros += paid;
  bill.lifetimePaidMicros += paid;
  bill.updatedAt = now;
  const event = {
    ts: now,
    kind: "purchase",
    role: "credits",
    model: packId || "credits",
    agentId: "",
    agentName: "",
    inputTokens: 0,
    outputTokens: 0,
    chars: 0,
    seconds: 0,
    providerMicros: 0,
    billedMicros: 0,
    paidMicros: paid,
    stripeId: stripeId || "",
    holdId: ""
  };
  return { billing: bill, holds: pruneHolds(state.holds, now).live, event: event, duplicate: false };
}

module.exports = {
  MAX_CONCURRENT_HOLDS,
  MAX_REQUESTS_PER_MINUTE,
  HOLD_TTL_MS,
  billingError,
  emptyBilling,
  normalizeBilling,
  availableMicros,
  publicBilling,
  pruneHolds,
  holdCredits,
  settleHold,
  releaseHold,
  creditPurchase
};
