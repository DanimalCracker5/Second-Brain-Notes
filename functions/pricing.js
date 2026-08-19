"use strict";

/**
 * Conservative provider rates used to bill hosted AI.
 * Amounts are USD per 1,000,000 tokens unless noted.
 * Rates are rounded up on purpose so a pricing-table miss cannot
 * charge the operator more than the user paid.
 *
 * Markup is applied after the provider cost: billed = provider * MARKUP.
 */
const MARKUP = 5;
const MICROS = 1000000;
const MIN_BILLED_MICROS = 1000; // $0.001 billed floor per settled call
const MAX_INPUT_CHARS = 180000;
const MAX_CHAT_OUTPUT_TOKENS = 4096;
const MAX_TTS_CHARS = 4000;
const MAX_STT_BYTES = 8 * 1024 * 1024;
const MAX_STT_SECONDS = 8 * 60;

/** USD per million input / output tokens. Exact ids only — no prefix matching. */
const CHAT_RATES = {
  "gpt-4o-mini": { input: 0.2, output: 0.8 },
  "gpt-4o": { input: 3, output: 12 },
  "gpt-4.1-nano": { input: 0.15, output: 0.5 },
  "gpt-4.1-mini": { input: 0.5, output: 2 },
  "gpt-4.1": { input: 2.5, output: 10 },
  "gpt-5-nano": { input: 0.1, output: 0.6 },
  "gpt-5-mini": { input: 0.4, output: 2.5 },
  "gpt-5": { input: 6, output: 24 },
  "gpt-5.1": { input: 6, output: 24 },
  "gpt-5.2": { input: 6, output: 24 },
  "gpt-5.4-nano": { input: 0.2, output: 0.9 },
  "gpt-5.4-mini": { input: 0.6, output: 3 },
  "gpt-5.4": { input: 6, output: 24 },
  "gpt-5.6-luna": { input: 0.5, output: 2.5 },
  "gpt-5.6-terra": { input: 6, output: 24 },
  "gpt-5.6-sol": { input: 12, output: 48 },
  "gpt-5.6": { input: 8, output: 32 },
  "o3": { input: 12, output: 48 },
  "o4-mini": { input: 2, output: 8 },
  "gemini-2.0-flash": { input: 0.15, output: 0.5 },
  "gemini-2.5-flash-lite": { input: 0.15, output: 0.5 },
  "gemini-2.5-flash": { input: 0.4, output: 3 },
  "gemini-2.5-pro": { input: 1.5, output: 12 },
  "gemini-flash-latest": { input: 0.5, output: 3.5 },
  "gemini-3-flash-preview": { input: 0.6, output: 4 },
  "gemini-3.5-flash": { input: 0.5, output: 3.5 },
  "gemini-3.6-flash": { input: 0.6, output: 4 },
  "gemini-3.7-flash": { input: 0.6, output: 4 }
};

const HOSTED_MODELS = {
  subconscious: [
    "gemini-3.7-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gpt-5.6-luna",
    "gpt-5.4-nano",
    "gpt-5-nano",
    "gpt-4.1-mini",
    "gpt-4o-mini"
  ],
  conscious: [
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5",
    "gemini-3.7-flash",
    "gemini-2.5-pro",
    "gpt-4.1",
    "gpt-4o"
  ]
};

const TTS_USD_PER_1K_CHARS = 0.36;
const STT_USD_PER_MINUTE = 0.01;
const WHISPER_USD_PER_MINUTE = 0.01;

function isGeminiModel(id) {
  return /^gemini[-.]/i.test(id || "");
}

function allowedChatModels() {
  return Object.keys(CHAT_RATES);
}

function assertChatModel(id) {
  const model = String(id || "").trim();
  if (!CHAT_RATES[model]) {
    const err = new Error("That model is not available on hosted credits.");
    err.code = "MODEL_NOT_ALLOWED";
    err.status = 400;
    throw err;
  }
  return model;
}

function usdToMicros(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(usd * MICROS);
}

function tokensToUsd(tokens, usdPerMillion) {
  const count = Math.max(0, Math.ceil(Number(tokens) || 0));
  return (count / 1000000) * usdPerMillion;
}

