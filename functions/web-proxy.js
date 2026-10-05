"use strict";

/*
  Authenticated page relay for Second Brain web sessions.

  The browser cannot read an arbitrary site (CORS) and many sites refuse to
  be embedded. This endpoint fetches a public http(s) page for a signed-in
  user and returns the HTML so the app can show it in a sandboxed frame.
  It is not an open proxy: private networks, metadata hosts, and non-web
  ports are refused before any connection is made.
*/

const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

const MAX_BYTES = 2200000;
const MAX_REDIRECTS = 5;
const HOP_MS = 12000;
const MAX_POST_BYTES = 100000;
const MAX_PER_MINUTE = 40;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const hits = new Map();

function fail(message, code, status) {
  const err = new Error(message);
  err.code = code || "BAD_URL";
  err.status = status || 400;
  return err;
}

function ipv4String(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function canonicalHost(hostname) {
  let host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (host.charAt(0) === "[" && host.charAt(host.length - 1) === "]") host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (n >= 0 && n <= 0xffffffff) return ipv4String(n);
  }
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n >= 0 && n <= 0xffffffff && String(n) === host) return ipv4String(n);
  }
  return host;
}

function addressIsPublic(address) {
  if (!address) return false;
  let ip = canonicalHost(address);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip === "::") return false;
  if (ip.indexOf("fe80:") === 0 || ip.indexOf("fc") === 0 || ip.indexOf("fd") === 0) return false;
  if (ip.indexOf("2001:db8:") === 0) return false;
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!parts) return ip.indexOf(":") >= 0;
  const nums = parts.slice(1).map(Number);
  if (nums.some(function (n) { return n > 255; })) return false;
  const a = nums[0];
  const b = nums[1];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false;
  return true;
}

function hostIsBlockedName(host) {
  if (!host) return true;
  if (host === "localhost" || host === "metadata.google.internal" || host === "metadata.google.com") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) return true;
  return false;
}

function targetFromUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); }
  catch (e) { return { ok: false, error: "That address is not a web page.", code: "BAD_URL", status: 400 }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only web pages can open in a session.", code: "BAD_URL", status: 400 };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Addresses with a username are not opened.", code: "BAD_URL", status: 400 };
  }
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  if (port !== 80 && port !== 443) {
    return { ok: false, error: "The relay only opens standard web pages.", code: "BAD_PORT", status: 400 };
  }
  const host = canonicalHost(url.hostname);
  if (hostIsBlockedName(host)) {
    return { ok: false, error: "That address is not public.", code: "PRIVATE_ADDRESS", status: 400 };
  }
  const dottedIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.indexOf(":") >= 0 && /^[0-9a-f:.]+$/i.test(host);
  if ((dottedIp || ipv6) && !addressIsPublic(host)) {
    return { ok: false, error: "That address is not public.", code: "PRIVATE_ADDRESS", status: 400 };
  }
  url.hostname = host.indexOf(":") >= 0 && host.indexOf(".") < 0 ? host : url.hostname;
  return { ok: true, href: url.href, hostname: host };
}

function selectPublicAddress(addresses) {
  const usable = (addresses || []).filter(function (entry) { return entry && addressIsPublic(entry.address); });
  if (!usable.length) throw fail("That address is not public.", "PRIVATE_ADDRESS", 400);
  usable.sort(function (a, b) { return (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1); });
  return usable[0];
}

function checkedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { all: true, verbatim: true }).then(function (addresses) {
    try {
      const picked = selectPublicAddress(addresses);
      callback(null, picked.address, picked.family);
    } catch (err) { callback(err); }
  }).catch(function (err) { callback(err); });
}

function nextHop(currentUrl, status, location, method) {
  if ([301, 302, 303, 307, 308].indexOf(Number(status)) < 0) return null;
  if (!location) return null;
  let resolved;
  try { resolved = new URL(location, currentUrl).href; }
  catch (e) { throw fail("The page redirected to a bad address.", "BAD_URL", 502); }
  const target = targetFromUrl(resolved);
  if (!target.ok) throw fail(target.error, target.code, target.status);
  let nextMethod = method || "GET";
  if (status === 301 || status === 302 || status === 303) nextMethod = "GET";
  return { url: target.href, method: nextMethod };
}

