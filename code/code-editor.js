/*
  Second Brain — code/code-editor.js

  The Code item type: a syntax-highlighted editor with a language picker,
  line numbers, auto-indent, a sandboxed Run console for JavaScript, live
  Preview for HTML and CSS, and a formatter for JSON.

  Self-contained like the video feature: this file only attaches to
  window.SecondBrainCode and runs nothing until index.html calls
  SecondBrainCode.install(host). See code/README.md and the item type
  registry comment in index.html for the contract.

  The highlighter is a small rule-based tokenizer, not a library, so the
  app stays a static site with no new dependencies. Token colours come from
  CSS variables in code-editor.css that are derived from the active theme.
*/
(function (ns) {
  "use strict";

  var host = null;

  /* =================== languages =================== */

  function wordSet(text) {
    var set = {};
    text.split(/\s+/).forEach(function (w) { if (w) set[w] = 1; });
    return set;
  }

  var JS_KW = wordSet("async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield");
  var JS_BLT = wordSet("true false null undefined NaN Infinity console window document globalThis Math JSON Promise Array Object String Number Boolean Symbol BigInt Map Set WeakMap WeakSet Date RegExp Error TypeError RangeError fetch setTimeout setInterval clearTimeout clearInterval parseInt parseFloat isNaN structuredClone");
  var PY_KW = wordSet("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield case");
  var PY_BLT = wordSet("True False None self cls print len range str int float bool list dict set tuple type input open enumerate zip map filter sorted sum min max abs round isinstance super __init__ __name__ __main__");
  var CS_KW = wordSet("abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach get goto if implicit in interface internal is lock namespace new operator out override params partial private protected public readonly record ref required return sealed set sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using value var virtual void volatile when where while yield add remove init file scoped nameof async await");
  var CS_BLT = wordSet("true false null bool byte sbyte char decimal double float int uint nint nuint long ulong short ushort object string dynamic Console Math String Int32 Int64 Boolean Object List Dictionary Task Action Func DateTime TimeSpan Guid Exception ArgumentException InvalidOperationException Nullable IEnumerable IList IDictionary StringBuilder Convert Environment");
  var SQL_KW = wordSet("SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE JOIN LEFT RIGHT FULL INNER OUTER CROSS ON GROUP BY ORDER HAVING LIMIT OFFSET TOP CREATE TABLE PRIMARY KEY FOREIGN REFERENCES CONSTRAINT UNIQUE DEFAULT DROP ALTER ADD COLUMN INDEX VIEW TRIGGER PROCEDURE FUNCTION RETURNS BEGIN END AS DISTINCT AND OR NOT NULL IS IN LIKE ILIKE BETWEEN EXISTS UNION ALL ANY CASE WHEN THEN ELSE IF WHILE RETURN DECLARE CAST CONVERT ASC DESC INTEGER INT BIGINT SMALLINT VARCHAR NVARCHAR CHAR TEXT BOOLEAN DATE TIME TIMESTAMP DATETIME DECIMAL NUMERIC FLOAT REAL DOUBLE SERIAL AUTO_INCREMENT IDENTITY WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK COUNT SUM AVG MIN MAX COALESCE NULLIF TRUE FALSE");
  var CSS_VAL_KW = wordSet("inherit initial unset revert auto none block inline flex grid absolute relative fixed sticky static hidden visible scroll solid dashed dotted double bold bolder lighter normal italic center left right justify start end stretch cover contain wrap nowrap row column pointer default transparent currentColor important");

  function ws() { return { re: /\s+/y, cls: "" }; }
  function lineComment(prefix) { return { re: new RegExp(prefix + "[^\\n]*", "y"), cls: "cmt" }; }
  function blockComment() { return { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: "cmt" }; }
  function dq() { return { re: /"(?:\\.|[^"\\\n])*"?/y, cls: "str" }; }
  function sq() { return { re: /'(?:\\.|[^'\\\n])*'?/y, cls: "str" }; }
  function num() { return { re: /0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[a-zA-Z]{0,3}/y, cls: "num" }; }
  function punct() { return { re: /[{}()[\];,.]+/y, cls: "pct" }; }
  function ops() { return { re: /[+\-*/%=!<>&|^~?:@#]+/y, cls: "op" }; }

  /* Identifier rule: keywords and builtins by lookup, then `name(` as a
     function call, then Capitalised as a type. m.input/m.index give the
     lookahead needed for the call check. */
  function ident(keywords, builtins, options) {
    options = options || {};
    return {
      re: /[A-Za-z_$][\w$]*/y,
      cls: function (m) {
        var w = m[0], key = options.caseless ? w.toUpperCase() : w;
        if (keywords && keywords[key]) return "kw";
        if (builtins && builtins[key]) return "blt";
        if (/^\s*\(/.test(m.input.slice(m.index + w.length))) return "fn";
        if (options.types !== false && /^[A-Z]/.test(w)) return "typ";
        return "";
      }
    };
  }

  var RULESETS = {
    javascript: [
      ws(), lineComment("\\/\\/"), blockComment(),
      { re: /`(?:\\[\s\S]|[^\\`])*`?/y, cls: "str" },
      dq(), sq(), num(),
      ident(JS_KW, JS_BLT),
      punct(), ops()
    ],
    python: [
      ws(), lineComment("#"),
      { re: /[rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, cls: "str" },
      { re: /[rRbBuUfF]{1,2}(?:"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y, cls: "str" },
      dq(), sq(),
      { re: /@[\w.]+/y, cls: "attr" },
      num(),
      ident(PY_KW, PY_BLT),
      punct(), ops()
    ],
    csharp: [
      ws(), lineComment("\\/\\/"), blockComment(),
      { re: /[$@]{1,2}"(?:""|\\.|[^"\\])*"?/y, cls: "str" },
      dq(), sq(), num(),
      { re: /#[a-z]+/y, cls: "kw" },
      ident(CS_KW, CS_BLT),
      punct(), ops()
    ],
    css: [
      ws(), blockComment(), dq(), sq(),
      { re: /@[\w-]+/y, cls: "kw" },
      { re: /!important\b/y, cls: "kw" },
      { re: /--[\w-]+/y, cls: "attr" },
      { re: /#[0-9a-fA-F]{3,8}(?![\w-])/y, cls: "num" },
      num(),
      { re: /#[A-Za-z_-][\w-]*/y, cls: "typ" },
      { re: /\.[A-Za-z_-][\w-]*/y, cls: "typ" },
      { re: /[A-Za-z-]+(?=\s*:)/y, cls: "attr" },
      { re: /:{1,2}[a-zA-Z-]+/y, cls: "kw" },
      {
        re: /[A-Za-z-]+/y,
        cls: function (m) {
          if (/^\s*\(/.test(m.input.slice(m.index + m[0].length))) return "fn";
          return CSS_VAL_KW[m[0]] ? "blt" : "";
        }
      },
      punct(), ops()
    ],
    json: [
      ws(),
      { re: /"(?:\\.|[^"\\])*"(?=\s*:)/y, cls: "attr" },
      { re: /"(?:\\.|[^"\\])*"?/y, cls: "str" },
      { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: "num" },
      { re: /(?:true|false|null)(?![\w$])/y, cls: "kw" },
      punct(), ops()
    ],
    sql: [
      ws(), lineComment("--"), blockComment(),
      { re: /'(?:''|[^'\n])*'?/y, cls: "str" },
      { re: /`[^`\n]*`?|\[[^\]\n]*\]?/y, cls: "typ" },
      num(),
      ident(SQL_KW, null, { caseless: true, types: false }),
      punct(), ops()
    ]
  };

  var LANGUAGES = [
    { id: "javascript", name: "JavaScript", ext: "js", run: "js", placeholder: "// Write some JavaScript, then press Run…" },
    { id: "html", name: "HTML", ext: "html", run: "html", placeholder: "<!-- Write HTML, then press Preview… -->" },
    { id: "css", name: "CSS", ext: "css", run: "css", placeholder: "/* Write CSS, then press Preview… */" },
    { id: "python", name: "Python", ext: "py", placeholder: "# Write some Python…" },
    { id: "csharp", name: "C#", ext: "cs", placeholder: "// Write some C#…" },
    { id: "json", name: "JSON", ext: "json", run: "json", placeholder: "{ \"write\": \"JSON, then press Format…\" }" },
    { id: "sql", name: "SQL", ext: "sql", placeholder: "-- Write some SQL…" }
  ];

  function languageDef(id) {
    for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].id === id) return LANGUAGES[i];
    return LANGUAGES[0];
  }

  /* =================== tokenizer =================== */

  var HIGHLIGHT_LIMIT = 160000;

  function tokenize(src, rules) {
    var out = [], i = 0, n = src.length, plain = "";
    while (i < n) {
      var text = null, cls = "";
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        rule.re.lastIndex = i;
        var m = rule.re.exec(src);
        if (m && m[0]) {
          text = m[0];
          cls = typeof rule.cls === "function" ? rule.cls(m) : rule.cls;
          break;
        }
      }
      if (text === null) { plain += src[i]; i++; continue; }
      if (plain) { out.push([plain, ""]); plain = ""; }
      out.push([text, cls]);
      i += text.length;
    }
    if (plain) out.push([plain, ""]);
    return out;
  }

  /* HTML gets its own pass so attributes only highlight inside tags, and so
     <script> and <style> bodies can borrow the JS and CSS rulesets. */
  function tokenizeHtml(src) {
    var out = [], i = 0, n = src.length;
    while (i < n) {
      if (src[i] === "<") {
        if (src.substr(i, 4) === "<!--") {
          var ce = src.indexOf("-->", i + 4);
          ce = ce < 0 ? n : ce + 3;
          out.push([src.slice(i, ce), "cmt"]); i = ce; continue;
        }
        if (src[i + 1] === "!") {
          var gt = src.indexOf(">", i);
          gt = gt < 0 ? n : gt + 1;
          out.push([src.slice(i, gt), "kw"]); i = gt; continue;
        }
        var open = /^<\/?[a-zA-Z][\w.:-]*/.exec(src.slice(i));
        if (open) {
          out.push([open[0], "tag"]);
          i += open[0].length;
          while (i < n) {
            var rest = src.slice(i), m;
            if ((m = /^\s+/.exec(rest))) { out.push([m[0], ""]); i += m[0].length; continue; }
            if (rest.substr(0, 2) === "/>") { out.push(["/>", "tag"]); i += 2; break; }
            if (rest[0] === ">") { out.push([">", "tag"]); i += 1; break; }
            if ((m = /^"[^"]*"?|^'[^']*'?/.exec(rest))) { out.push([m[0], "str"]); i += m[0].length; continue; }
            if (rest[0] === "=") { out.push(["=", "op"]); i += 1; continue; }
            if ((m = /^[^\s=>/]+/.exec(rest))) { out.push([m[0], "attr"]); i += m[0].length; continue; }
            out.push([rest[0], ""]); i += 1;
          }
          var tagName = open[0].replace(/^<\/?/, "").toLowerCase();
          if (open[0][1] !== "/" && (tagName === "script" || tagName === "style")) {
            var closer = tagName === "script" ? /<\/script/i : /<\/style/i;
            var cm = closer.exec(src.slice(i));
            var innerEnd = cm ? i + cm.index : n;
            if (innerEnd > i) {
              out = out.concat(tokenize(src.slice(i, innerEnd), RULESETS[tagName === "script" ? "javascript" : "css"]));
              i = innerEnd;
            }
          }
          continue;
        }
        out.push(["<", ""]); i++; continue;
      }
      var lt = src.indexOf("<", i);
      var end = lt < 0 ? n : lt;
      out.push([src.slice(i, end), ""]);
      i = end;
    }
    return out;
  }

  function highlight(src, langId) {
    if (!src) return "";
    if (src.length > HIGHLIGHT_LIMIT) return host.escapeHtml(src);
    var tokens = langId === "html" ? tokenizeHtml(src) : tokenize(src, RULESETS[langId] || RULESETS.javascript);
    var html = "";
    for (var i = 0; i < tokens.length; i++) {
      var text = host.escapeHtml(tokens[i][0]);
      html += tokens[i][1] ? '<span class="ct-' + tokens[i][1] + '">' + text + "</span>" : text;
    }
    return html;
  }

  /* =================== item helpers =================== */

  function ensureCodeItem(item) {
    if (typeof item.code !== "string") item.code = typeof item.body === "string" ? item.body : "";
    delete item.body;
    if (!LANGUAGES.some(function (l) { return l.id === item.language; })) item.language = "javascript";
  }

  function newCodeItem() {
    var it = host.baseItem();
    it.type = "code";
    it.language = "javascript";
    it.code = "";
    return it;
  }

  function codeMeta(item) {
    var code = item.code || "";
    var lines = code ? code.split("\n").length : 0;
    return languageDef(item.language).name + " · " + lines + " line" + (lines === 1 ? "" : "s") + " · " + code.length + " char" + (code.length === 1 ? "" : "s");
  }

  /* =================== view =================== */

  var active = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function tearDown() {
    if (!active) return;
    if (active.messageHandler) window.removeEventListener("message", active.messageHandler);
    clearTimeout(active.metaTimer);
    clearTimeout(active.previewTimer);
    active = null;
  }

  function insertText(ta, text) {
    ta.focus();
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    done && done();
  }

  function buildEditor(item) {
    tearDown();
    ensureCodeItem(item);

    var root = el("div", "ce-editor");
    root.setAttribute("data-item-editor", item.id);

    var view = {
      itemId: item.id,
      metaTimer: null,
      previewTimer: null,
      messageHandler: null,
      run: null,
      outputMode: null
    };
    active = view;

    /* ---------- toolbar ---------- */
    var bar = el("div", "ce-toolbar");
    var langs = el("div", "ce-langs");
    langs.setAttribute("role", "tablist");
    var pills = {};
    LANGUAGES.forEach(function (lang) {
      var pill = el("button", "ce-pill", lang.name);
      pill.type = "button";
      pill.setAttribute("role", "tab");
      pill.onclick = function () {
        if (item.language === lang.id) return;
        item.language = lang.id;
        host.touchItem(item);
        host.persist();
        host.refreshItemEditor(item);
        closeOutput();
        syncLanguage();
        paint();
        ta.focus();
      };
      pills[lang.id] = pill;
      langs.appendChild(pill);
    });
    var actions = el("div", "ce-actions");
    bar.appendChild(langs);
    bar.appendChild(actions);
    root.appendChild(bar);

    /* ---------- editor frame ---------- */
    var frame = el("div", "ce-frame");
    var gutter = el("div", "ce-gutter");
    var gutterInner = el("div", "ce-gutter-inner");
    gutter.appendChild(gutterInner);
    var stage = el("div", "ce-stage");
    var pre = el("pre", "ce-highlight");
    pre.setAttribute("aria-hidden", "true");
    var codeEl = el("code", "");
    pre.appendChild(codeEl);
    var ta = document.createElement("textarea");
    ta.className = "ce-input";
    ta.value = item.code || "";
    ta.spellcheck = false;
    ta.wrap = "off";
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("aria-label", "Code");
    stage.appendChild(pre);
    stage.appendChild(ta);
    frame.appendChild(gutter);
    frame.appendChild(stage);
    root.appendChild(frame);

    /* ---------- status bar ---------- */
    var status = el("div", "ce-status");
    var statusLang = el("span", "ce-status-lang");
    var statusPos = el("span", "");
    var statusSize = el("span", "");
    status.appendChild(statusLang);
    status.appendChild(statusPos);
    status.appendChild(statusSize);
    root.appendChild(status);

    /* ---------- output panel ---------- */
    var output = el("div", "ce-output");
    output.hidden = true;
    var outputHead = el("div", "ce-output-head");
    var outputTitle = el("b", "", "");
    var outputSpacer = el("span", "ce-output-spacer");
    var outputClear = el("button", "ce-mini", "Clear");
    outputClear.type = "button";
    var outputClose = el("button", "ce-mini", "Close");
    outputClose.type = "button";
    outputHead.appendChild(outputTitle);
    outputHead.appendChild(outputSpacer);
    outputHead.appendChild(outputClear);
    outputHead.appendChild(outputClose);
    var outputBody = el("div", "ce-output-body");
    output.appendChild(outputHead);
    output.appendChild(outputBody);
    root.appendChild(output);

    outputClose.onclick = closeOutput;
    outputClear.onclick = function () { outputBody.innerHTML = ""; };

    function closeOutput() {
      output.hidden = true;
      outputBody.innerHTML = "";
      view.outputMode = null;
      view.run = null;
    }

    function openOutput(mode, title, showClear) {
      view.outputMode = mode;
      outputTitle.textContent = title;
      outputClear.style.display = showClear ? "" : "none";
      outputBody.innerHTML = "";
      output.hidden = false;
    }

    /* ---------- run: sandboxed JavaScript console ---------- */
    function consoleLine(kind, text) {
      var line = el("div", "ce-line ce-line-" + kind, text);
      outputBody.appendChild(line);
      outputBody.scrollTop = outputBody.scrollHeight;
    }

    view.messageHandler = function (e) {
      if (!view.run || !e.data || !e.data.sbCodeRun || e.source !== view.run.win) return;
      if (e.data.kind === "done") {
        consoleLine("done", "Finished in " + (Date.now() - view.run.started) + " ms");
        return;
      }
      consoleLine(e.data.kind, e.data.text);
    };
    window.addEventListener("message", view.messageHandler);

    function runJavaScript() {
      var code = ta.value;
      if (!code.trim()) { host.showToast("Nothing to run yet", true); return; }
      openOutput("js", "Console", true);
      var head = [
        "<script>",
        "(function(){",
        "  function fmt(v){",
        "    if (v === null) return 'null';",
        "    var t = typeof v;",
        "    if (t === 'undefined') return 'undefined';",
        "    if (t === 'string') return v;",
        "    if (t !== 'object') { try { return String(v); } catch (e) { return '[value]'; } }",
        "    try { var seen = []; return JSON.stringify(v, function(k, val){ if (typeof val === 'object' && val !== null) { if (seen.indexOf(val) >= 0) return '[circular]'; seen.push(val); } return val; }); } catch (e) { return Object.prototype.toString.call(v); }",
        "  }",
        "  function send(kind, text){ parent.postMessage({ sbCodeRun: true, kind: kind, text: text }, '*'); }",
        "  ['log','info','debug','warn','error'].forEach(function(name){",
        "    var kind = name === 'warn' ? 'warn' : (name === 'error' ? 'error' : 'log');",
        "    console[name] = function(){ send(kind, Array.prototype.slice.call(arguments).map(fmt).join(' ')); };",
        "  });",
        "  var offset = __SB_OFFSET__;",
        "  window.onerror = function(msg, src, line){ send('error', msg + (line > offset ? ' (line ' + (line - offset) + ')' : '')); return true; };",
        "  window.onunhandledrejection = function(e){ send('error', 'Unhandled promise rejection: ' + fmt(e.reason)); };",
        "  window.addEventListener('load', function(){ setTimeout(function(){ send('done', ''); }, 0); });",
        "})();",
        "<\/script>",
        "<script>"
      ].join("\n");
      var offset = head.split("\n").length;
      head = head.replace("__SB_OFFSET__", String(offset));
      var iframe = document.createElement("iframe");
      iframe.className = "ce-runner";
      iframe.setAttribute("sandbox", "allow-scripts allow-modals");
      iframe.srcdoc = head + "\n" + code.replace(/<\/script/gi, "<\\/script") + "\n<\/script>";
      outputBody.appendChild(iframe);
      view.run = { win: null, started: Date.now() };
      iframe.onload = function () { if (view.run) view.run.win = iframe.contentWindow; };
      /* contentWindow exists as soon as the iframe is connected. */
      view.run.win = iframe.contentWindow;
    }

    /* ---------- preview: HTML and CSS ---------- */
    var CSS_SAMPLE = "<h1>Preview heading<\/h1><p>A paragraph with a <a href=\"#\">link<\/a>, some <strong>bold text<\/strong> and <code>inline code<\/code>.<\/p><button>Button<\/button><ul><li>First item<\/li><li>Second item<\/li><\/ul><div class=\"box\">&lt;div class=\"box\"&gt;<\/div>";

    function previewDoc() {
      if (item.language === "css") {
        return "<style>body{font-family:system-ui;padding:18px;color:#111}<\/style><style>" + ta.value.replace(/<\/style/gi, "<\\/style") + "<\/style>" + CSS_SAMPLE;
      }
      return ta.value;
    }

    function renderPreview() {
      var iframe = outputBody.querySelector("iframe");
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.className = "ce-preview";
        iframe.setAttribute("sandbox", "allow-scripts allow-modals");
        outputBody.appendChild(iframe);
      }
      iframe.srcdoc = previewDoc();
    }

    function openPreview() {
      if (view.outputMode === "preview") { closeOutput(); return; }
      openOutput("preview", "Live preview", false);
      renderPreview();
    }

    function schedulePreview() {
      if (view.outputMode !== "preview") return;
      clearTimeout(view.previewTimer);
      view.previewTimer = setTimeout(renderPreview, 350);
    }

    /* ---------- JSON format ---------- */
    function formatJson() {
      if (!ta.value.trim()) { host.showToast("Nothing to format yet", true); return; }
      try {
        var pretty = JSON.stringify(JSON.parse(ta.value), null, 2);
        if (pretty !== ta.value) {
          ta.select();
          insertText(ta, pretty);
          ta.setSelectionRange(0, 0);
        }
        host.showToast("Valid JSON — formatted");
      } catch (e) {
        host.showToast("Invalid JSON: " + (e && e.message ? e.message : "could not parse"), true);
      }
    }

    /* ---------- actions ---------- */
    function syncActions() {
      actions.innerHTML = "";
      var lang = languageDef(item.language);
      if (lang.run === "js") {
        var runBtn = el("button", "ce-btn ce-btn-primary", "▶ Run");
        runBtn.type = "button";
        runBtn.onclick = runJavaScript;
        actions.appendChild(runBtn);
      }
      if (lang.run === "html" || lang.run === "css") {
        var prevBtn = el("button", "ce-btn ce-btn-primary", "Preview");
        prevBtn.type = "button";
        prevBtn.onclick = openPreview;
        actions.appendChild(prevBtn);
      }
      if (lang.run === "json") {
        var fmtBtn = el("button", "ce-btn ce-btn-primary", "Format");
        fmtBtn.type = "button";
        fmtBtn.onclick = formatJson;
        actions.appendChild(fmtBtn);
      }
      var copyBtn = el("button", "ce-btn", "Copy");
      copyBtn.type = "button";
      copyBtn.onclick = function () {
        if (!ta.value) { host.showToast("Nothing to copy yet", true); return; }
        copyText(ta.value, function () { host.showToast("Code copied"); });
      };
      actions.appendChild(copyBtn);
      var dlBtn = el("button", "ce-btn", "Download");
      dlBtn.type = "button";
      dlBtn.onclick = function () {
        var name = (item.title || "").trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "snippet";
        var blob = new Blob([ta.value], { type: "text/plain" });
        var url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url; a.download = name + "." + languageDef(item.language).ext;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        host.showToast(a.download + " downloaded");
      };
      actions.appendChild(dlBtn);
    }

    function syncLanguage() {
      LANGUAGES.forEach(function (lang) {
        pills[lang.id].classList.toggle("active", lang.id === item.language);
        pills[lang.id].setAttribute("aria-selected", lang.id === item.language ? "true" : "false");
      });
      ta.placeholder = languageDef(item.language).placeholder;
      statusLang.textContent = languageDef(item.language).name;
      syncActions();
    }

    /* ---------- painting ---------- */
    var gutterCount = -1, gutterActive = null;

    function renderGutter(lineCount, activeLine) {
      if (lineCount !== gutterCount) {
        gutterCount = lineCount;
        gutterInner.innerHTML = "";
        for (var i = 1; i <= lineCount; i++) gutterInner.appendChild(el("span", "ce-ln", String(i)));
        gutterActive = null;
      }
      var next = gutterInner.children[activeLine - 1] || null;
      if (gutterActive !== next) {
        if (gutterActive) gutterActive.classList.remove("active");
        if (next) next.classList.add("active");
        gutterActive = next;
      }
    }

    function caretPosition() {
      var upTo = ta.value.slice(0, ta.selectionStart).split("\n");
      return { line: upTo.length, col: upTo[upTo.length - 1].length + 1 };
    }

    function updateStatus() {
      var v = ta.value, pos = caretPosition();
      statusPos.textContent = "Ln " + pos.line + ", Col " + pos.col;
      var lines = v ? v.split("\n").length : 0;
      statusSize.textContent = lines + " lines · " + v.length + " chars";
      renderGutter(Math.max(lines, 1), pos.line);
    }

    function paint() {
      codeEl.innerHTML = highlight(ta.value, item.language) + "\n";
      updateStatus();
      syncScroll();
    }

    function syncScroll() {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      gutterInner.style.transform = "translateY(" + (-ta.scrollTop) + "px)";
    }

    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("input", function () {
      item.code = ta.value;
      host.touchItem(item);
      host.save();
      paint();
      schedulePreview();
      clearTimeout(view.metaTimer);
      /* Refresh the header meta and sidebar line count once typing pauses.
         refreshItemEditor calls back into refresh(), which no-ops while the
         textarea already matches item.code. */
      view.metaTimer = setTimeout(function () { host.refreshItemEditor(item); }, 700);
    });
    ta.addEventListener("keyup", updateStatus);
    ta.addEventListener("click", updateStatus);

    /* ---------- editing niceties ---------- */
    var PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };

    function indentBlock(outdent) {
      var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
      var ls = v.lastIndexOf("\n", s - 1) + 1;
      var le = v.indexOf("\n", e); if (le < 0) le = v.length;
      var changed = v.slice(ls, le).split("\n").map(function (line) {
        return outdent ? line.replace(/^(?: {1,2}|\t)/, "") : "  " + line;
      }).join("\n");
      ta.setRangeText(changed, ls, le, "preserve");
      ta.selectionStart = ls;
      ta.selectionEnd = ls + changed.length;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }

    ta.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;

      if (k === "Tab") {
        e.preventDefault();
        if (s !== en && v.slice(s, en).indexOf("\n") >= 0) indentBlock(e.shiftKey);
        else if (e.shiftKey) indentBlock(true);
        else insertText(ta, "  ");
        return;
      }

      if (k === "Enter") {
        e.preventDefault();
        var ls = v.lastIndexOf("\n", s - 1) + 1;
        var line = v.slice(ls, s);
        var indent = (line.match(/^[ \t]*/) || [""])[0];
        var opens = /[{[(]\s*$/.test(line) || (item.language === "python" && /:\s*$/.test(line));
        var next = v[en] || "";
        if (opens && s === en && "}])".indexOf(next) >= 0) {
          insertText(ta, "\n" + indent + "  \n" + indent);
          ta.selectionStart = ta.selectionEnd = s + 1 + indent.length + 2;
          updateStatus();
        } else {
          insertText(ta, "\n" + indent + (opens ? "  " : ""));
        }
        return;
      }

      if (PAIRS[k]) {
        if (s !== en) {
          e.preventDefault();
          var sel = v.slice(s, en);
          insertText(ta, k + sel + PAIRS[k]);
          ta.selectionStart = s + 1;
          ta.selectionEnd = s + 1 + sel.length;
          return;
        }
        var nextCh = v[s] || "";
        var isQuote = k === '"' || k === "'" || k === "`";
        if (isQuote && nextCh === k) {
          e.preventDefault();
          ta.selectionStart = ta.selectionEnd = s + 1;
          updateStatus();
          return;
        }
        if (isQuote && /[\w"'`]/.test(v[s - 1] || "")) return;
        if (!nextCh || /[\s)\]},;:.]/.test(nextCh)) {
          e.preventDefault();
          insertText(ta, k + PAIRS[k]);
          ta.selectionStart = ta.selectionEnd = s + 1;
          return;
        }
        return;
      }

      if ((k === ")" || k === "]" || k === "}") && s === en && v[s] === k) {
        e.preventDefault();
        ta.selectionStart = ta.selectionEnd = s + 1;
        updateStatus();
        return;
      }

      if (k === "Backspace" && s === en && s > 0) {
        var prev = v[s - 1];
        if (PAIRS[prev] && v[s] === PAIRS[prev]) {
          e.preventDefault();
          ta.setRangeText("", s - 1, s + 1, "end");
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    });

    /* Non-destructive sync used by refresh(): only rewrite the textarea when
       the item changed underneath the editor (cloud sync, AI proposal). */
    view.sync = function () {
      ensureCodeItem(item);
      if (ta.value !== (item.code || "")) {
        ta.value = item.code || "";
        paint();
      }
      syncLanguage();
    };

    syncLanguage();
    paint();
    return root;
  }

  /* =================== registration =================== */

  var ICON_CODE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8.5 8-4 4 4 4"/><path d="m15.5 8 4 4-4 4"/><path d="M13.5 5.5l-3 13"/></svg>';

  ns.install = function (bridge) {
    host = bridge;
    return [
      {
        type: "code",
        label: "Code",
        menuLabel: "Code",
        manageLabel: "Code",
        manageHint: "A syntax-highlighted editor with run, preview and export",
        defaultEnabled: true,
        icon: ICON_CODE,
        placeholder: "Untitled code",
        create: newCodeItem,
        normalize: ensureCodeItem,
        text: function (item) { return item.code || ""; },
        meta: codeMeta,
        hasContent: function (item) { return !!(item.code || "").trim(); },
        build: buildEditor,
        refresh: function (item) {
          if (active && active.itemId === item.id && active.sync) active.sync();
        },
        detach: tearDown,
        reset: tearDown
      }
    ];
  };
})(window.SecondBrainCode = window.SecondBrainCode || {});
