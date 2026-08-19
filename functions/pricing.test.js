"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("./pricing");

test("markup is 5x provider cost", function () {
  assert.equal(pricing.MARKUP, 5);
  assert.equal(pricing.billedMicros(10000), 50000);
});

test("unknown models are rejected instead of billed at a guess", function () {
  assert.throws(function () { pricing.assertChatModel("totally-made-up-model"); }, /not available/);
  assert.throws(function () { pricing.chatProviderMicros("gpt-4o-mini-but-expensive", 100, 100); });
});

test("hosted chat hold is billed micros and conservative", function () {
  const messages = [{ role: "user", content: "hello there, write a short note" }];
  const hold = pricing.estimateChatHoldMicros("gpt-4o-mini", messages, 64, "subconscious");
  const cheap = pricing.chatProviderMicros("gpt-4o-mini", 20, 20);
  assert.ok(hold >= pricing.billedMicros(cheap));
  assert.ok(hold >= pricing.MIN_BILLED_MICROS);
});

test("a dollar of provider cost bills five dollars of credits", function () {
  const oneDollar = pricing.MICROS;
  assert.equal(pricing.billedMicros(oneDollar), 5 * oneDollar);
});

test("tts and stt reject oversized payloads", function () {
  const huge = "a".repeat(pricing.MAX_TTS_CHARS + 1);
  assert.throws(function () { pricing.ttsProviderMicros(huge); }, /too long/);
  assert.throws(function () { pricing.audioSecondsFromBytes(pricing.MAX_STT_BYTES + 1, "audio/webm"); }, /too large/);
});

test("catalog only lists priced models", function () {
  const catalog = pricing.catalog();
  catalog.models.conscious.concat(catalog.models.subconscious).forEach(function (id) {
    assert.ok(pricing.CHAT_RATES[id], id + " missing from rate table");
  });
});
