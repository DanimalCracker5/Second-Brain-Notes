# Code editor

Everything for the **Code** item type lives in this folder. The rest of
Second Brain is in `../index.html` and contains no code-editor logic — it
only calls `SecondBrainCode.install()` once at boot and then asks the item
type registry (see the `item type registry` comment in `index.html`)
whenever it needs to know something about a code item.

**If you are an AI or a person changing the code editor, this folder is the
only place you should need to touch.**

## Files

| File | Owns |
| --- | --- |
| `code-editor.js` | The language definitions, the tokenizer/highlighter, the editor DOM, run/preview/format, and the registration call. Attaches to `window.SecondBrainCode`; runs nothing at load time. |
| `code-editor.css` | Styles. Editor chrome is prefixed `.ce-`, syntax tokens `.ct-`. Colours come from the core theme's CSS variables. |

## The item

```js
{ type: "code", language: "javascript", code: "…" }
```

`language` is one of `javascript`, `html`, `css`, `python`, `csharp`,
`json`, `sql` — the pills across the top of the editor. `normalize()`
coerces anything else back to `javascript` and guarantees `code` is a
string, so old or synced data can't break the editor.

## Highlighting

There is no library — the app stays a static site with zero new
dependencies. `tokenize()` walks the source with an ordered list of sticky
regexes per language (comments, strings, numbers, keyword/builtin lookup,
`name(` as a call, `Capitalised` as a type). HTML has its own pass so
attributes only colour inside tags, and `<script>`/`<style>` bodies are
re-tokenized with the JavaScript/CSS rules. Sources over ~160 KB render
unhighlighted rather than slow.

The palette is the clever part: in `code-editor.css` every token colour is
derived from the live `--accent` variable with CSS relative color syntax
(`hsl(from var(--accent) calc(h + 108) …)`). Change the theme in Settings
and the whole syntax palette re-tints; the Rainbow theme's slow hue drift
carries the code along with it. Browsers without relative color support
(pre-2024) fall back to a static palette.

## Run, Preview, Format

- **JavaScript — Run** builds a sandboxed `srcdoc` iframe
  (`sandbox="allow-scripts allow-modals"`, no `allow-same-origin`), overrides
  `console.*` and `window.onerror` inside it, and streams lines back over
  `postMessage` into the console panel. Each run replaces the iframe, which
  also kills a runaway loop from the previous run.
- **HTML / CSS — Preview** renders a sandboxed iframe; while the panel is
  open it live-reloads ~350 ms after typing stops. CSS previews against a
  small built-in sample document.
- **JSON — Format** is `JSON.parse` + `JSON.stringify(…, 2)`, with the parse
  error surfaced in a toast.
- Python, C# and SQL have no runner (that would need a backend or a
  multi-megabyte WASM runtime); they still get highlighting, copy and
  download.

Nothing here touches Firebase: `code` is a plain string in the item, so the
existing sync, backups, import/export, duplicate and search all work
unchanged.

## Editor behaviours

Two-space indentation. `Tab`/`Shift+Tab` indent and outdent (multi-line
aware), `Enter` copies the current indent and adds a level after `{ [ (`
(or `:` in Python), brackets and quotes auto-close and wrap the selection,
typing a closer skips over one already there, and `Backspace` inside an
empty pair deletes both. The gutter highlights the caret's line; the frame
is vertically resizable by dragging its bottom edge.

The overlay trick: a transparent-text `<textarea>` sits exactly on top of a
`<pre>` with the highlighted HTML, and scroll positions are synced. If you
change any font metric (family, size, line-height, padding, `tab-size`) it
must change on **both** `.ce-highlight` and `.ce-input` or the caret will
drift off the text — they share one CSS rule for exactly that reason.
