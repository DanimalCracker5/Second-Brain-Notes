"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const pricing = require("./pricing");
const billing = require("./billing");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const openaiSecret = defineSecret("OPENAI_API_KEY");
const geminiSecret = defineSecret("GEMINI_API_KEY");
const elevenSecret = defineSecret("ELEVENLABS_API_KEY");
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

const APP_URL = process.env.APP_URL || "https://secondbrainnotes.com";
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const CREDIT_PACKS = [
  { id: "credits_5", dollars: 5, label: "$5" },
  { id: "credits_10", dollars: 10, label: "$10" },
  { id: "credits_25", dollars: 25, label: "$25" },
  { id: "credits_50", dollars: 50, label: "$50" }
];

function originAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host === "secondbrainnotes.com" || host.endsWith(".secondbrainnotes.com")) return true;
    if (host.endsWith(".github.io")) return true;
    if (host.endsWith(".web.app") || host.endsWith(".firebaseapp.com")) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  } else if (!origin) {
    res.set("Access-Control-Allow-Origin", "*");
  }
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Max-Age", "3600");
}

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  const code = err && err.code ? err.code : "INTERNAL";
  const message = (err && err.message) || "Hosted AI failed.";
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message, code: code });
}

async function verifyUser(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = billing.billingError("UNAUTHENTICATED", "Sign in to use hosted AI credits.", 401);
    throw err;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    if (!decoded || !decoded.uid) throw new Error("missing uid");
    return decoded;
  } catch (e) {
    throw billing.billingError("UNAUTHENTICATED", "Your sign-in expired. Sign in again to use credits.", 401);
  }
}

function billingRef(uid) {
  return db.collection("billing").doc(uid);
}

function eventsRef(uid) {
  return billingRef(uid).collection("events");
}

async function readState(tx, uid) {
  const snap = await tx.get(billingRef(uid));
  const data = snap.exists ? snap.data() : {};
  return {
    billing: data,
    holds: Array.isArray(data.holds) ? data.holds : []
  };
}

function writeState(tx, uid, next) {
  const payload = Object.assign({}, next.billing, { holds: next.holds || [] });
  tx.set(billingRef(uid), payload, { merge: true });
}

async function withHold(uid, estimateMicros, meta, work) {
  const started = await db.runTransaction(async function (tx) {
    const state = await readState(tx, uid);
    const next = billing.holdCredits(state, estimateMicros, meta);
    writeState(tx, uid, next);
    return next.hold;
  });
  try {
    const result = await work(started);
    const settled = await db.runTransaction(async function (tx) {
      const state = await readState(tx, uid);
      const next = billing.settleHold(state, started.id, result.providerMicros, result.meta);
      writeState(tx, uid, next);
      if (next.event) tx.set(eventsRef(uid).doc(), next.event);
      return next;
    });
    return {
      hold: started,
      billing: billing.publicBilling(settled.billing),
      usage: settled.event,
      result: result.body
    };
  } catch (err) {
    try {
      await db.runTransaction(async function (tx) {
        const state = await readState(tx, uid);
        writeState(tx, uid, billing.releaseHold(state, started.id));
      });
    } catch (releaseErr) {
      console.error("Failed to release hosted AI hold", releaseErr);
    }
    throw err;
  }
}

function openaiHeaders() {
  const key = openaiSecret.value();
  if (!key) throw billing.billingError("NOT_CONFIGURED", "Hosted OpenAI is not configured yet.", 503);
  return { Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

function geminiKey() {
  const key = geminiSecret.value();
  if (!key) throw billing.billingError("NOT_CONFIGURED", "Hosted Gemini is not configured yet.", 503);
  return key;
}

function elevenHeaders(json) {
  const key = elevenSecret.value();
  if (!key) throw billing.billingError("NOT_CONFIGURED", "Hosted voice is not configured yet.", 503);
  const headers = { "xi-api-key": key };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length > 48) {
    throw billing.billingError("REQUEST_TOO_LARGE", "That conversation is too long for one hosted request.", 413);
  }
  return messages.slice(-48).map(function (message) {
    if (!message || typeof message !== "object") return { role: "user", content: "" };
    const role = ["system", "user", "assistant", "tool"].indexOf(message.role) >= 0 ? message.role : "user";
    const out = { role: role };
    if (typeof message.content === "string") out.content = message.content.slice(0, 120000);
    else if (message.content == null) {
      if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) out.content = null;
      else out.content = "";
    }
    else out.content = JSON.stringify(message.content).slice(0, 120000);
    if (role === "tool") {
      out.name = String(message.name || "tool").slice(0, 64);
      out.tool_call_id = String(message.tool_call_id || "").slice(0, 128);
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      out.tool_calls = message.tool_calls.slice(0, 8).map(function (call) {
        return {
          id: String(call && call.id || "").slice(0, 128),
          type: "function",
          function: {
            name: String(call && call.function && call.function.name || "tool").slice(0, 64),
            arguments: String(call && call.function && call.function.arguments || "{}").slice(0, 20000)
          }
        };
      });
    }
    return out;
  });
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 24).map(function (tool) {
    const fn = tool && tool.function || {};
    return {
      type: "function",
      function: {
        name: String(fn.name || "tool").slice(0, 64),
        description: String(fn.description || "").slice(0, 2000),
        parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} }
      }
    };
  });
}