function chatProviderMicros(model, inputTokens, outputTokens) {
  const rates = CHAT_RATES[assertChatModel(model)];
  const usd = tokensToUsd(inputTokens, rates.input) + tokensToUsd(outputTokens, rates.output);
  return usdToMicros(usd);
}

function estimateInputTokens(messages) {
  const raw = JSON.stringify(messages || []);
  if (raw.length > MAX_INPUT_CHARS) {
    const err = new Error("That request is too large for hosted credits.");
    err.code = "REQUEST_TOO_LARGE";
    err.status = 413;
    throw err;
  }
  return Math.ceil(raw.length / 3);
}

function clampOutputTokens(value, role) {
  const cap = role === "subconscious" || role === "utility" ? 256 : MAX_CHAT_OUTPUT_TOKENS;
  const n = Math.ceil(Number(value) || cap);
  return Math.max(16, Math.min(cap, n));
}

function estimateChatHoldMicros(model, messages, maxTokens, role) {
  const input = estimateInputTokens(messages);
  const output = clampOutputTokens(maxTokens, role);
  return Math.max(MIN_BILLED_MICROS, billedMicros(chatProviderMicros(model, input, output)));
}

function ttsProviderMicros(chars) {
  const count = Math.max(0, String(chars || "").length);
  if (count > MAX_TTS_CHARS) {
    const err = new Error("That voice request is too long.");
    err.code = "REQUEST_TOO_LARGE";
    err.status = 413;
    throw err;
  }
  return usdToMicros((count / 1000) * TTS_USD_PER_1K_CHARS);
}

function estimateTtsHoldMicros(text) {
  return Math.max(MIN_BILLED_MICROS, billedMicros(ttsProviderMicros(text)));
}

function audioSecondsFromBytes(bytes, mimeType) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size > MAX_STT_BYTES) {
    const err = new Error("That recording is too large to transcribe.");
    err.code = "REQUEST_TOO_LARGE";
    err.status = 413;
    throw err;
  }
  const bitsPerSecond = /ogg|opus|webm/i.test(mimeType || "") ? 24000 : 128000;
  const seconds = (size * 8) / bitsPerSecond;
  return Math.max(15, Math.min(MAX_STT_SECONDS, Math.ceil(seconds)));
}

function sttProviderMicros(seconds, kind) {
  const mins = Math.max(1 / 60, (Number(seconds) || 0) / 60);
  const rate = kind === "whisper" ? WHISPER_USD_PER_MINUTE : STT_USD_PER_MINUTE;
  return usdToMicros(mins * rate);
}

function estimateSttHoldMicros(bytes, mimeType, kind) {
  return Math.max(MIN_BILLED_MICROS, billedMicros(sttProviderMicros(audioSecondsFromBytes(bytes, mimeType), kind)));
}

function billedMicros(providerMicros) {
  const billed = Math.ceil((Math.max(0, Number(providerMicros) || 0) * MARKUP));
  return Math.max(MIN_BILLED_MICROS, billed);
}

function formatUsd(micros) {
  const value = (Math.max(0, Number(micros) || 0) / MICROS);
  return "$" + value.toFixed(value >= 10 ? 2 : 2);
}

function catalog() {
  return {
    markup: MARKUP,
    models: HOSTED_MODELS,
    rates: CHAT_RATES,
    ttsUsdPer1kChars: TTS_USD_PER_1K_CHARS,
    sttUsdPerMinute: STT_USD_PER_MINUTE
  };
}

module.exports = {
  MARKUP,
  MICROS,
  MIN_BILLED_MICROS,
  MAX_INPUT_CHARS,
  MAX_CHAT_OUTPUT_TOKENS,
  MAX_TTS_CHARS,
  MAX_STT_BYTES,
  CHAT_RATES,
  HOSTED_MODELS,
  isGeminiModel,
  allowedChatModels,
  assertChatModel,
  usdToMicros,
  chatProviderMicros,
  estimateInputTokens,
  clampOutputTokens,
  estimateChatHoldMicros,
  ttsProviderMicros,
  estimateTtsHoldMicros,
  audioSecondsFromBytes,
  sttProviderMicros,
  estimateSttHoldMicros,
  billedMicros,
  formatUsd,
  catalog
};
