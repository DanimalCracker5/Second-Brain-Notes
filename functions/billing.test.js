"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const billing = require("./billing");
const pricing = require("./pricing");

test("users cannot spend more credits than they prepaid", function () {
  const empty = { billing: billing.emptyBilling(), holds: [] };
  assert.throws(function () {
    billing.holdCredits(empty, 5000, { kind: "chat" }, 1000);
  }, /more AI credits/);
});

test("settle deducts 5x provider cost from prepaid balance", function () {
  const paid = billing.creditPurchase({ billing: billing.emptyBilling(), holds: [] }, 5 * pricing.MICROS, "sess_1", "credits_5", 1);
  const held = billing.holdCredits({ billing: paid.billing, holds: paid.holds }, 200000, { kind: "chat", holdId: "h1" }, 2);
  const settled = billing.settleHold({ billing: held.billing, holds: held.holds }, "h1", 20000, { kind: "chat", role: "conscious", model: "gpt-4o-mini" }, 3);
  assert.equal(settled.event.billedMicros, 100000);
  assert.equal(settled.billing.balanceMicros, 5 * pricing.MICROS - 100000);
  assert.equal(settled.billing.heldMicros, 0);
  assert.equal(settled.holds.length, 0);
});

test("released holds do not keep the balance frozen", function () {
  const paid = billing.creditPurchase({ billing: billing.emptyBilling(), holds: [] }, 1000000, "sess_2", "credits_5", 1);
  const held = billing.holdCredits({ billing: paid.billing, holds: paid.holds }, 400000, { holdId: "h2" }, 2);
  assert.equal(billing.availableMicros(held.billing), 600000);
  const released = billing.releaseHold({ billing: held.billing, holds: held.holds }, "h2", 3);
  assert.equal(billing.availableMicros(released.billing), 1000000);
});

test("stripe purchases are idempotent", function () {
  const first = billing.creditPurchase({ billing: billing.emptyBilling(), holds: [], processedStripeIds: {} }, 1000, "sess_3", "credits_5", 1);
  const second = billing.creditPurchase({
    billing: first.billing,
    holds: first.holds,
    processedStripeIds: { sess_3: true }
  }, 1000, "sess_3", "credits_5", 2);
  assert.equal(second.duplicate, true);
  assert.equal(second.billing.balanceMicros, 1000);
});

test("rate limit blocks a burst of hosted calls", function () {
  let state = { billing: Object.assign(billing.emptyBilling(), { balanceMicros: 999999999 }), holds: [] };
  let threw = false;
  for (let i = 0; i < billing.MAX_REQUESTS_PER_MINUTE + 2; i++) {
    try {
      const next = billing.holdCredits(state, 1000, { holdId: "r" + i }, 50);
      next.holds = [];
      next.billing.heldMicros = 0;
      state = next;
    } catch (err) {
      threw = err.code === "RATE_LIMIT";
      break;
    }
  }
  assert.equal(threw, true);
});

test("public billing never exposes a writable balance field the client could trust", function () {
  const view = billing.publicBilling({ balanceMicros: 900, heldMicros: 100, lifetimePaidMicros: 1000 });
  assert.equal(view.balanceMicros, 800);
  assert.equal(view.markup, 5);
  assert.ok(!("holds" in view));
});