function sanitizeToolChoice(raw, tools) {
  if (!tools.length) return undefined;
  const names = {};
  tools.forEach(function (tool) {
    if (tool && tool.function && tool.function.name) names[tool.function.name] = true;
  });
  if (raw && typeof raw === "object") {
    const name = String(raw.function && raw.function.name || raw.name || "").slice(0, 64);
    if (name && names[name]) return { type: "function", function: { name: name } };
  }
  if (raw === "required" || raw === "any") return "required";
  if (typeof raw === "string" && names[raw]) return { type: "function", function: { name: raw } };
  return "auto";
}

function openaiToGeminiTools(tools) {
  const decls = sanitizeTools(tools).map(function (tool) {
    return {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    };
  });
  return decls.length ? [{ functionDeclarations: decls }] : [];
}

function messagesToGemini(messages) {
  const system = [];
  const contents = [];
  sanitizeMessages(messages).forEach(function (message) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
      return;
    }
    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: message.name || "tool", response: { result: String(message.content || "") } } }]
      });
      return;
    }
    if (message.role === "assistant") {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      (message.tool_calls || []).forEach(function (call) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { args = {}; }
        parts.push({ functionCall: { name: call.function.name, args: args } });
      });
      if (parts.length) contents.push({ role: "model", parts: parts });
      return;
    }
    contents.push({ role: "user", parts: [{ text: String(message.content || "") }] });
  });
  return { system: system.join("\n\n"), contents: contents };
}

function geminiToOpenAI(data) {
  const candidate = data && data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts || [];
  const text = [];
  const toolCalls = [];
  parts.forEach(function (part, index) {
    if (part.thought) return;
    if (part.text) text.push(part.text);
    if (part.functionCall && part.functionCall.name) {
      toolCalls.push({
        id: "gemini_" + index + "_" + part.functionCall.name,
        type: "function",
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
      });
    }
  });
  const usage = data && data.usageMetadata;
  return {
    choices: [{ message: { role: "assistant", content: text.join("\n") || null, tool_calls: toolCalls.length ? toolCalls : undefined } }],
    usage: usage ? {
      prompt_tokens: Number(usage.promptTokenCount) || 0,
      completion_tokens: Number(usage.candidatesTokenCount) || 0,
      total_tokens: Number(usage.totalTokenCount) || 0
    } : undefined
  };
}

async function callOpenAIChat(body) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: openaiHeaders(),
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!response.ok) {
    const message = data && data.error && (data.error.message || data.error) || raw.slice(0, 240) || "OpenAI request failed.";
    throw billing.billingError("PROVIDER", "OpenAI " + response.status + ": " + message, 502);
  }
  if (!data) throw billing.billingError("PROVIDER", "OpenAI returned an unreadable response.", 502);
  return data;
}

async function callGeminiChat(model, payload) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(geminiKey());
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!response.ok) {
    const message = data && data.error && (data.error.message || data.error.status) || raw.slice(0, 240) || "Gemini request failed.";
    throw billing.billingError("PROVIDER", "Gemini " + response.status + ": " + message, 502);
  }
  if (!data) throw billing.billingError("PROVIDER", "Gemini returned an unreadable response.", 502);
  return geminiToOpenAI(data);
}

function usageFromResult(data) {
  const raw = data && data.usage || {};
  const input = Number(raw.prompt_tokens || raw.input_tokens) || 0;
  const output = Number(raw.completion_tokens || raw.output_tokens) || 0;
  const total = Number(raw.total_tokens) || (input + output);
  return { input: input, output: output, total: total };
}