function inflate(buf, encoding) {
  const kind = String(encoding || "").toLowerCase().trim();
  try {
    if (kind === "gzip") return zlib.gunzipSync(buf);
    if (kind === "deflate") return zlib.inflateSync(buf);
    if (kind === "br") return zlib.brotliDecompressSync(buf);
  } catch (e) {
    throw fail("The page could not be read.", "BAD_CONTENT", 502);
  }
  return buf;
}

function bodyKind(contentType, buf) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
  if (ct.indexOf("text/") === 0) return "text";
  if (!ct && buf && buf.length) {
    const sniff = buf.slice(0, 240).toString("utf8").trim().charAt(0);
    if (sniff === "<") return "html";
  }
  return "external";
}

function requestBuffer(targetUrl, method, headers, bodyBuffer) {
  return new Promise(function (resolve, reject) {
    const lib = targetUrl.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: (targetUrl.pathname || "/") + targetUrl.search,
      method: method,
      headers: headers,
      lookup: checkedLookup,
      servername: targetUrl.hostname
    }, function (res) {
      const contentType = res.headers["content-type"] || "";
      const kind = bodyKind(contentType, null);
      const len = Number(res.headers["content-length"] || 0);
      if (len > MAX_BYTES) {
        res.destroy();
        reject(fail("That page is too large to relay.", "TOO_LARGE", 413));
        return;
      }
      if (kind === "external") {
        res.destroy();
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.alloc(0) });
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      res.on("data", function (chunk) {
        if (failed) return;
        size += chunk.length;
        if (size > MAX_BYTES) {
          failed = true;
          res.destroy();
          reject(fail("That page is too large to relay.", "TOO_LARGE", 413));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", function () {
        if (!failed) resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on("error", function (err) { if (!failed) reject(err); });
    });
    req.setTimeout(HOP_MS, function () {
      req.destroy(fail("The site took too long to answer.", "TIMEOUT", 504));
    });
    req.on("error", reject);
    if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

async function fetchPublicPage(rawUrl, method, bodyBuffer, contentType) {
  const initial = targetFromUrl(rawUrl);
  if (!initial.ok) throw fail(initial.error, initial.code, initial.status);
  let current = initial.href;
  let hopMethod = method === "POST" ? "POST" : "GET";
  let hopBody = hopMethod === "POST" ? bodyBuffer : null;
  let hopType = contentType || "";
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const target = new URL(current);
    const headers = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "Accept-Language": "en",
      "Accept-Encoding": "gzip, deflate, br"
    };
    if (hopBody && hopBody.length) {
      headers["Content-Type"] = hopType || "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(hopBody);
    }
    const res = await requestBuffer(target, hopMethod, headers, hopBody);
    const location = res.headers.location;
    if (location && [301, 302, 303, 307, 308].indexOf(res.status) >= 0) {
      const hop = nextHop(current, res.status, Array.isArray(location) ? location[0] : location, hopMethod);
      if (!hop) break;
      current = hop.url;
      hopMethod = hop.method;
      if (hopMethod !== "POST") hopBody = null;
      continue;
    }
    const buf = inflate(res.body, res.headers["content-encoding"]);
    if (buf.length > MAX_BYTES) throw fail("That page is too large to relay.", "TOO_LARGE", 413);
    return {
      url: current,
      status: res.status,
      headers: res.headers,
      body: buf
    };
  }
  throw fail("The page redirected too many times.", "REDIRECTS", 502);
}

function allowUser(uid) {
  const now = Date.now();
  const recent = (hits.get(uid) || []).filter(function (ts) { return now - ts < 60000; });
  if (recent.length >= MAX_PER_MINUTE) {
    hits.set(uid, recent);
    return false;
  }
  recent.push(now);
  hits.set(uid, recent);
  return true;
}

function requestPath(req) {
  const raw = String((req && (req.path || req.url)) || "/").split("?")[0];
  const trimmed = raw.replace(/\/+$/, "") || "/";
  return trimmed.replace(/^\/browse(?=\/|$)/, "") || "/";
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function createBrowseHandler(deps) {
  deps = deps || {};
  const verifyUser = deps.verifyUser;
  const originAllowed = deps.originAllowed || function () { return true; };
  const fetchPage = deps.fetchPage || fetchPublicPage;

  return async function browse(req, res) {
    const origin = req.headers && (req.headers.origin || req.headers.Origin);
    if (origin && originAllowed(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    } else if (!origin) {
      res.set("Access-Control-Allow-Origin", "*");
    }
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Max-Age", "3600");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Web relay expects a page request.", code: "METHOD" });
      return;
    }
    const path = requestPath(req);
    if (path !== "/" && path !== "/page") {
      sendJson(res, 404, { error: "Unknown web relay route.", code: "NOT_FOUND" });
      return;
    }
    let user;
    try { user = await verifyUser(req); }
    catch (err) {
      sendJson(res, err.status || 401, { error: err.message || "Sign in to open this page.", code: err.code || "UNAUTHENTICATED" });
      return;
    }
    if (!user || !user.uid || !allowUser(user.uid)) {
      sendJson(res, 429, { error: "Too many pages were opened just now. Try again in a minute.", code: "RATE" });
      return;
    }
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const initial = targetFromUrl(payload.url);
    if (!initial.ok) {
      sendJson(res, initial.status || 400, { error: initial.error, code: initial.code || "BAD_URL" });
      return;
    }
    const method = String(payload.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
    let bodyBuffer = null;
    let contentType = "";
    if (method === "POST") {
      contentType = String(payload.contentType || "application/x-www-form-urlencoded");
      if (contentType.indexOf("application/x-www-form-urlencoded") !== 0 && contentType.indexOf("text/plain") !== 0) {
        sendJson(res, 400, { error: "That form cannot be sent through the relay.", code: "BAD_FORM" });
        return;
      }
      const text = String(payload.body || "");
      if (Buffer.byteLength(text) > MAX_POST_BYTES) {
        sendJson(res, 413, { error: "That form is too large.", code: "TOO_LARGE" });
        return;
      }
      bodyBuffer = Buffer.from(text);
    }
    try {
      const page = await fetchPage(initial.href, method, bodyBuffer, contentType);
      const finalTarget = targetFromUrl(page.url);
      if (!finalTarget.ok) throw fail(finalTarget.error, finalTarget.code, finalTarget.status);
      const contentTypeHeader = page.headers && (page.headers["content-type"] || page.headers["Content-Type"]) || "";
      const kind = bodyKind(contentTypeHeader, page.body);
      if (kind === "external") {
        sendJson(res, 200, { url: finalTarget.href, status: page.status || 200, contentType: String(contentTypeHeader).split(";")[0], kind: "external" });
        return;
      }
      let text = "";
      const charset = /charset=([^;]+)/i.exec(String(contentTypeHeader));
      const encoding = charset ? charset[1].trim().replace(/^["']|["']$/g, "") : "utf-8";
      try { text = new TextDecoder(encoding).decode(page.body); }
      catch (e) { text = page.body.toString("utf8"); }
      sendJson(res, 200, {
        url: finalTarget.href,
        status: page.status || 200,
        contentType: String(contentTypeHeader).split(";")[0] || (kind === "text" ? "text/plain" : "text/html"),
        kind: kind,
        body: text
      });
    } catch (err) {
      const status = err.status || 502;
      if (status >= 500) console.warn("browse failed", err.code || "TARGET", (function () { try { return new URL(String(payload.url || "")).hostname; } catch (e) { return ""; } })());
      sendJson(res, status, { error: err.message || "That page could not be opened.", code: err.code || "TARGET" });
    }
  };
}

module.exports = {
  addressIsPublic: addressIsPublic,
  canonicalHost: canonicalHost,
  targetFromUrl: targetFromUrl,
  selectPublicAddress: selectPublicAddress,
  nextHop: nextHop,
  bodyKind: bodyKind,
  createBrowseHandler: createBrowseHandler,
  fetchPublicPage: fetchPublicPage
};