async function handleChat(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const model = pricing.assertChatModel(body.model);
  const role = body.role === "subconscious" || body.role === "utility" ? body.role : "conscious";
  const messages = sanitizeMessages(body.messages);
  const tools = sanitizeTools(body.tools);
  const toolChoice = sanitizeToolChoice(body.toolChoice || body.tool_choice, tools);
  const maxTokens = pricing.clampOutputTokens(body.maxTokens || body.max_tokens, role);
  const temperature = typeof body.temperature === "number" ? Math.max(0, Math.min(2, body.temperature)) : undefined;
  const estimate = pricing.estimateChatHoldMicros(model, messages, maxTokens, role);
  const settled = await withHold(user.uid, estimate, { kind: "chat", role: role, model: model }, async function () {
    let data;
    if (pricing.isGeminiModel(model)) {
      const converted = messagesToGemini(messages);
      const payload = { contents: converted.contents, generationConfig: { maxOutputTokens: maxTokens } };
      if (converted.system) payload.systemInstruction = { parts: [{ text: converted.system }] };
      if (typeof temperature === "number") payload.generationConfig.temperature = temperature;
      if (body.json) payload.generationConfig.responseMimeType = "application/json";
      const geminiTools = openaiToGeminiTools(tools);
      if (geminiTools.length) {
        payload.tools = geminiTools;
        if (toolChoice && toolChoice !== "auto") {
          const forced = toolChoice.function && toolChoice.function.name;
          payload.toolConfig = forced
            ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [forced] } }
            : { functionCallingConfig: { mode: "ANY" } };
        }
      }
      data = await callGeminiChat(model, payload);
    } else {
      const payload = { model: model, messages: messages };
      if (tools.length) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || "auto";
        if (toolChoice && toolChoice !== "auto") payload.parallel_tool_calls = false;
      }
      if (body.json) payload.response_format = { type: "json_object" };
      if (typeof temperature === "number") payload.temperature = temperature;
      if (/^(o[1-9]\b|gpt-5)/i.test(model)) payload.max_completion_tokens = maxTokens;
      else payload.max_tokens = maxTokens;
      data = await callOpenAIChat(payload);
    }
    const used = usageFromResult(data);
    const providerMicros = pricing.chatProviderMicros(model, used.input || pricing.estimateInputTokens(messages), used.output || 32);
    return {
      providerMicros: providerMicros,
      body: data,
      meta: {
        kind: "chat",
        role: role,
        model: model,
        agentId: String(body.agentId || "").slice(0, 80),
        agentName: String(body.agentName || "").slice(0, 80),
        inputTokens: used.input,
        outputTokens: used.output
      }
    };
  });
  res.json({
    choices: settled.result && settled.result.choices,
    usage: settled.result && settled.result.usage,
    billing: settled.billing,
    hosted: settled.usage
  });
}

function safeVoiceId(value) {
  const id = String(value || "").trim();
  if (!id) return DEFAULT_VOICE;
  if (!/^[A-Za-z0-9]{18,64}$/.test(id)) {
    throw billing.billingError("INVALID_VOICE", "That voice id is not allowed on hosted credits.", 400);
  }
  return id;
}

async function handleTts(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body.text || "").trim();
  if (!text) throw billing.billingError("INVALID_REQUEST", "Nothing to speak.", 400);
  if (text.length > pricing.MAX_TTS_CHARS) throw billing.billingError("REQUEST_TOO_LARGE", "That voice request is too long.", 413);
  const voiceId = safeVoiceId(body.voiceId);
  const estimate = pricing.estimateTtsHoldMicros(text);
  const settled = await withHold(user.uid, estimate, { kind: "voice", role: "voice", model: "eleven_multilingual_v2" }, async function () {
    const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId), {
      method: "POST",
      headers: Object.assign(elevenHeaders(true), { Accept: "audio/mpeg" }),
      body: JSON.stringify({ text: text, model_id: "eleven_multilingual_v2" })
    });
    if (!response.ok) {
      const raw = await response.text();
      throw billing.billingError("PROVIDER", "Voice " + response.status + ": " + raw.slice(0, 200), 502);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      providerMicros: pricing.ttsProviderMicros(text),
      body: buffer,
      meta: {
        kind: "voice",
        role: "voice",
        model: "eleven_multilingual_v2",
        agentId: String(body.agentId || "").slice(0, 80),
        agentName: String(body.agentName || "").slice(0, 80),
        chars: text.length
      }
    };
  });
  res.set("Content-Type", "audio/mpeg");
  res.set("X-Hosted-Billed-Micros", String(settled.usage.billedMicros));
  res.set("X-Hosted-Provider-Micros", String(settled.usage.providerMicros));
  res.set("X-Hosted-Balance-Micros", String(settled.billing.balanceMicros));
  res.set("X-Hosted-Usage", encodeURIComponent(JSON.stringify(settled.usage)));
  res.send(settled.result);
}

async function handleStt(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const audio = body.audio || body.file;
  if (!audio) throw billing.billingError("INVALID_REQUEST", "No audio was sent.", 400);
  const raw = Buffer.from(String(audio), "base64");
  const mimeType = String(body.mimeType || "audio/webm").slice(0, 80);
  const filename = String(body.filename || "speech.webm").replace(/[^\w.\-]+/g, "").slice(0, 80) || "speech.webm";
  if (raw.length > pricing.MAX_STT_BYTES) throw billing.billingError("REQUEST_TOO_LARGE", "That recording is too large to transcribe.", 413);
  const seconds = pricing.audioSecondsFromBytes(raw.length, mimeType);
  const estimate = pricing.estimateSttHoldMicros(raw.length, mimeType, "scribe");
  const settled = await withHold(user.uid, estimate, { kind: "voice", role: "voice", model: "scribe_v1" }, async function () {
    const form = new FormData();
    form.append("file", new Blob([raw], { type: mimeType }), filename);
    form.append("model_id", "scribe_v1");
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: elevenHeaders(false),
      body: form
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!response.ok) {
      const detail = data && data.detail;
      const message = (detail && detail.message) || (typeof detail === "string" ? detail : text.slice(0, 200)) || "Transcription failed.";
      throw billing.billingError("PROVIDER", "Voice " + response.status + ": " + message, 502);
    }
    return {
      providerMicros: pricing.sttProviderMicros(seconds, "scribe"),
      body: { text: String(data && data.text || "").trim() },
      meta: {
        kind: "voice",
        role: "voice",
        model: "scribe_v1",
        agentId: String(body.agentId || "").slice(0, 80),
        agentName: String(body.agentName || "").slice(0, 80),
        seconds: seconds,
        chars: String(data && data.text || "").length
      }
    };
  });
  res.json({ text: settled.result.text, billing: settled.billing, hosted: settled.usage });
}

const PUBLIC_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura" }
];

async function handleVoices(req, res) {
  const voiceId = String(req.query.voiceId || "").trim();
  if (!voiceId) {
    res.json({ voices: PUBLIC_VOICES });
    return;
  }
  safeVoiceId(voiceId);
  const known = PUBLIC_VOICES.find(function (voice) { return voice.id === voiceId; });
  if (known) {
    res.json({ voices: [known] });
    return;
  }
  const url = "https://api.elevenlabs.io/v2/voices?voice_ids=" + encodeURIComponent(voiceId) + "&page_size=1&include_total_count=false";
  const response = await fetch(url, { headers: elevenHeaders(false) });
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!response.ok) throw billing.billingError("PROVIDER", "Could not check that voice.", 502);
  const voices = ((data && data.voices) || []).map(function (voice) {
    return { id: voice.voice_id || voice.id, name: voice.name || voice.voice_id || "Voice" };
  }).filter(function (voice) { return voice.id; });
  res.json({ voices: voices });
}

async function handleBilling(req, res, user) {
  const snap = await billingRef(user.uid).get();
  const data = snap.exists ? snap.data() : {};
  const eventsSnap = await eventsRef(user.uid).orderBy("ts", "desc").limit(40).get();
  const events = eventsSnap.docs.map(function (doc) {
    const row = doc.data() || {};
    return {
      ts: row.ts || 0,
      kind: row.kind || "chat",
      role: row.role || "",
      model: row.model || "",
      agentId: row.agentId || "",
      agentName: row.agentName || "",
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      chars: row.chars || 0,
      seconds: row.seconds || 0,
      providerMicros: row.providerMicros || 0,
      billedMicros: row.billedMicros || 0,
      paidMicros: row.paidMicros || 0
    };
  });
  res.json(Object.assign(billing.publicBilling(data, events), { packs: CREDIT_PACKS }));
}

function packById(id) {
  return CREDIT_PACKS.find(function (pack) { return pack.id === id; }) || null;
}

async function handleCheckout(req, res, user) {
  const secret = stripeSecret.value();
  if (!secret) throw billing.billingError("NOT_CONFIGURED", "Card payments are not configured yet.", 503);
  const Stripe = require("stripe");
  const stripe = new Stripe(secret);
  const pack = packById(req.body && req.body.packId) || packById("credits_10");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: user.email || undefined,
    client_reference_id: user.uid,
    metadata: { uid: user.uid, packId: pack.id },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: pack.dollars * 100,
        product_data: {
          name: "Second Brain AI credits (" + pack.label + ")",
          description: "Prepaid hosted AI. $" + pack.dollars + " covers about $" + (pack.dollars / pricing.MARKUP).toFixed(2) + " of model and voice cost."
        }
      }
    }],
    success_url: APP_URL.replace(/\/$/, "") + "/?credits=success",
    cancel_url: APP_URL.replace(/\/$/, "") + "/?credits=cancel"
  });
  res.json({ url: session.url, packId: pack.id });
}

async function handleStripeWebhook(req, res) {
  const secret = stripeSecret.value();
  const webhook = stripeWebhookSecret.value();
  if (!secret || !webhook) {
    res.status(503).send("Stripe is not configured");
    return;
  }
  const Stripe = require("stripe");
  const stripe = new Stripe(secret);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], webhook);
  } catch (err) {
    res.status(400).send("Invalid Stripe signature");
    return;
  }
  if (event.type !== "checkout.session.completed") {
    res.json({ received: true });
    return;
  }
  const session = event.data && event.data.object || {};
  if (session.payment_status && session.payment_status !== "paid") {
    res.json({ received: true, ignored: true });
    return;
  }
  const uid = (session.metadata && session.metadata.uid) || session.client_reference_id;
  const packId = (session.metadata && session.metadata.packId) || "credits";
  const paidMicros = Math.round((Number(session.amount_total) || 0) * 10000);
  if (!uid || !paidMicros) {
    res.status(400).send("Missing payment identity");
    return;
  }
  const purchaseRef = billingRef(uid).collection("purchases").doc(String(session.id));
  await db.runTransaction(async function (tx) {
    const existing = await tx.get(purchaseRef);
    if (existing.exists) return;
    const state = await readState(tx, uid);
    const next = billing.creditPurchase(state, paidMicros, session.id, packId);
    writeState(tx, uid, next);
    tx.set(purchaseRef, { ts: Date.now(), paidMicros: paidMicros, packId: packId });
    if (next.event) tx.set(eventsRef(uid).doc(), next.event);
  });
  res.json({ received: true });
}

async function handleRequest(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  const path = String(req.path || req.url || "/").split("?")[0].replace(/^\/ai(?=\/)/, "").replace(/\/+$/, "") || "/";
  try {
    if (path === "/catalog" && req.method === "GET") {
      res.json(Object.assign(pricing.catalog(), { packs: CREDIT_PACKS, markup: pricing.MARKUP }));
      return;
    }
    if (path === "/stripe" && req.method === "POST") {
      await handleStripeWebhook(req, res);
      return;
    }
    const user = await verifyUser(req);
    if (path === "/billing" && req.method === "GET") return handleBilling(req, res, user);
    if (path === "/checkout" && req.method === "POST") return handleCheckout(req, res, user);
    if (path === "/chat" && req.method === "POST") return handleChat(req, res, user);
    if (path === "/tts" && req.method === "POST") return handleTts(req, res, user);
    if (path === "/stt" && req.method === "POST") return handleStt(req, res, user);
    if (path === "/voices" && req.method === "GET") return handleVoices(req, res);
    res.status(404).json({ error: "Unknown hosted AI route.", code: "NOT_FOUND" });
  } catch (err) {
    sendError(res, err);
  }
}

const functionOpts = {
  region: "us-central1",
  timeoutSeconds: 120,
  memory: "512MiB",
  maxInstances: 20,
  cors: false,
  invoker: "public",
  secrets: [openaiSecret, geminiSecret, elevenSecret, stripeSecret, stripeWebhookSecret]
};

exports.ai = onRequest(functionOpts, handleRequest);
