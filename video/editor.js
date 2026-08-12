/*
  Second Brain — video/editor.js

  The user interface for the item types this feature adds, and the place where
  they are registered with the core app.

    "video"  — Footage. A bucket of source video, audio and stills that any edit
               in the account can pull from.

    "file"   — Files. Any file at all, synced to the account. Media inside a
               File item also shows up in the editor's media picker.

    "edit"   — Edited Video. A timeline. It owns its *own* media pool — you can
               import straight into an edit — and can also pull from anything
               else in the account.

  Layout
  ------
  The edit view is built for a phone first and widens on a desktop, and it
  follows CapCut's shape because that shape works one-handed:

      sticky monitor  →  transport  →  timeline  →  sticky action rail

  The playhead does not move. It is a fixed needle down the middle of the
  timeline and the film scrolls underneath it, so scrubbing is a thumb flick and
  never a two-finger pinch-and-aim. Every editing surface beyond that is a
  bottom sheet.

  This file owns DOM and event handling only:
    editing rules   → video/timeline.js
    files           → video/media.js
    animations      → video/animations.js
    playback/export → video/player.js
    live sessions   → video/collab.js

  Loaded last, so it also defines SecondBrainVideo.install(), which index.html
  calls once at boot. See video/README.md.
*/
(function (ns) {
  "use strict";

  var timeline = ns.timeline;
  var media = ns.media;
  var animations = ns.animations;
  var collab = ns.collab;

  var host = null;

  /* Only one editor is on screen at a time — the core renders a single item. */
  var activeView = null;

  /* Zoom is a viewing preference, not content, so it is kept per session rather
     than synced into the item. */
  var zoomByItem = {};
  var DEFAULT_ZOOM = 55; // pixels per second
  var MIN_ZOOM = 3;
  var MAX_ZOOM = 420;

  /* How many timeline states the undo history keeps per open edit. */
  var HISTORY_LIMIT = 90;

  /* ---------------- icons ---------------- */

  function stroked(paths, width) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (width || 1.8) +
      '" stroke-linecap="round" stroke-linejoin="round">' +
      paths +
      "</svg>"
    );
  }

  var I = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    skipStart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h2.2v14H7z"/><path d="M19 5.5v13L9.8 12z"/></svg>',
    skipEnd: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 5h2.2v14h-2.2z"/><path d="M5 5.5v13L14.2 12z"/></svg>',
    undo: stroked('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 2),
    redo: stroked('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>', 2),
    scissors: stroked('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.1 7.6 20 19M8.1 16.4 20 5"/>'),
    zoomIn: stroked('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5M8 11h6M11 8v6"/>', 2),
    zoomOut: stroked('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5M8 11h6"/>', 2),
    fit: stroked('<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>', 2),
    download: stroked('<path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>', 2),
    upload: stroked('<path d="M12 19.5V9M7.5 13 12 8.5 16.5 13M5 4.5h14"/>', 2),
    plus: stroked('<path d="M12 5v14M5 12h14"/>', 2.2),
    close: stroked('<path d="m6 6 12 12M18 6 6 18"/>', 2.2),
    check: stroked('<path d="m5 12.5 4.5 4.5L19 7"/>', 2.4),
    film: stroked('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M8 4.5v15M16 4.5v15M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5"/>', 1.6),
    image: stroked('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 17 4.6-4.4L14 18M14 14.5l2.6-2.3L20 15.4"/>', 1.6),
    text: stroked('<path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6"/>', 2),
    mic: stroked('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>'),
    layers: stroked('<path d="m12 3.5 8.5 4.7L12 12.9 3.5 8.2z"/><path d="m3.5 13 8.5 4.7 8.5-4.7"/>'),
    wave: stroked('<path d="M4 10v4M8 7.5v9M12 4.5v15M16 7.5v9M20 10v4"/>', 2),
    volume: stroked('<path d="M11 5.5 6.8 9H4v6h2.8L11 18.5z"/><path d="M14.5 9.5a3.6 3.6 0 0 1 0 5M17 7a7 7 0 0 1 0 10"/>'),
    volumeOff: stroked('<path d="M11 5.5 6.8 9H4v6h2.8L11 18.5z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>'),
    eye: stroked('<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/>', 1.6),
    eyeOff: stroked('<path d="m4 4.5 16 15M9.8 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.8 3.5M6.6 7.7C4 9.5 2.5 12 2.5 12S6 18 12 18a9 9 0 0 0 4.3-1.1"/>', 1.6),
    trash: stroked('<path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6"/>', 1.6),
    copy: stroked('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 14.5V6a2 2 0 0 1 2-2h8.5"/>', 1.8),
    sparkle: stroked('<path d="M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2z"/><path d="M18.5 4v3M20 5.5h-3"/>', 1.7),
    sliders: stroked('<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>', 1.8),
    palette: stroked('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-1.8s-.6-1.3-.6-2 .7-1.4 1.6-1.4h1.6A4 4 0 0 0 20.5 11 7.6 7.6 0 0 0 12 3.5z"/><circle cx="8" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.8" cy="9.6" r="1.1" fill="currentColor" stroke="none"/>', 1.6),
    ratio: stroked('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 6v12"/>', 1.7),
    share: stroked('<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.4 10.7 7.2-4.2M8.4 13.3l7.2 4.2"/>', 1.8),
    users: stroked('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.2M17.5 14.6a5.5 5.5 0 0 1 3 4.9"/>', 1.7),
    lock: stroked('<rect x="5" y="10" width="14" height="10.5" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', 1.7),
    unlock: stroked('<rect x="5" y="10" width="14" height="10.5" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 7.2-2.4"/>', 1.7),
    up: stroked('<path d="m6 15 6-6 6 6"/>', 2.1),
    down: stroked('<path d="m6 9 6 6 6-6"/>', 2.1),
    link: stroked('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/>', 1.8),
    file: stroked('<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>', 1.7),
    folder: stroked('<path d="M3.5 7.5h6l2 2.5h9v9.5h-17z"/><path d="M3.5 7.5v-2h5l1.6 2"/>', 1.7),
    pdf: stroked('<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 17.5v-5h1.4a1.5 1.5 0 0 1 0 3H9"/>', 1.6),
    archive: stroked('<rect x="3.5" y="4.5" width="17" height="5" rx="1.5"/><path d="M5 9.5v10h14v-10M10 13h4"/>', 1.7),
    grid: stroked('<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>', 1.7)
  };

  var ICON_VIDEO = I.film;
  var ICON_FILE = I.file;
  var ICON_EDIT_VIDEO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v14"/><path d="m12 12 4 2-4 2z"/></svg>';

  var TRACK_ICONS = { video: I.film, audio: I.wave, text: I.text };
  var FAMILY_ICONS = { video: I.film, audio: I.wave, image: I.image, pdf: I.pdf, text: I.file, archive: I.archive, other: I.file };

  /* ---------------- tiny DOM helpers ---------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick, title) {
    var node = document.createElement("button");
    node.type = "button";
    node.className = className || "ve-btn";
    if (/^</.test(label)) node.innerHTML = label;
    else node.textContent = label;
    if (title) {
      node.title = title;
      node.setAttribute("aria-label", title);
    }
    node.onclick = onClick;
    return node;
  }

  /* An icon-over-label button — the whole bottom rail is made of these. */
  function railButton(icon, label, onClick, options) {
    options = options || {};
    var node = document.createElement("button");
    node.type = "button";
    node.className = "ve-rail-btn" + (options.className ? " " + options.className : "");
    var art = el("span", "ve-rail-icon");
    art.innerHTML = icon;
    node.appendChild(art);
    node.appendChild(el("span", "ve-rail-label", label));
    node.title = options.title || label;
    node.setAttribute("aria-label", node.title);
    node.onclick = onClick;
    if (options.disabled) node.disabled = true;
    return node;
  }

  /* A labelled control. Use field() when the control is a real form element so
     the label is associated with it, and row() when the control is a button. */
  function field(labelText, hint) {
    var wrap = el("label", "ve-field");
    wrap.appendChild(el("span", "ve-field-label", labelText));
    if (hint) wrap.appendChild(el("small", "ve-field-hint", hint));
    return wrap;
  }

  function row(labelText, hint) {
    var wrap = el("div", "ve-field");
    if (labelText) wrap.appendChild(el("span", "ve-field-label", labelText));
    if (hint) wrap.appendChild(el("small", "ve-field-hint", hint));
    return wrap;
  }

  /* True while the user is interacting with a control, so background refreshes
     (upload progress, autosave, a peer's edit) do not yank it away. */
  function isEditingControl(container) {
    var focused = document.activeElement;
    return !!(focused && container.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName));
  }

  /* onInput fires continuously while sliding; onSettle fires once on release,
     which is where the undo history records the change. */
  function slider(labelText, value, min, max, step, onInput, formatValue, onSettle) {
    var wrap = field(labelText),
      sliderRow = el("div", "ve-slider-row"),
      input = document.createElement("input"),
      readout = el("output", "ve-slider-value");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    readout.textContent = formatValue ? formatValue(value) : value;
    input.oninput = function () {
      var next = Number(input.value);
      readout.textContent = formatValue ? formatValue(next) : next;
      onInput(next);
    };
    if (onSettle) input.onchange = onSettle;
    sliderRow.appendChild(input);
    sliderRow.appendChild(readout);
    wrap.appendChild(sliderRow);
    return wrap;
  }

  /* A row of mutually exclusive chips. `options` is [[value, label, hint], ...] */
  function chipPicker(options, current, onPick) {
    var wrap = el("div", "ve-chip-row");
    options.forEach(function (option) {
      var chip = button(option[1], "ve-chip" + (option[0] === current ? " is-on" : ""), function () {
        Array.prototype.forEach.call(wrap.children, function (child) {
          child.classList.remove("is-on");
        });
        chip.classList.add("is-on");
        onPick(option[0]);
      });
      if (option[2]) chip.title = option[2];
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function posterNode(entry, className) {
    if (entry && entry.poster) {
      var image = el("img", className || "ve-poster");
      image.src = entry.poster;
      image.alt = "";
      image.loading = "lazy";
      return image;
    }
    var placeholder = el("div", (className || "ve-poster") + " ve-poster-empty");
    placeholder.innerHTML = FAMILY_ICONS[media.fileFamily(entry || {})] || I.file;
    return placeholder;
  }

  /* ---------------- theme-derived colours ----------------

     Track colours default to the app's own accent, rotated so neighbouring
     lanes stay apart. Switching the app theme re-tints the whole timeline for
     free, because these are read from the live CSS variable. */

  function accentHsl() {
    var raw = "";
    try {
      raw = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    } catch (e) {}
    var match = /hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i.exec(raw || "");
    if (!match) return { h: 265, s: 82, l: 74 };
    return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
  }

  function autoTrackColor(kind, index) {
    var base = accentHsl(),
      kindShift = kind === "audio" ? 168 : kind === "text" ? 54 : 0,
      hue = (((base.h + kindShift + index * 31) % 360) + 360) % 360,
      saturation = Math.max(46, Math.min(92, base.s)),
      light = Math.max(50, Math.min(76, base.l));
    return "hsl(" + Math.round(hue) + "," + Math.round(saturation) + "%," + Math.round(light) + "%)";
  }

  /* A stable palette offered in the colour picker: the theme accent plus a ring
     of hues around it, so a hand-picked colour still looks like it belongs. */
  function swatchPalette() {
    var base = accentHsl(),
      list = [];
    for (var i = 0; i < 10; i++) {
      list.push(hslToHex((((base.h + i * 36) % 360) + 360) % 360, Math.max(52, base.s), Math.max(52, Math.min(74, base.l))));
    }
    return list;
  }

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    var a = s * Math.min(l, 1 - l);
    function channel(n) {
      var k = (n + h / 30) % 12,
        value = l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
      return Math.round(255 * value)
        .toString(16)
        .padStart(2, "0");
    }
    return "#" + channel(0) + channel(8) + channel(4);
  }

  /* ---------------- bottom sheets ----------------

     Every panel in the edit view is one of these: it slides up from the bottom
     on a phone and floats as a centred card on a desktop. Sheets stack, and
     Escape or a tap outside closes the top one. */

  var sheetStack = [];

  function openSheet(options) {
    options = options || {};
    var scrim = el("div", "ve-scrim"),
      sheet = el("div", "ve-sheet" + (options.wide ? " is-wide" : "")),
      head = el("div", "ve-sheet-head"),
      titles = el("div", "ve-sheet-titles");

    titles.appendChild(el("b", null, options.title || ""));
    if (options.hint) titles.appendChild(el("small", null, options.hint));
    head.appendChild(el("span", "ve-sheet-grip"));
    head.appendChild(titles);
    head.appendChild(button(I.close, "ve-sheet-close", function () {
      close();
    }, "Close"));

    var body = el("div", "ve-sheet-body");
    sheet.appendChild(head);
    sheet.appendChild(body);
    scrim.appendChild(sheet);
    document.body.appendChild(scrim);

    var handle = { close: close, body: body, sheet: sheet, scrim: scrim };
    sheetStack.push(handle);
    requestAnimationFrame(function () {
      scrim.classList.add("is-open");
    });

    scrim.onclick = function (event) {
      if (event.target === scrim) close();
    };
    function onKey(event) {
      if (event.key !== "Escape") return;
      if (sheetStack[sheetStack.length - 1] !== handle) return;
      event.stopPropagation();
      close();
    }
    document.addEventListener("keydown", onKey, true);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      sheetStack = sheetStack.filter(function (other) {
        return other !== handle;
      });
      scrim.classList.remove("is-open");
      setTimeout(function () {
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      }, 200);
      if (options.onClose) options.onClose();
    }

    if (options.build) options.build(body, close, handle);
    return handle;
  }

  function closeAllSheets() {
    sheetStack.slice().forEach(function (handle) {
      handle.close();
    });
  }

  function sheetOpen() {
    return sheetStack.length > 0;
  }

  /* A short confirm that does not depend on window.confirm, which some mobile
     browsers suppress inside a PWA. */
  function confirmSheet(title, message, confirmLabel, onConfirm) {
    openSheet({
      title: title,
      build: function (body, close) {
        body.appendChild(el("p", "ve-hint", message));
        var actions = el("div", "ve-sheet-actions");
        actions.appendChild(button("Cancel", "ve-btn", close));
        actions.appendChild(
          button(confirmLabel, "ve-btn ve-btn-danger", function () {
            close();
            onConfirm();
          })
        );
        body.appendChild(actions);
      }
    });
  }

  /* =====================================================================
     Shared file list — used by the Footage and Files item types
     ===================================================================== */

  function buildFileCard(item, entry, listName, sync, options) {
    options = options || {};
    var card = el("article", "ve-file-card");
    var thumb = el("div", "ve-file-thumb");
    thumb.appendChild(posterNode(entry, "ve-poster"));
    card.appendChild(thumb);

    var body = el("div", "ve-file-body");
    var name = document.createElement("input");
    name.className = "ve-file-name";
    name.value = entry.name || "";
    name.setAttribute("aria-label", "File name");
    name.oninput = function () {
      entry.name = name.value;
      host.touchItem(item);
      host.save();
    };
    body.appendChild(name);
    body.appendChild(el("small", "ve-file-summary", media.entrySummary(item, entry)));

    var upload = media.uploadState(item, entry);
    if (upload) {
      var bar = el("div", "ve-progress"),
        fill = el("div", "ve-progress-fill");
      fill.style.width = Math.round(upload.progress * 100) + "%";
      bar.appendChild(fill);
      body.appendChild(bar);
    }
    card.appendChild(body);

    var actions = el("div", "ve-file-actions");
    if (options.canPreview !== false) {
      actions.appendChild(
        button("Open", "ve-btn ve-btn-small", function () {
          previewEntry(item, entry);
        })
      );
    }
    actions.appendChild(
      button("Save", "ve-btn ve-btn-small", function () {
        downloadEntry(item, entry);
      }, "Download to this device")
    );
    if (entry.storagePath && !entry.cached && (entry.size || 0) <= media.CACHE_LIMIT_BYTES) {
      actions.appendChild(
        button("Cache", "ve-btn ve-btn-small", function (event) {
          var node = event.currentTarget;
          node.disabled = true;
          node.textContent = "0%";
          media
            .downloadToCache(item, entry, function (fraction) {
              node.textContent = Math.round(fraction * 100) + "%";
            })
            .then(function () {
              host.showToast("Cached on this device");
              sync();
            })
            .catch(function (error) {
              console.warn(error);
              node.disabled = false;
              node.textContent = "Cache";
              host.showToast(error.corsLikely ? "Blocked by Cloud Storage CORS — see video/README.md" : "Could not cache this file", true);
            });
        }, "Copy this file onto this device for smoother editing")
      );
    }
    if (entry.cloudError) {
      actions.appendChild(
        button("Retry", "ve-btn ve-btn-small", function () {
          media.retryUpload(item, entry);
        }, "Try the cloud upload again")
      );
    }
    actions.appendChild(
      button(I.trash, "ve-ibtn ve-ibtn-danger", function () {
        confirmSheet("Remove file", "Remove " + (entry.name || "this file") + "? Any edit using it will show the clip as missing.", "Remove", function () {
          media.removeEntry(item, entry, listName);
          host.renderList();
          sync();
          host.showToast("File removed");
        });
      }, "Remove")
    );
    card.appendChild(actions);
    return card;
  }

  /* A drop target that also opens the system file picker when tapped. */
  function buildDropZone(options) {
    var picker = document.createElement("input");
    picker.type = "file";
    picker.accept = options.accept || "";
    picker.multiple = true;
    picker.hidden = true;
    picker.onchange = function () {
      if (picker.files && picker.files.length) options.onFiles(picker.files);
      picker.value = "";
    };

    var drop = el("div", "ve-drop");
    var art = el("div", "ve-drop-icon");
    art.innerHTML = options.icon || I.upload;
    drop.appendChild(art);
    var copy = el("div", "ve-drop-copy");
    copy.appendChild(el("b", null, options.title));
    copy.appendChild(el("small", null, options.hint));
    drop.appendChild(copy);
    drop.onclick = function () {
      picker.click();
    };
    ["dragenter", "dragover"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.add("is-over");
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.remove("is-over");
      });
    });
    drop.addEventListener("drop", function (event) {
      if (event.dataTransfer && event.dataTransfer.files.length) options.onFiles(event.dataTransfer.files);
    });

    var wrap = el("div", "ve-drop-wrap");
    wrap.appendChild(picker);
    wrap.appendChild(drop);
    wrap.openPicker = function () {
      picker.click();
    };
    return wrap;
  }

  function previewEntry(ownerItem, entry) {
    var family = media.fileFamily(entry);
    openSheet({
      title: entry.name || "Preview",
      wide: true,
      build: function (body) {
        var note = el("p", "ve-hint", "Loading…");
        body.appendChild(note);

        if (family === "image") {
          var image = el("img", "ve-preview-media");
          body.appendChild(image);
          media
            .resolveEntry(ownerItem, entry)
            .then(function (source) {
              if (source.crossOrigin) image.crossOrigin = "anonymous";
              image.src = source.url;
              note.textContent = source.local ? "On this device" : "Streaming from your account";
            })
            .catch(function (error) {
              note.textContent = (error && error.message) || "This file is not available here.";
            });
          return;
        }

        if (family !== "video" && family !== "audio") {
          note.textContent = "Preview is not available for this kind of file. Save it to open it in another app.";
          var save = button(I.download + "<span>Save a copy</span>", "ve-btn ve-btn-primary", function () {
            downloadEntry(ownerItem, entry);
          });
          body.appendChild(save);
          return;
        }

        var element = document.createElement(family === "audio" ? "audio" : "video");
        element.controls = true;
        element.className = "ve-preview-media";
        body.appendChild(element);
        media
          .resolveEntry(ownerItem, entry)
          .then(function (source) {
            if (source.crossOrigin) element.crossOrigin = "anonymous";
            element.src = source.url;
            note.textContent = source.local ? "Playing from this device" : "Streaming from your account";
          })
          .catch(function (error) {
            note.textContent = (error && error.message) || "This file is not available here.";
          });
      }
    });
  }

  function downloadEntry(ownerItem, entry) {
    media
      .resolveEntry(ownerItem, entry)
      .then(function (source) {
        var link = document.createElement("a");
        link.href = source.url;
        link.download = entry.name || "file";
        link.target = "_blank";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      })
      .catch(function (error) {
        host.showToast((error && error.message) || "That file is not available here", true);
      });
  }

  /* =====================================================================
     Footage editor — the "video" item type
     ===================================================================== */

  function buildVideoView(item) {
    return buildBucketView(item, {
      list: "clips",
      accept: "video/*,audio/*,image/*",
      acceptAny: false,
      icon: ICON_VIDEO,
      dropTitle: "Add footage",
      dropHint: "Video, audio or stills. Drop them here or tap to choose — up to 2 GB each.",
      intro: "Everything here syncs to your account and shows up in every edit's media picker.",
      empty: "No footage yet. Add a file above and it appears here and in every edit."
    });
  }

  /* =====================================================================
     Files — the "file" item type
     ===================================================================== */

  function buildFileItemView(item) {
    return buildBucketView(item, {
      list: "files",
      accept: "",
      acceptAny: true,
      icon: ICON_FILE,
      dropTitle: "Add files",
      dropHint: "Anything at all — PDFs, images, exports, project files. Up to 2 GB each.",
      intro: "A place for any file, synced to your account and reachable from every device. Video, audio and images in here can also be dropped straight onto a timeline.",
      empty: "Nothing here yet."
    });
  }

  /* Both file-holding types share one view; only the copy and the accepted
     types differ. */
  function buildBucketView(item, config) {
    var root = el("section", "ve-bucket");
    root.setAttribute("data-item-editor", item.id);

    root.appendChild(el("p", "ve-hint", config.intro));

    var dropZone = buildDropZone({
      accept: config.accept,
      icon: config.icon,
      title: config.dropTitle,
      hint: config.dropHint,
      onFiles: function (files) {
        media.addFiles(item, files, { list: config.list, accept: config.acceptAny ? "any" : "media" });
      }
    });
    root.appendChild(dropZone);

    var listWrap = el("div", "ve-file-grid");
    root.appendChild(listWrap);

    function sync() {
      if (isEditingControl(listWrap)) return; // someone is renaming a file
      listWrap.innerHTML = "";
      var entries = item[config.list] || [];
      if (!entries.length) {
        listWrap.appendChild(el("div", "ve-empty", config.empty));
        return;
      }
      entries
        .slice()
        .sort(function (a, b) {
          return (b.added || 0) - (a.added || 0);
        })
        .forEach(function (entry) {
          listWrap.appendChild(buildFileCard(item, entry, config.list, sync));
        });
    }

    sync();
    var stopWatching = media.onUploadChange(sync);
    return { itemId: item.id, root: root, sync: sync, destroy: stopWatching };
  }

  /* =====================================================================
     Timeline editor — the "edit" item type
     ===================================================================== */

  function newEditItem() {
    var item = host.baseItem();
    item.type = "edit";
    item.title = "";
    item.project = timeline.createProject();
    item.pool = [];
    item.voiceovers = [];
    item.renders = [];
    return item;
  }

  function ensureEditItem(item) {
    item.project = timeline.normalize(item.project);
    media.ensureList(item, "pool");
    media.ensureList(item, "voiceovers");
    media.ensureList(item, "renders");
    item.pool.forEach(function (entry) {
      entry.kind = "pool";
    });
    item.renders.forEach(function (entry) {
      entry.kind = "render";
    });
    if (typeof item.collabId !== "string") delete item.collabId;
  }

  function buildEditView(item) {
    ensureEditItem(item);

    var project = item.project,
      selectedClipId = null,
      activeTrackId = null,
      dragging = false,
      exportRunning = false,
      destroyed = false;

    /* Footage published by other people in a live session, keyed
       "itemId__fileId". Lets an invited editor play clips they do not own. */
    var sharedSources = {};

    var root = el("section", "ve-edit");
    root.setAttribute("data-item-editor", item.id);
    root.tabIndex = -1;

    /* --- undo history ---

       The whole timeline is a small JSON document, so history is just a stack
       of serialized snapshots. `baseline` always holds the state as of the last
       recorded step; markHistory() compares against it and pushes the
       difference. */

    var undoStack = [],
      redoStack = [],
      baseline = JSON.stringify(item.project);

    function markHistory() {
      var now = JSON.stringify(item.project);
      if (now === baseline) return;
      undoStack.push(baseline);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack.length = 0;
      baseline = now;
    }

    /* Records slider-style changes once, on release. */
    function settle() {
      markHistory();
      pushToSession();
      renderTransport();
    }

    function undo() {
      if (!undoStack.length) return;
      redoStack.push(JSON.stringify(item.project));
      restoreProject(undoStack.pop());
    }

    function redo() {
      if (!redoStack.length) return;
      undoStack.push(JSON.stringify(item.project));
      restoreProject(redoStack.pop());
    }

    function restoreProject(json) {
      var parsed;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        return;
      }
      item.project = parsed;
      ensureEditItem(item);
      project = item.project;
      baseline = JSON.stringify(item.project);
      if (selectedClipId && !timeline.findClip(project, selectedClipId)) selectedClipId = null;
      host.touchItem(item);
      host.persist();
      pushToSession();
      afterProjectChange();
    }

    function afterProjectChange() {
      clearProblem();
      playerInstance.clearErrors();
      playerInstance.projectChanged();
      sizeMonitor();
      renderTimeline();
      renderRail();
      renderProblems();
      renderTransport();
    }

    function clearProblem() {
      problem.hidden = true;
      problem.textContent = "";
      delete problem.dataset.kind;
    }

    /* --- committing a change --- */

    function commit(options) {
      options = options || {};
      markHistory();
      host.touchItem(item);
      host.persist();
      pushToSession();
      publishSessionSources();
      /* Give a failed clip another chance to report itself — the edit may have
         been the fix (a clip removed, a source re-cached). */
      if (!options.skipRedraw) afterProjectChange();
      else {
        problem.hidden = true;
        playerInstance.clearErrors();
        playerInstance.projectChanged();
        renderTransport();
      }
    }

    /* --- the stage: monitor and transport --- */

    var stage = el("div", "ve-stage");
    var monitorWrap = el("div", "ve-monitor-wrap");
    var monitor = el("div", "ve-monitor");
    monitorWrap.appendChild(monitor);
    stage.appendChild(monitorWrap);

    var transport = el("div", "ve-transport");
    stage.appendChild(transport);
    root.appendChild(stage);

    var problem = el("div", "ve-problem");
    problem.hidden = true;
    root.appendChild(problem);

    var playerInstance = ns.player.create({
      getProject: function () {
        return item.project;
      },
      resolve: resolveClip,
      onTick: function (time) {
        updatePlayhead(time);
      },
      onError: function (message) {
        /* A playback problem outranks the missing-file notice: it is the thing
           the user is looking at right now. */
        problem.hidden = false;
        problem.textContent = message;
        problem.dataset.kind = "playback";
      }
    });
    monitor.appendChild(playerInstance.canvas);

    var monitorTap = el("button", "ve-monitor-tap");
    monitorTap.type = "button";
    monitorTap.setAttribute("aria-label", "Play or pause");
    monitorTap.innerHTML = '<span class="ve-monitor-glyph">' + I.play + "</span>";
    monitorTap.onclick = function () {
      playerInstance.toggle();
      renderTransport();
    };
    monitor.appendChild(monitorTap);

    var ratioBadge = el("span", "ve-monitor-badge");
    monitor.appendChild(ratioBadge);

    function previewResolution() {
      var wide = Math.min(project.width, 960);
      playerInstance.setResolution(Math.round(wide), Math.round(wide * (project.height / project.width)));
    }
    previewResolution();

    /* The monitor is sized in script rather than with `aspect-ratio`, because a
       9:16 project on a phone has to be capped by height *and* width at once —
       and CSS cannot satisfy both without distorting one of them. */
    function sizeMonitor() {
      var available = monitorWrap.clientWidth || root.clientWidth || 320;
      if (available < 40) return;
      var ratio = project.width / project.height,
        maxHeight = Math.max(150, Math.min(window.innerHeight * 0.42, 460)),
        width = available,
        height = width / ratio;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * ratio;
      }
      monitor.style.width = Math.round(width) + "px";
      monitor.style.height = Math.round(height) + "px";
      var aspect = timeline.aspectOf(project);
      ratioBadge.textContent = aspect ? aspect.label : project.width + "×" + project.height;
    }

    /* --- zoom --- */

    function zoom() {
      return zoomByItem[item.id] || DEFAULT_ZOOM;
    }
    function clampZoom(value) {
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    }
    /* The playhead is fixed on screen, so a zoom only has to re-lay the film and
       put the same moment back under the needle. */
    function setZoom(value) {
      var next = clampZoom(value);
      if (Math.abs(next - zoom()) < 0.01) return;
      zoomByItem[item.id] = next;
      renderTimeline();
      syncScroll(true);
    }
    function zoomStep(factor) {
      setZoom(zoom() * factor);
    }
    function zoomToFit() {
      var total = timeline.duration(project);
      if (total <= 0) return setZoom(DEFAULT_ZOOM);
      var available = scroller.clientWidth - 24;
      if (available < 80) return;
      setZoom(available / total);
    }

    /* --- source resolution --- */

    function sharedFor(clip) {
      return sharedSources[collab ? collab.sourceKey(clip.sourceItemId, clip.sourceFileId) : ""] || null;
    }

    function resolveClip(clip) {
      var source = media.findSource(clip.sourceItemId, clip.sourceFileId);
      if (source) return media.resolveEntry(source.item, source.entry);
      var shared = sharedFor(clip);
      if (shared && shared.url) {
        return Promise.resolve({ url: shared.url, local: false, revoke: false, crossOrigin: true, still: shared.kind === "image" });
      }
      return Promise.reject(new Error("A clip's source file is no longer in your account."));
    }

    function hasSource(clip) {
      if (!clip.sourceItemId) return true;
      if (media.sourceExists(clip.sourceItemId, clip.sourceFileId)) return true;
      return !!sharedFor(clip);
    }

    function clipLabel(track, clip) {
      if (track.kind === "text") return (clip.text && clip.text.value ? clip.text.value.split("\n")[0] : "Text") || "Text";
      var source = media.findSource(clip.sourceItemId, clip.sourceFileId);
      if (source) return source.entry.name || "Clip";
      var shared = sharedFor(clip);
      if (shared) return shared.name || "Shared clip";
      return "Missing file";
    }

    function clipPoster(track, clip) {
      if (track.kind !== "video") return "";
      var source = media.findSource(clip.sourceItemId, clip.sourceFileId);
      if (source) return source.entry.poster || "";
      var shared = sharedFor(clip);
      return (shared && shared.poster) || "";
    }

    /* --- the timeline surface --- */

    var timelineWrap = el("div", "ve-timeline");
    var scroller = el("div", "ve-scroller");
    var surface = el("div", "ve-surface");
    var content = el("div", "ve-content");
    var ruler = el("div", "ve-ruler");
    var lanes = el("div", "ve-lanes");
    var guideNode = el("div", "ve-snap-guide");
    guideNode.hidden = true;
    content.appendChild(ruler);
    content.appendChild(lanes);
    content.appendChild(guideNode);
    surface.appendChild(content);
    scroller.appendChild(surface);
    timelineWrap.appendChild(scroller);

    var needle = el("div", "ve-needle");
    needle.innerHTML = '<span class="ve-needle-head"></span><span class="ve-needle-line"></span>';
    timelineWrap.appendChild(needle);

    var emptyState = el("div", "ve-timeline-empty");
    emptyState.hidden = true;
    emptyState.appendChild(el("b", null, "Nothing on the timeline yet"));
    emptyState.appendChild(el("small", null, "Import into this edit, or pull footage in from anywhere in your account."));
    emptyState.appendChild(
      button(I.plus + "<span>Add media</span>", "ve-btn ve-btn-primary", function () {
        openMediaSheet();
      })
    );
    timelineWrap.appendChild(emptyState);
    root.appendChild(timelineWrap);

    var rail = el("nav", "ve-rail");
    root.appendChild(rail);

    /* --- scroll is the scrub ---

       Scroll position *is* the playhead: time = scrollLeft / pixels-per-second.
       Nothing has to reconcile two sources of truth, because the correction
       below only fires when the two have actually drifted apart. */

    function scrollTolerance() {
      return Math.max(2, zoom() * 0.06);
    }

    function syncScroll(force) {
      var px = playerInstance.time() * zoom();
      if (force || Math.abs(scroller.scrollLeft - px) > 1) scroller.scrollLeft = px;
    }

    scroller.addEventListener(
      "scroll",
      function () {
        if (dragging || destroyed) return;
        var px = playerInstance.time() * zoom();
        if (Math.abs(scroller.scrollLeft - px) <= scrollTolerance()) return;
        if (playerInstance.isPlaying()) playerInstance.pause();
        playerInstance.seek(scroller.scrollLeft / zoom());
        renderTransport();
      },
      { passive: true }
    );

    /* A plain wheel scrolls the film sideways, which is what every timeline in
       every editor does; ctrl/⌘ + wheel zooms. */
    timelineWrap.addEventListener(
      "wheel",
      function (event) {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          zoomStep(event.deltaY < 0 ? 1.18 : 1 / 1.18);
          return;
        }
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        scroller.scrollLeft += event.deltaY;
      },
      { passive: false }
    );

    /* Pinch to zoom. Tracked here rather than with `touch-action` so a
       one-finger drag still scrubs. */
    var pinch = null;
    timelineWrap.addEventListener(
      "touchstart",
      function (event) {
        if (event.touches.length !== 2) return;
        pinch = { distance: touchGap(event), zoom: zoom() };
      },
      { passive: true }
    );
    timelineWrap.addEventListener(
      "touchmove",
      function (event) {
        if (!pinch || event.touches.length !== 2) return;
        event.preventDefault();
        var gap = touchGap(event);
        if (gap > 8) setZoom(pinch.zoom * (gap / pinch.distance));
      },
      { passive: false }
    );
    ["touchend", "touchcancel"].forEach(function (name) {
      timelineWrap.addEventListener(name, function () {
        pinch = null;
      });
    });
    function touchGap(event) {
      var a = event.touches[0],
        b = event.touches[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    }

    /* --- transport --- */

    var playBtn, timeNow, timeTotal, undoBtn, redoBtn, lastPlaying = false;

    (function buildTransport() {
      var left = el("div", "ve-transport-left");
      left.appendChild(
        button(I.skipStart, "ve-tbtn", function () {
          playerInstance.pause();
          playerInstance.seek(0);
          syncScroll(true);
          renderTransport();
        }, "Back to start (Home)")
      );
      playBtn = button(I.play, "ve-play", function () {
        playerInstance.toggle();
        renderTransport();
      }, "Play");
      left.appendChild(playBtn);
      left.appendChild(
        button(I.skipEnd, "ve-tbtn", function () {
          playerInstance.pause();
          playerInstance.seek(timeline.duration(project));
          syncScroll(true);
          renderTransport();
        }, "Jump to the end (End)")
      );

      var time = el("div", "ve-time");
      timeNow = el("span", "ve-time-now", "0:00.00");
      timeTotal = el("span", "ve-time-total", "0:00");
      time.appendChild(timeNow);
      time.appendChild(el("span", "ve-time-sep", "/"));
      time.appendChild(timeTotal);
      left.appendChild(time);
      transport.appendChild(left);

      var right = el("div", "ve-transport-right");
      undoBtn = button(I.undo, "ve-tbtn", undo, "Undo (Ctrl+Z)");
      redoBtn = button(I.redo, "ve-tbtn", redo, "Redo (Ctrl+Shift+Z)");
      right.appendChild(undoBtn);
      right.appendChild(redoBtn);
      right.appendChild(button(I.zoomOut, "ve-tbtn ve-hide-narrow", function () {
        zoomStep(1 / 1.5);
      }, "Zoom out"));
      right.appendChild(button(I.fit, "ve-tbtn", zoomToFit, "Fit the whole edit on screen"));
      right.appendChild(button(I.zoomIn, "ve-tbtn ve-hide-narrow", function () {
        zoomStep(1.5);
      }, "Zoom in"));
      transport.appendChild(right);
    })();

    function renderTransport() {
      var playing = playerInstance.isPlaying();
      lastPlaying = playing;
      playBtn.innerHTML = playing ? I.pause : I.play;
      playBtn.title = playing ? "Pause" : "Play";
      playBtn.setAttribute("aria-label", playBtn.title);
      monitor.classList.toggle("is-playing", playing);
      timeNow.textContent = timeline.formatTime(playerInstance.time(), true, project.fps);
      timeTotal.textContent = timeline.formatTime(timeline.duration(project));
      undoBtn.disabled = !undoStack.length;
      redoBtn.disabled = !redoStack.length;
    }

    function updatePlayhead(time) {
      if (timeNow) timeNow.textContent = timeline.formatTime(time, true, project.fps);
      var playing = playerInstance.isPlaying();
      if (playing && !dragging) syncScroll(false);
      if (playing !== lastPlaying) renderTransport();
    }

    /* --- rendering the timeline ---

       Rebuilds the whole thing. Cheap at this scale and it keeps the DOM a
       plain function of the project, which is much easier to reason about than
       incremental patching. Never called while a drag is in flight. */

    function renderTimeline() {
      if (dragging || destroyed) return;
      var total = timeline.duration(project),
        pxPerSecond = zoom(),
        viewport = scroller.clientWidth || 320,
        lead = Math.round(viewport / 2),
        width = Math.max(total * pxPerSecond, 1);

      /* The lead and tail padding is what lets the first and last frame reach
         the needle in the middle of the screen. */
      surface.style.paddingLeft = lead + "px";
      surface.style.paddingRight = lead + "px";
      content.style.width = width + "px";
      /* The needle is placed in pixels rather than at 50%, so a desktop
         scrollbar cannot push it out of step with the film underneath. */
      needle.style.left = lead + "px";

      /* --- ruler --- */
      ruler.innerHTML = "";
      var step = tickStep(pxPerSecond);
      for (var time = 0; time <= total + step; time += step) {
        var tick = el("div", "ve-tick");
        tick.style.left = time * pxPerSecond + "px";
        tick.appendChild(el("span", null, tickLabel(time, step)));
        ruler.appendChild(tick);
      }
      var minorPx = (step * pxPerSecond) / 4;
      ruler.style.backgroundImage =
        minorPx >= 11 ? "repeating-linear-gradient(90deg, var(--line-soft) 0 1px, transparent 1px " + minorPx + "px)" : "none";
      lanes.style.backgroundImage = "repeating-linear-gradient(90deg, var(--line-soft) 0 1px, transparent 1px " + step * pxPerSecond + "px)";

      /* --- lanes ---
         Text on top, then video layers with the topmost first, then audio at the
         floor. That is the order they paint in, read downwards. */
      lanes.innerHTML = "";
      orderedTracks().forEach(function (info) {
        lanes.appendChild(buildLane(info, pxPerSecond));
      });

      var empty = timeline.clipCount(project) === 0;
      emptyState.hidden = !empty;
      timelineWrap.classList.toggle("is-empty", empty);
    }

    function orderedTracks() {
      var counts = { video: 0, audio: 0, text: 0 };
      var decorated = project.tracks.map(function (track, index) {
        return { track: track, index: index, ordinal: counts[track.kind]++ };
      });
      var rank = { text: 0, video: 1, audio: 2 };
      return decorated.sort(function (a, b) {
        if (rank[a.track.kind] !== rank[b.track.kind]) return rank[a.track.kind] - rank[b.track.kind];
        return b.index - a.index;
      });
    }

    function trackColor(track, ordinal) {
      return track.color || autoTrackColor(track.kind, ordinal || 0);
    }

    function tickStep(pxPerSecond) {
      var candidates = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] * pxPerSecond >= 62) return candidates[i];
      }
      return 600;
    }

    function tickLabel(time, step) {
      if (step >= 1) return timeline.formatTime(time);
      var whole = Math.floor(time + 0.0001);
      return timeline.formatTime(whole) + "." + Math.round((time - whole) * 10);
    }

    function buildLane(info, pxPerSecond) {
      var track = info.track,
        laneRow = el("div", "ve-lane ve-lane-" + track.kind);
      laneRow.setAttribute("data-track-id", track.id);
      laneRow.style.setProperty("--ve-track", trackColor(track, info.ordinal));
      if (track.id === activeTrackId) laneRow.classList.add("is-active");
      if (track.hidden) laneRow.classList.add("is-hidden");
      if (track.muted) laneRow.classList.add("is-muted");
      if (track.locked) laneRow.classList.add("is-locked");

      track.clips.forEach(function (clip) {
        laneRow.appendChild(buildClipBlock(track, clip, pxPerSecond, info.ordinal));
      });
      laneRow.addEventListener("pointerdown", function (event) {
        if (event.target !== laneRow) return;
        activeTrackId = track.id;
        selectedClipId = null;
        markSelection();
        renderRail();
      });
      return laneRow;
    }

    function buildClipBlock(track, clip, pxPerSecond, ordinal) {
      var missing = !!clip.sourceItemId && !hasSource(clip),
        selected = clip.id === selectedClipId;

      var block = el("div", "ve-clip ve-clip-" + track.kind + (selected ? " is-selected" : "") + (missing ? " is-missing" : ""));
      block.style.left = clip.start * pxPerSecond + "px";
      block.style.width = Math.max(14, timeline.clipLength(clip) * pxPerSecond) + "px";
      block.setAttribute("data-clip-id", clip.id);
      if (clip.color) block.style.setProperty("--ve-track", clip.color);

      var poster = clipPoster(track, clip);
      if (poster) {
        var strip = el("div", "ve-clip-strip");
        strip.style.backgroundImage = "url(" + poster + ")";
        block.appendChild(strip);
      }

      var caption = el("span", "ve-clip-caption");
      var badge = el("span", "ve-clip-badge");
      badge.innerHTML = missing ? I.close : TRACK_ICONS[track.kind] || "";
      caption.appendChild(badge);
      caption.appendChild(el("span", "ve-clip-name", missing ? "Missing file" : clipLabel(track, clip)));
      block.appendChild(caption);

      if (animations && animations.summary(clip)) {
        var spark = el("span", "ve-clip-spark");
        spark.innerHTML = I.sparkle;
        spark.title = animations.summary(clip);
        block.appendChild(spark);
      }

      ["start", "end"].forEach(function (edge) {
        var handle = el("div", "ve-handle ve-handle-" + edge);
        handle.innerHTML = '<span class="ve-handle-grip"></span>';
        handle.addEventListener("pointerdown", function (event) {
          event.stopPropagation();
          /* On touch, an unselected clip's edge is a tap target for selecting,
             not trimming — same rule as the clip body below. */
          if (event.pointerType === "touch" && selectedClipId !== clip.id) {
            selectClip(clip.id, track.id);
            return;
          }
          if (track.locked) return host.showToast(track.name + " is locked", true);
          beginTrim(event, block, track, clip, edge, pxPerSecond);
        });
        block.appendChild(handle);
      });

      block.addEventListener("pointerdown", function (event) {
        var wasSelected = selectedClipId === clip.id;
        selectClip(clip.id, track.id);
        /* Touch is two-step, like every phone editor: the first tap selects
           (and leaves the gesture free to scrub the timeline), dragging only
           starts once the clip is already selected. Mouse drags immediately. */
        if (event.pointerType === "touch" && !wasSelected) return;
        if (track.locked) return;
        beginMove(event, block, track, clip, pxPerSecond);
      });
      return block;
    }

    /* Selection is a class, not a layout, so it is applied to the nodes that are
       already on screen. Re-rendering here would replace the very block the
       pointer is about to drag, and a drag measured against a detached element
       lands nowhere. */
    function markSelection() {
      Array.prototype.forEach.call(lanes.querySelectorAll(".ve-clip"), function (node) {
        node.classList.toggle("is-selected", node.getAttribute("data-clip-id") === selectedClipId);
      });
      Array.prototype.forEach.call(lanes.querySelectorAll(".ve-lane"), function (node) {
        node.classList.toggle("is-active", node.getAttribute("data-track-id") === activeTrackId);
      });
    }

    function selectClip(clipId, trackId) {
      selectedClipId = clipId;
      activeTrackId = trackId || activeTrackId;
      markSelection();
      renderRail();
    }

    /* --- the snap guide ---

       A vertical line that appears when a dragged edge locks onto another
       clip's edge or the playhead, so it is obvious *why* the drag stuck. */

    function showGuide(time) {
      guideNode.hidden = false;
      guideNode.style.transform = "translateX(" + time * zoom() + "px)";
    }
    function hideGuide() {
      guideNode.hidden = true;
    }

    /* Pointer capture is best effort — it throws if the pointer is already
       gone, and losing it only costs a little drag smoothness. */
    function capture(node, pointerId) {
      try {
        node.setPointerCapture(pointerId);
      } catch (e) {}
    }

    /* --- dragging clips ---

       The model is only touched on release. While the pointer is down the block
       moves with inline styles, which keeps the drag smooth and means a
       re-render triggered by an autosave or a peer's edit cannot pull the DOM
       out from under it.

       Positions are measured from the *content* rectangle, which moves with the
       scroller. That is what makes edge auto-scroll fall out for free: scrolling
       shifts the rectangle, so the same held finger lands on a later time. */

    function contentLeft() {
      return content.getBoundingClientRect().left;
    }

    function autoScroll(clientX, onStep) {
      var rect = scroller.getBoundingClientRect(),
        margin = 46,
        speed = 0;
      if (clientX < rect.left + margin) speed = -Math.min(22, (rect.left + margin - clientX) / 2.2);
      else if (clientX > rect.right - margin) speed = Math.min(22, (clientX - (rect.right - margin)) / 2.2);
      if (!speed) return false;
      scroller.scrollLeft += speed;
      if (onStep) onStep();
      return true;
    }

    function beginMove(event, block, track, clip, pxPerSecond) {
      var grabOffset = event.clientX - block.getBoundingClientRect().left,
        startX = event.clientX,
        startY = event.clientY,
        lastX = event.clientX,
        lastY = event.clientY,
        moved = false,
        targetTrack = track,
        points = timeline.snapPoints(project, clip.id, playerInstance.time()),
        length = timeline.clipLength(clip),
        scrollTimer = null;

      dragging = true;
      capture(block, event.pointerId);
      block.classList.add("is-dragging");
      timelineWrap.classList.add("is-dragging");

      /* Which lane the pointer is over. Measured from the lane rectangles rather
         than with elementFromPoint, so a sheet or any other overlay cannot break
         dragging a clip to another track. */
      function laneUnder(clientY) {
        var found = null;
        Array.prototype.forEach.call(lanes.querySelectorAll(".ve-lane"), function (lane) {
          if (found) return;
          var rect = lane.getBoundingClientRect();
          if (clientY < rect.top || clientY > rect.bottom) return;
          var candidate = timeline.findTrack(project, lane.getAttribute("data-track-id"));
          if (candidate && candidate.kind === track.kind && !candidate.locked) found = candidate;
        });
        return found;
      }

      function place() {
        var wantedStart = Math.max(0, (lastX - grabOffset - contentLeft()) / pxPerSecond);
        /* Snap either edge of the clip, whichever is closer to a marker. */
        var snappedStart = timeline.snapTime(wantedStart, points),
          snappedEnd = timeline.snapTime(wantedStart + length, points) - length,
          pickStart = Math.abs(snappedStart - wantedStart) <= Math.abs(snappedEnd - wantedStart),
          start = Math.max(0, pickStart ? snappedStart : snappedEnd);
        block.style.left = start * pxPerSecond + "px";
        block.dataset.pendingStart = start;
        if (Math.abs(start - wantedStart) > 0.0008) showGuide(pickStart ? start : start + length);
        else hideGuide();
      }

      function move(moveEvent) {
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        if (!moved && Math.abs(lastX - startX) < 3 && Math.abs(lastY - startY) < 3) return;
        moved = true;
        moveEvent.preventDefault();
        place();
        var overLane = laneUnder(lastY);
        if (overLane) targetTrack = overLane;
        if (!scrollTimer) {
          scrollTimer = setInterval(function () {
            if (autoScroll(lastX, place)) {
              var overNow = laneUnder(lastY);
              if (overNow) targetTrack = overNow;
            }
          }, 16);
        }
      }

      function finish() {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", finish);
        clearInterval(scrollTimer);
        block.classList.remove("is-dragging");
        timelineWrap.classList.remove("is-dragging");
        hideGuide();
        dragging = false;
        if (!moved) {
          markSelection();
          renderRail();
          return;
        }
        timeline.moveClip(project, clip.id, targetTrack.id, Number(block.dataset.pendingStart || clip.start));
        commit();
      }

      block.addEventListener("pointermove", move);
      block.addEventListener("pointerup", finish);
      block.addEventListener("pointercancel", finish);
    }

    function beginTrim(event, block, track, clip, edge, pxPerSecond) {
      var points = timeline.snapPoints(project, clip.id, playerInstance.time()),
        originalStart = clip.start,
        originalEnd = timeline.clipEnd(clip),
        grabOffset = event.clientX - contentLeft() - (edge === "start" ? originalStart : originalEnd) * pxPerSecond,
        lastX = event.clientX,
        pending = edge === "start" ? originalStart : originalEnd,
        scrollTimer = null;

      dragging = true;
      selectedClipId = clip.id;
      capture(block, event.pointerId);
      block.classList.add("is-trimming");
      timelineWrap.classList.add("is-dragging");

      function place() {
        var raw = (lastX - grabOffset - contentLeft()) / pxPerSecond;
        pending = timeline.snapTime(raw, points);
        if (Math.abs(pending - raw) > 0.0008) showGuide(pending);
        else hideGuide();
        /* Preview the trim without committing, so the model stays clean until
           the pointer is released. */
        var previewStart = edge === "start" ? Math.min(pending, originalEnd - timeline.MIN_CLIP) : originalStart,
          previewEnd = edge === "start" ? originalEnd : Math.max(pending, originalStart + timeline.MIN_CLIP);
        block.style.left = Math.max(0, previewStart) * pxPerSecond + "px";
        block.style.width = Math.max(14, (previewEnd - Math.max(0, previewStart)) * pxPerSecond) + "px";
      }

      function move(moveEvent) {
        moveEvent.preventDefault();
        lastX = moveEvent.clientX;
        place();
        if (!scrollTimer) {
          scrollTimer = setInterval(function () {
            autoScroll(lastX, place);
          }, 16);
        }
      }

      function finish() {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", finish);
        clearInterval(scrollTimer);
        block.classList.remove("is-trimming");
        timelineWrap.classList.remove("is-dragging");
        hideGuide();
        dragging = false;
        timeline.trimClip(project, clip.id, edge, pending);
        commit();
      }

      block.addEventListener("pointermove", move);
      block.addEventListener("pointerup", finish);
      block.addEventListener("pointercancel", finish);
    }

    /* --- the action rail ---

       Two states, exactly like a phone editor: with nothing selected it offers
       the things you do to the edit, and with a clip selected it offers the
       things you do to that clip. */

    function renderRail() {
      if (destroyed) return;
      rail.innerHTML = "";
      var hit = selectedClipId ? timeline.findClip(project, selectedClipId) : null;
      if (hit) renderClipRail(hit);
      else renderRootRail();
    }

    function renderRootRail() {
      rail.classList.remove("is-clip");
      rail.appendChild(railButton(I.plus, "Media", openMediaSheet, { className: "is-primary", title: "Add video, audio or stills" }));
      rail.appendChild(railButton(I.text, "Text", addTextClip, { title: "Add a title at the playhead" }));
      if (recorder) {
        rail.appendChild(
          railButton('<span class="ve-rec-dot"></span>', timeline.formatTime((Date.now() - recorder.started) / 1000), toggleVoiceover, {
            className: "is-recording",
            title: "Stop recording"
          })
        );
      } else {
        rail.appendChild(railButton(I.mic, "Voice", toggleVoiceover, { title: "Record a voiceover straight into this edit" }));
      }
      rail.appendChild(
        railButton(I.scissors, "Split", function () {
          var cuts = timeline.splitAt(project, playerInstance.time());
          if (!cuts) return host.showToast("Move the playhead over a clip to split it", true);
          commit();
          host.showToast(cuts + " clip" + (cuts === 1 ? "" : "s") + " split");
        }, { title: "Split every clip under the playhead (S)" })
      );
      rail.appendChild(railButton(I.layers, "Tracks", openTracksSheet, { title: "Add, colour, mute, lock and reorder tracks" }));
      rail.appendChild(railButton(I.ratio, "Ratio", openRatioSheet, { title: "Frame size" }));
      rail.appendChild(railButton(I.users, "Share", openShareSheet, { className: sessionActive() ? "is-live" : "", title: "Collaborate on this edit" }));
      rail.appendChild(railButton(I.download, "Export", openExportSheet, { className: "is-accent", title: "Render this cut to a video file" }));
    }

    function renderClipRail(hit) {
      var clip = hit.clip,
        track = hit.track;
      rail.classList.add("is-clip");

      var summary = el("div", "ve-rail-summary");
      summary.appendChild(el("b", null, clipLabel(track, clip)));
      summary.appendChild(
        el("small", null, timeline.formatTime(timeline.clipLength(clip)) + " · " + track.name + (track.locked ? " · locked" : ""))
      );
      summary.appendChild(button(I.close, "ve-ibtn", closeSelection, "Deselect"));
      rail.appendChild(summary);

      var buttons = el("div", "ve-rail-scroll");
      buttons.appendChild(
        railButton(I.scissors, "Split", function () {
          if (!timeline.splitAt(project, playerInstance.time(), clip.id)) return host.showToast("Put the playhead inside this clip first", true);
          commit();
        })
      );
      buttons.appendChild(
        railButton(I.copy, "Copy", function () {
          var copy = timeline.duplicateClip(project, clip.id);
          if (!copy) return host.showToast("This track is locked", true);
          selectedClipId = copy.id;
          commit();
        }, { title: "Duplicate this clip" })
      );
      buttons.appendChild(railButton(I.sparkle, "Animate", function () {
        openAnimationSheet(clip);
      }, { title: "Entrance, exit and looping animations" }));
      buttons.appendChild(railButton(I.sliders, "Adjust", function () {
        openAdjustSheet(hit);
      }, { title: "Volume, fades, framing and opacity" }));
      if (track.kind === "text") {
        buttons.appendChild(railButton(I.text, "Style", function () {
          openTextSheet(clip);
        }, { title: "Text content and style" }));
      }
      buttons.appendChild(railButton(I.palette, "Colour", function () {
        openClipColorSheet(hit);
      }, { title: "Colour this clip on the timeline" }));
      buttons.appendChild(
        railButton(I.trash, "Delete", function () {
          if (!timeline.removeClip(project, clip.id)) return host.showToast("This track is locked", true);
          selectedClipId = null;
          commit();
        }, { className: "is-danger", title: "Delete this clip (Del)" })
      );
      buttons.appendChild(
        railButton(I.up, "Close gap", function () {
          if (!timeline.rippleDelete(project, clip.id)) return host.showToast("This track is locked", true);
          selectedClipId = null;
          commit();
        }, { className: "is-danger", title: "Delete and pull the rest of the track back" })
      );
      rail.appendChild(buttons);
    }

    /* --- adding content --- */

    function firstTrackOfKind(kind) {
      var active = activeTrackId ? timeline.findTrack(project, activeTrackId) : null;
      if (active && active.kind === kind && !active.locked) return active;
      return project.tracks.filter(function (track) {
        return track.kind === kind && !track.locked;
      })[0];
    }

    function addLibraryEntry(entry, options) {
      options = options || {};
      var kind = entry.kind === "audio" ? "audio" : "video",
        track = firstTrackOfKind(kind);
      if (!track) track = timeline.addTrack(project, kind);
      var clip = timeline.createMediaClip({
        itemId: entry.itemId,
        fileId: entry.fileId,
        duration: entry.still ? media.STILL_DEFAULT_SECONDS : entry.duration,
        still: entry.still,
        srcDuration: entry.still ? media.STILL_SOURCE_SECONDS : entry.duration
      });
      if (options.atPlayhead) timeline.addClip(project, track.id, clip, playerInstance.time());
      else timeline.appendClip(project, track.id, clip);
      selectedClipId = clip.id;
      activeTrackId = track.id;
      commit();
      return clip;
    }

    function addTextClip() {
      var track = project.tracks.filter(function (candidate) {
        return candidate.kind === "text" && !candidate.locked;
      })[0];
      if (!track) track = timeline.addTrack(project, "text", "Text 1");
      var clip = timeline.createTextClip({ start: playerInstance.time(), length: 3 });
      timeline.addClip(project, track.id, clip, playerInstance.time());
      selectedClipId = clip.id;
      activeTrackId = track.id;
      commit();
      openTextSheet(clip);
    }

    /* --- the media sheet ---

       Three sources in one place: this edit's own pool, everything else in the
       account, and the device. */

    function openMediaSheet() {
      var stopWatchingPool = null;
      openSheet({
        title: "Add media",
        hint: "Tap a file to drop it on the timeline",
        wide: true,
        onClose: function () {
          if (stopWatchingPool) stopWatchingPool();
        },
        build: function (body, close) {
          var tab = "pool";
          var tabs = el("div", "ve-tabs");
          var panel = el("div", "ve-media-panel");

          [["pool", "This edit"], ["account", "My account"], ["import", "Import"]].forEach(function (pair) {
            var node = button(pair[1], "ve-tab" + (tab === pair[0] ? " is-on" : ""), function () {
              tab = pair[0];
              Array.prototype.forEach.call(tabs.children, function (child) {
                child.classList.remove("is-on");
              });
              node.classList.add("is-on");
              draw();
            });
            tabs.appendChild(node);
          });
          body.appendChild(tabs);
          body.appendChild(panel);

          /* Upload progress on a file being imported right now should show in
             the pool list without the user having to reopen the sheet. */
          stopWatchingPool = media.onUploadChange(function () {
            if (tab === "pool") draw();
          });

          function draw() {
            panel.innerHTML = "";
            if (tab === "import") return drawImport();
            if (tab === "pool") return drawPool();
            drawAccount();
          }

          function drawImport() {
            panel.appendChild(
              buildDropZone({
                accept: "video/*,audio/*,image/*",
                icon: I.upload,
                title: "Import into this edit",
                hint: "Video, audio or stills. They are saved with this edit and synced to every device.",
                onFiles: function (files) {
                  media.addFiles(item, files, { list: "pool", kind: "pool", accept: "media" }).then(function (added) {
                    if (!added.length) return;
                    tab = "pool";
                    Array.prototype.forEach.call(tabs.children, function (child, index) {
                      child.classList.toggle("is-on", index === 0);
                    });
                    draw();
                  });
                }
              })
            );
            panel.appendChild(
              el(
                "p",
                "ve-hint",
                "Files imported here belong to this edit and travel with it. Use a Video or Files item instead when the same footage is going into several edits."
              )
            );
          }

          function drawPool() {
            var entries = media.libraryEntries({ itemId: item.id });
            if (!entries.length) {
              panel.appendChild(el("div", "ve-empty", "This edit has no media of its own yet. Use Import to bring some in."));
              panel.appendChild(
                button(I.upload + "<span>Import files</span>", "ve-btn ve-btn-primary", function () {
                  tab = "import";
                  Array.prototype.forEach.call(tabs.children, function (child, index) {
                    child.classList.toggle("is-on", index === 2);
                  });
                  draw();
                })
              );
              return;
            }
            panel.appendChild(buildPickerGrid(entries, close, true));
          }

          function drawAccount() {
            var controls = el("div", "ve-picker-controls");
            var search = document.createElement("input");
            search.type = "search";
            search.className = "ve-search";
            search.placeholder = "Search files, items or folders";
            controls.appendChild(search);

            var kindFilter = "all";
            controls.appendChild(
              chipPicker([["all", "Everything"], ["video", "Video"], ["audio", "Audio"], ["image", "Stills"]], kindFilter, function (value) {
                kindFilter = value;
                refresh();
              })
            );

            var folderFilter = null,
              folders = host.folders();
            if (folders.length) {
              var folderOptions = [[null, "All folders"]].concat(
                folders.map(function (folder) {
                  return [folder.id, folder.name];
                })
              );
              controls.appendChild(
                chipPicker(folderOptions, null, function (value) {
                  folderFilter = value;
                  refresh();
                })
              );
            }
            panel.appendChild(controls);

            var results = el("div", "ve-picker-results");
            panel.appendChild(results);

            function refresh() {
              var entries = media.libraryEntries({
                kind: kindFilter === "all" ? null : kindFilter,
                query: search.value.trim(),
                folderId: folderFilter,
                exclude: item.id
              });
              results.innerHTML = "";
              if (!entries.length) {
                results.appendChild(
                  el("div", "ve-empty", "Nothing matches. Create a Video or Files item, upload your clips, and they show up here in every edit.")
                );
                return;
              }
              results.appendChild(buildPickerGrid(entries, close, false));
            }
            search.oninput = refresh;
            refresh();
          }

          function buildPickerGrid(entries, closeSheet, own) {
            var grid = el("div", "ve-picker-grid");
            entries.forEach(function (entry) {
              var card = el("button", "ve-picker-card");
              card.type = "button";
              var thumb = el("div", "ve-picker-thumb");
              thumb.appendChild(posterNode(entry.entry, "ve-picker-poster"));
              if (entry.duration) thumb.appendChild(el("span", "ve-picker-length", timeline.formatTime(entry.duration)));
              if (entry.still) thumb.appendChild(el("span", "ve-picker-length", "Still"));
              card.appendChild(thumb);
              var info = el("div", "ve-picker-info");
              info.appendChild(el("b", null, entry.name));
              info.appendChild(
                el(
                  "small",
                  null,
                  (own ? [media.syncLabel(item, entry.entry)] : [entry.itemTitle, entry.folderName]).filter(Boolean).join(" · ")
                )
              );
              card.appendChild(info);
              card.onclick = function () {
                addLibraryEntry(entry);
                host.showToast("Added " + entry.name);
                closeSheet();
              };
              grid.appendChild(card);
            });
            return grid;
          }

          draw();
        }
      });
    }

    /* --- the tracks sheet --- */

    function openTracksSheet() {
      var handle = openSheet({
        title: "Tracks",
        hint: "Colour, mute, hide, lock and reorder",
        build: function (body) {
          draw();

          function draw() {
            body.innerHTML = "";
            var list = el("div", "ve-track-list");
            orderedTracks().forEach(function (info) {
              list.appendChild(buildTrackRow(info, draw));
            });
            body.appendChild(list);

            var add = el("div", "ve-sheet-actions");
            add.appendChild(
              button(I.film + "<span>Video track</span>", "ve-btn", function () {
                timeline.addTrack(project, "video");
                commit();
                draw();
              })
            );
            add.appendChild(
              button(I.wave + "<span>Audio track</span>", "ve-btn", function () {
                timeline.addTrack(project, "audio");
                commit();
                draw();
              })
            );
            add.appendChild(
              button(I.text + "<span>Text track</span>", "ve-btn", function () {
                timeline.addTrack(project, "text");
                commit();
                draw();
              })
            );
            body.appendChild(add);
          }
        }
      });
      return handle;
    }

    function buildTrackRow(info, redraw) {
      var track = info.track,
        node = el("div", "ve-track-row");
      node.style.setProperty("--ve-track", trackColor(track, info.ordinal));

      var swatch = button("", "ve-track-swatch", function () {
        openTrackColorSheet(track, info.ordinal, redraw);
      }, "Track colour");
      node.appendChild(swatch);

      var name = document.createElement("input");
      name.className = "ve-track-name";
      name.value = track.name;
      name.setAttribute("aria-label", "Track name");
      name.oninput = function () {
        track.name = name.value;
        host.touchItem(item);
        host.save();
      };
      name.onchange = function () {
        commit({ skipRedraw: true });
        renderTimeline();
      };
      node.appendChild(name);

      var meta = el("small", "ve-track-meta", track.clips.length + " clip" + (track.clips.length === 1 ? "" : "s"));
      node.appendChild(meta);

      var tools = el("div", "ve-track-tools");
      tools.appendChild(
        button(track.muted ? I.volumeOff : I.volume, "ve-ibtn" + (track.muted ? " is-off" : ""), function () {
          track.muted = !track.muted;
          commit();
          redraw();
        }, track.muted ? "Unmute" : "Mute")
      );
      if (track.kind !== "audio") {
        tools.appendChild(
          button(track.hidden ? I.eyeOff : I.eye, "ve-ibtn" + (track.hidden ? " is-off" : ""), function () {
            track.hidden = !track.hidden;
            commit();
            redraw();
          }, track.hidden ? "Show" : "Hide")
        );
      }
      tools.appendChild(
        button(track.locked ? I.lock : I.unlock, "ve-ibtn" + (track.locked ? " is-on" : ""), function () {
          track.locked = !track.locked;
          commit();
          redraw();
        }, track.locked ? "Unlock this track" : "Lock this track so clips cannot move")
      );
      tools.appendChild(
        button(I.up, "ve-ibtn", function () {
          if (!timeline.moveTrack(project, track.id, 1)) return;
          commit();
          redraw();
        }, "Move up")
      );
      tools.appendChild(
        button(I.down, "ve-ibtn", function () {
          if (!timeline.moveTrack(project, track.id, -1)) return;
          commit();
          redraw();
        }, "Move down")
      );
      tools.appendChild(
        button(I.trash, "ve-ibtn ve-ibtn-danger", function () {
          var remove = function () {
            if (!timeline.removeTrack(project, track.id)) return host.showToast("Keep at least one " + track.kind + " track", true);
            if (selectedClipId && !timeline.findClip(project, selectedClipId)) selectedClipId = null;
            commit();
            redraw();
          };
          if (!track.clips.length) return remove();
          confirmSheet("Remove track", "Remove " + track.name + " and its " + track.clips.length + " clip(s) from this edit?", "Remove", remove);
        }, "Remove track")
      );
      node.appendChild(tools);
      return node;
    }

    function openTrackColorSheet(track, ordinal, redraw) {
      openColorSheet({
        title: track.name + " colour",
        current: track.color,
        auto: autoTrackColor(track.kind, ordinal),
        onPick: function (value) {
          track.color = value;
          commit();
          if (redraw) redraw();
        }
      });
    }

    function openClipColorSheet(hit) {
      openColorSheet({
        title: "Clip colour",
        hint: "Only changes how the clip looks on the timeline, never the picture.",
        current: hit.clip.color,
        auto: trackColor(hit.track, 0),
        onPick: function (value) {
          hit.clip.color = value;
          commit();
        }
      });
    }

    function openColorSheet(options) {
      openSheet({
        title: options.title,
        hint: options.hint,
        build: function (body, close) {
          var grid = el("div", "ve-swatches");
          var autoChip = el("button", "ve-swatch is-auto" + (options.current ? "" : " is-on"));
          autoChip.type = "button";
          autoChip.style.setProperty("--ve-swatch", options.auto);
          autoChip.title = "Follow the app theme";
          autoChip.innerHTML = "<span>Auto</span>";
          autoChip.onclick = function () {
            options.onPick("");
            close();
          };
          grid.appendChild(autoChip);

          swatchPalette().forEach(function (color) {
            var chip = el("button", "ve-swatch" + (options.current === color ? " is-on" : ""));
            chip.type = "button";
            chip.style.setProperty("--ve-swatch", color);
            chip.title = color;
            chip.onclick = function () {
              options.onPick(color);
              close();
            };
            grid.appendChild(chip);
          });
          body.appendChild(grid);

          var custom = field("Pick your own");
          var input = document.createElement("input");
          input.type = "color";
          input.className = "ve-color";
          input.value = options.current || "#ffffff";
          input.onchange = function () {
            options.onPick(input.value);
            close();
          };
          custom.appendChild(input);
          body.appendChild(custom);
        }
      });
    }

    /* --- the animation sheet --- */

    function openAnimationSheet(clip) {
      openSheet({
        title: "Animation",
        hint: animations ? animations.count() + " to choose from" : "",
        wide: true,
        build: function (body) {
          if (!animations) {
            body.appendChild(el("div", "ve-empty", "Animations are not loaded."));
            return;
          }
          var slot = "in";
          body.appendChild(
            chipPicker([["in", "Entrance"], ["out", "Exit"], ["loop", "Loop"]], slot, function (value) {
              slot = value;
              draw();
            })
          );
          var panel = el("div", "ve-anim-panel");
          body.appendChild(panel);

          function draw() {
            panel.innerHTML = "";
            var current = clip.anim[slot] || { id: "", d: 0.5 };
            var grid = el("div", "ve-anim-grid");
            animations.list(slot).forEach(function (def) {
              var tile = el("button", "ve-anim-tile" + (current.id === def.id ? " is-on" : ""));
              tile.type = "button";
              var art = el("span", "ve-anim-art ve-anim-" + (def.id || "none"));
              art.innerHTML = def.id ? I.sparkle : I.close;
              tile.appendChild(art);
              tile.appendChild(el("span", "ve-anim-label", def.label));
              tile.onclick = function () {
                clip.anim[slot] = { id: def.id, d: def.id ? current.d || def.defaultDuration : current.d };
                commit({ skipRedraw: true });
                renderTimeline();
                draw();
                if (def.id) previewAnimation(clip, slot);
              };
              grid.appendChild(tile);
            });
            panel.appendChild(grid);

            var def = animations.get(current.id);
            if (def) {
              panel.appendChild(
                slider(
                  slot === "loop" ? "Cycle length" : "Duration",
                  Math.min(Math.max(current.d, def.minDuration), def.maxDuration),
                  def.minDuration,
                  def.maxDuration,
                  0.05,
                  function (value) {
                    clip.anim[slot].d = value;
                    host.touchItem(item);
                    host.save();
                    playerInstance.projectChanged();
                  },
                  function (value) {
                    return Number(value).toFixed(2) + "s";
                  },
                  function () {
                    settle();
                    previewAnimation(clip, slot);
                  }
                )
              );
              panel.appendChild(
                button("Remove this animation", "ve-btn ve-btn-danger", function () {
                  clip.anim[slot] = { id: "", d: current.d };
                  commit({ skipRedraw: true });
                  renderTimeline();
                  draw();
                })
              );
            }
            panel.appendChild(
              el(
                "p",
                "ve-hint",
                "Adding more is a single register() call in video/animations.js — everything here, in the preview and in exports picks it up automatically."
              )
            );
          }
          draw();
        }
      });
    }

    /* Jumps the playhead to where the animation happens and plays a beat of it,
       so choosing one shows the result instead of describing it. */
    function previewAnimation(clip, slot) {
      var length = timeline.clipLength(clip),
        duration = (clip.anim[slot] && clip.anim[slot].d) || 0.6,
        from = slot === "out" ? Math.max(clip.start, clip.start + length - duration - 0.15) : clip.start;
      playerInstance.pause();
      playerInstance.seek(from);
      syncScroll(true);
      playerInstance.play();
      renderTransport();
      setTimeout(function () {
        if (destroyed) return;
        playerInstance.pause();
        renderTransport();
      }, Math.min(4000, (duration + 0.5) * 1000));
    }

    /* --- the adjust sheet --- */

    function openAdjustSheet(hit) {
      var clip = hit.clip,
        track = hit.track;
      openSheet({
        title: "Adjust",
        hint: clipLabel(track, clip),
        build: function (body) {
          var grid = el("div", "ve-form-grid");

          if (track.kind !== "text") {
            grid.appendChild(
              slider("Volume", Math.round(clip.volume * 100), 0, 200, 1, function (value) {
                clip.volume = value / 100;
                host.touchItem(item);
                host.save();
              }, function (value) {
                return value + "%";
              }, settle)
            );
            var length = timeline.clipLength(clip),
              fadeMax = Math.max(0.5, Math.min(5, length));
            grid.appendChild(
              slider("Fade in", Math.min(clip.fadeIn, fadeMax), 0, fadeMax, 0.05, function (value) {
                clip.fadeIn = value;
                host.touchItem(item);
                host.save();
              }, function (value) {
                return Number(value).toFixed(2) + "s";
              }, settle)
            );
            grid.appendChild(
              slider("Fade out", Math.min(clip.fadeOut, fadeMax), 0, fadeMax, 0.05, function (value) {
                clip.fadeOut = value;
                host.touchItem(item);
                host.save();
              }, function (value) {
                return Number(value).toFixed(2) + "s";
              }, settle)
            );
            var muteRow = row("Mute this clip");
            muteRow.appendChild(
              button(clip.muted ? "Muted" : "Audible", "ve-chip" + (clip.muted ? " is-off" : ""), function (event) {
                clip.muted = !clip.muted;
                event.currentTarget.textContent = clip.muted ? "Muted" : "Audible";
                event.currentTarget.classList.toggle("is-off", clip.muted);
                commit({ skipRedraw: true });
              })
            );
            grid.appendChild(muteRow);
          }

          if (track.kind === "video" || track.kind === "text") {
            grid.appendChild(
              slider("Opacity", Math.round(clip.opacity * 100), 0, 100, 1, function (value) {
                clip.opacity = value / 100;
                host.touchItem(item);
                host.save();
                playerInstance.projectChanged();
              }, function (value) {
                return value + "%";
              }, settle)
            );
          }

          if (track.kind === "video") {
            var fitRow = row("Framing", "Contain letterboxes the clip, cover fills the frame");
            fitRow.appendChild(
              button(clip.fit === "cover" ? "Cover" : "Contain", "ve-chip", function (event) {
                clip.fit = clip.fit === "cover" ? "contain" : "cover";
                event.currentTarget.textContent = clip.fit === "cover" ? "Cover" : "Contain";
                commit({ skipRedraw: true });
              })
            );
            grid.appendChild(fitRow);
            grid.appendChild(
              slider("Scale", Math.round(clip.scale * 100), 20, 300, 1, function (value) {
                clip.scale = value / 100;
                host.touchItem(item);
                host.save();
                playerInstance.projectChanged();
              }, function (value) {
                return value + "%";
              }, settle)
            );
            grid.appendChild(
              slider("Nudge across", clip.offsetX, -50, 50, 1, function (value) {
                clip.offsetX = value;
                host.touchItem(item);
                host.save();
                playerInstance.projectChanged();
              }, function (value) {
                return value + "%";
              }, settle)
            );
            grid.appendChild(
              slider("Nudge down", clip.offsetY, -50, 50, 1, function (value) {
                clip.offsetY = value;
                host.touchItem(item);
                host.save();
                playerInstance.projectChanged();
              }, function (value) {
                return value + "%";
              }, settle)
            );
          }

          body.appendChild(grid);
        }
      });
    }

    /* --- the text sheet --- */

    function openTextSheet(clip) {
      var text = clip.text;
      if (!text) return;
      openSheet({
        title: "Text",
        build: function (body) {
          var grid = el("div", "ve-form-grid");

          var valueField = field("Words");
          var area = document.createElement("textarea");
          area.className = "ve-textarea";
          area.rows = 3;
          area.value = text.value;
          area.oninput = function () {
            text.value = area.value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          };
          area.onchange = function () {
            settle();
            renderTimeline();
          };
          valueField.appendChild(area);
          grid.appendChild(valueField);

          var colorRow = row("Colour");
          var color = document.createElement("input");
          color.type = "color";
          color.className = "ve-color";
          color.value = text.color;
          color.oninput = function () {
            text.color = color.value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          };
          color.onchange = settle;
          colorRow.appendChild(color);
          grid.appendChild(colorRow);

          grid.appendChild(
            slider("Size", text.size, 2, 24, 0.5, function (value) {
              text.size = value;
              host.touchItem(item);
              host.save();
              playerInstance.projectChanged();
            }, function (value) {
              return Number(value).toFixed(1) + "%";
            }, settle)
          );
          grid.appendChild(
            slider("Across", text.x, 0, 100, 1, function (value) {
              text.x = value;
              host.touchItem(item);
              host.save();
              playerInstance.projectChanged();
            }, null, settle)
          );
          grid.appendChild(
            slider("Down", text.y, 0, 100, 1, function (value) {
              text.y = value;
              host.touchItem(item);
              host.save();
              playerInstance.projectChanged();
            }, null, settle)
          );

          var weightRow = row("Weight");
          weightRow.appendChild(
            chipPicker([[400, "Regular"], [700, "Bold"], [900, "Heavy"]], text.weight, function (value) {
              text.weight = value;
              commit({ skipRedraw: true });
            })
          );
          grid.appendChild(weightRow);

          var alignRow = row("Alignment");
          alignRow.appendChild(
            chipPicker([["left", "Left"], ["center", "Centre"], ["right", "Right"]], text.align, function (value) {
              text.align = value;
              commit({ skipRedraw: true });
            })
          );
          grid.appendChild(alignRow);

          var plateRow = row("Backing plate", "A box behind the text for readability");
          plateRow.appendChild(
            button(text.background ? "On" : "Off", "ve-chip" + (text.background ? " is-on" : ""), function (event) {
              text.background = !text.background;
              event.currentTarget.textContent = text.background ? "On" : "Off";
              event.currentTarget.classList.toggle("is-on", text.background);
              commit({ skipRedraw: true });
            })
          );
          var plateColor = document.createElement("input");
          plateColor.type = "color";
          plateColor.className = "ve-color";
          plateColor.value = text.backgroundColor;
          plateColor.oninput = function () {
            text.backgroundColor = plateColor.value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          };
          plateColor.onchange = settle;
          plateRow.appendChild(plateColor);
          grid.appendChild(plateRow);

          var shadowRow = row("Drop shadow");
          shadowRow.appendChild(
            button(text.shadow ? "On" : "Off", "ve-chip" + (text.shadow ? " is-on" : ""), function (event) {
              text.shadow = !text.shadow;
              event.currentTarget.textContent = text.shadow ? "On" : "Off";
              event.currentTarget.classList.toggle("is-on", text.shadow);
              commit({ skipRedraw: true });
            })
          );
          grid.appendChild(shadowRow);

          body.appendChild(grid);
        }
      });
    }

    /* --- the ratio sheet --- */

    function openRatioSheet() {
      openSheet({
        title: "Frame size",
        hint: "Everything re-frames live in the monitor",
        build: function (body, close) {
          var current = timeline.aspectOf(project);
          var grid = el("div", "ve-ratio-grid");
          timeline.ASPECTS.forEach(function (aspect) {
            var tile = el("button", "ve-ratio-tile" + (current && current.id === aspect.id ? " is-on" : ""));
            tile.type = "button";
            var box = el("span", "ve-ratio-box"),
              landscape = aspect.width >= aspect.height;
            box.style.width = (landscape ? 46 : Math.round(46 * (aspect.width / aspect.height))) + "px";
            box.style.height = (landscape ? Math.round(46 * (aspect.height / aspect.width)) : 46) + "px";
            tile.appendChild(box);
            tile.appendChild(el("b", null, aspect.label));
            tile.appendChild(el("small", null, aspect.hint));
            tile.onclick = function () {
              timeline.setAspect(project, aspect.id);
              previewResolution();
              commit();
              close();
              host.showToast("Frame set to " + aspect.label);
            };
            grid.appendChild(tile);
          });
          body.appendChild(grid);

          body.appendChild(
            slider("Frame rate", Math.max(24, Math.min(60, project.fps)), 24, 60, 1, function (value) {
              project.fps = Math.round(value);
              host.touchItem(item);
              host.save();
            }, function (value) {
              return Math.round(value) + " fps";
            }, settle)
          );
        }
      });
    }

    /* --- voiceover recording --- */

    var recorder = null,
      recorderTimer = null;

    function toggleVoiceover() {
      if (recorder) return stopVoiceover();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        return host.showToast("Voice recording is not supported in this browser", true);
      }
      playerInstance.pause();
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          var mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].filter(function (candidate) {
            return MediaRecorder.isTypeSupported(candidate);
          })[0];
          var instance = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream),
            chunks = [];
          recorder = { instance: instance, stream: stream, started: Date.now() };
          instance.ondataavailable = function (event) {
            if (event.data && event.data.size) chunks.push(event.data);
          };
          instance.onstop = function () {
            var seconds = Math.max(1, Math.round((Date.now() - recorder.started) / 1000));
            stream.getTracks().forEach(function (track) {
              track.stop();
            });
            clearInterval(recorderTimer);
            recorder = null;
            renderRail();
            saveVoiceover(new Blob(chunks, { type: instance.mimeType || mime || "audio/webm" }), seconds);
          };
          instance.start();
          recorderTimer = setInterval(renderRail, 500);
          renderRail();
        })
        .catch(function (error) {
          console.warn(error);
          host.showToast(error && error.name === "NotAllowedError" ? "Allow microphone access to record a voiceover" : "Could not start the microphone", true);
        });
    }

    function stopVoiceover() {
      if (!recorder) return;
      try {
        recorder.instance.stop();
      } catch (error) {
        console.warn(error);
      }
    }

    function saveVoiceover(blob, seconds) {
      if (!blob.size) return host.showToast("Nothing was recorded", true);
      var extension = /mp4/.test(blob.type) ? "m4a" : "webm",
        name = "Voiceover " + ((item.voiceovers || []).length + 1) + "." + extension,
        file;
      try {
        file = new File([blob], name, { type: blob.type });
      } catch (error) {
        file = blob;
      }
      media.addFiles(item, [file], { list: "voiceovers" }).then(function (added) {
        if (!added.length) return;
        var entry = added[0];
        if (!entry.duration) entry.duration = seconds;
        var track = firstTrackOfKind("audio") || timeline.addTrack(project, "audio");
        var clip = timeline.createMediaClip({ itemId: item.id, fileId: entry.id, duration: entry.duration });
        timeline.appendClip(project, track.id, clip);
        selectedClipId = clip.id;
        commit();
      });
    }

    /* --- collaboration ---

       The whole session lives in video/collab.js; this end of it keeps the
       banner in sync and merges what arrives. */

    var collabBar = el("div", "ve-collab-bar");
    collabBar.hidden = true;
    stage.insertBefore(collabBar, monitorWrap);
    var collabState = collab ? collab.state() : { active: false };

    function sessionActive() {
      return !!(item.collabId && collabState.active && collabState.sessionId === item.collabId);
    }

    function renderCollabBar() {
      if (!item.collabId || !collabState.active) {
        collabBar.hidden = true;
        return;
      }
      collabBar.hidden = false;
      collabBar.innerHTML = "";
      collabBar.className = "ve-collab-bar is-" + collabState.status;

      var dot = el("span", "ve-collab-dot");
      collabBar.appendChild(dot);

      var label = collabState.status === "live" ? "Live" : collabState.status === "connecting" ? "Connecting…" : collabState.status === "ended" ? "Session ended" : "Offline";
      collabBar.appendChild(el("b", null, label));

      var peers = collabState.peers || [];
      collabBar.appendChild(
        el("small", null, peers.length ? peers.length + " other editor" + (peers.length === 1 ? "" : "s") + " · " + peers.map(function (peer) {
          return peer.name;
        }).join(", ") : "Only you right now")
      );
      if (collabState.error) collabBar.appendChild(el("small", "ve-collab-error", collabState.error));
      collabBar.appendChild(
        button("Manage", "ve-btn ve-btn-small", function () {
          openShareSheet();
        })
      );
    }

    function attachSession() {
      if (!collab || !item.collabId || !collab.isAvailable()) return;
      collab.attach({
        sessionId: item.collabId,
        getProject: function () {
          return item.project;
        },
        getPlayhead: function () {
          return playerInstance.time();
        },
        applyProject: function (incoming) {
          if (destroyed || dragging) return;
          var next = timeline.normalize(incoming);
          if (JSON.stringify(next) === JSON.stringify(item.project)) return;
          item.project = next;
          project = item.project;
          baseline = JSON.stringify(item.project);
          if (selectedClipId && !timeline.findClip(project, selectedClipId)) selectedClipId = null;
          host.touchItem(item);
          host.persist();
          if (!sheetOpen()) afterProjectChange();
          else {
            playerInstance.projectChanged();
            renderTransport();
          }
        },
        applySources: function (map) {
          sharedSources = map || {};
          if (!dragging && !destroyed) renderTimeline();
        },
        onChange: function (state) {
          collabState = state;
          renderCollabBar();
        }
      });
      publishSessionSources();
    }

    function pushToSession() {
      if (collab && sessionActive()) collab.push();
    }

    /* Publishes a token-bearing URL for every source this device can actually
       reach, so the other editors can play the footage. Throttled, because it
       costs a read of the session document. */
    var sourcePublishTimer = null;
    function publishSessionSources() {
      if (!collab || !sessionActive()) return;
      clearTimeout(sourcePublishTimer);
      sourcePublishTimer = setTimeout(function () {
        var wanted = timeline.usedSources(project).filter(function (source) {
          var key = collab.sourceKey(source.itemId, source.fileId);
          if (sharedSources[key]) return false;
          return !!media.findSource(source.itemId, source.fileId);
        });
        if (!wanted.length) return;
        Promise.all(
          wanted.map(function (source) {
            var found = media.findSource(source.itemId, source.fileId);
            if (!found || !found.entry.storagePath) return null;
            return media
              .downloadUrl(found.entry)
              .then(function (url) {
                return {
                  key: collab.sourceKey(source.itemId, source.fileId),
                  value: {
                    url: url,
                    name: found.entry.name || "Clip",
                    kind: media.timelineKind(found.entry) || "video",
                    duration: found.entry.duration || 0,
                    poster: found.entry.poster || ""
                  }
                };
              })
              .catch(function () {
                return null;
              });
          })
        ).then(function (results) {
          var map = {};
          results.filter(Boolean).forEach(function (result) {
            map[result.key] = result.value;
          });
          if (Object.keys(map).length) collab.publishSources(map);
        });
      }, 1200);
    }

    function openShareSheet() {
      openSheet({
        title: "Collaborate",
        hint: "Edit this timeline together, live",
        build: function (body, close) {
          if (!collab || !collab.isAvailable()) {
            body.appendChild(el("div", "ve-empty", "Sign in to your account to share this edit."));
            return;
          }

          if (!item.collabId) {
            body.appendChild(
              el(
                "p",
                "ve-hint",
                "Starting a session puts this timeline in the cloud and gives you a link. Anyone signed in who opens it edits the same cut with you — cuts, text, colours and animations appear on every device as they happen."
              )
            );
            body.appendChild(
              el(
                "p",
                "ve-hint ve-hint-warn",
                "The footage used in this edit becomes viewable by anyone with the link, so they can actually see what they are cutting. Only share it with people you trust with the raw files."
              )
            );
            var start = button(I.users + "<span>Start a session</span>", "ve-btn ve-btn-primary", function () {
              start.disabled = true;
              start.innerHTML = "<span>Starting…</span>";
              collab
                .create(item, project, {})
                .then(function (sessionId) {
                  item.collabId = sessionId;
                  host.touchItem(item);
                  host.persist();
                  attachSession();
                  close();
                  copyInvite();
                  host.renderList();
                })
                .catch(function (error) {
                  console.warn("Could not start a session:", error);
                  start.disabled = false;
                  start.innerHTML = I.users + "<span>Start a session</span>";
                  host.showToast("Couldn't start the session. Check your Firestore rules.", true);
                });
            });
            body.appendChild(start);
            return;
          }

          var status = el("div", "ve-collab-status");
          status.appendChild(el("b", null, collabState.status === "live" ? "Live" : collabState.status === "connecting" ? "Connecting…" : collabState.status === "ended" ? "Ended" : "Offline"));
          var peers = collabState.peers || [];
          status.appendChild(
            el("small", null, peers.length ? "With " + peers.map(function (peer) {
              return peer.name;
            }).join(", ") : "Nobody else has joined yet")
          );
          body.appendChild(status);

          var linkRow = el("div", "ve-link-row");
          var linkText = el("code", "ve-link", collab.linkFor(item.collabId));
          linkRow.appendChild(linkText);
          body.appendChild(linkRow);

          var actions = el("div", "ve-sheet-actions");
          actions.appendChild(button(I.link + "<span>Copy link</span>", "ve-btn ve-btn-primary", copyInvite));
          if (navigator.share) {
            actions.appendChild(
              button(I.share + "<span>Share…</span>", "ve-btn", function () {
                navigator
                  .share({ title: item.title || "Edited video", url: collab.linkFor(item.collabId) })
                  .catch(function () {});
              })
            );
          }
          body.appendChild(actions);

          body.appendChild(
            el("p", "ve-hint", "Everyone works on the same timeline. If two people change the same clip at the same moment, the later change wins.")
          );

          var stop = button("Stop collaborating", "ve-btn ve-btn-danger", function () {
            confirmSheet("Stop collaborating", "Everyone else loses access to this timeline. Your own copy stays exactly as it is.", "Stop", function () {
              var sessionId = item.collabId;
              collab
                .end(sessionId)
                .catch(function (error) {
                  console.warn("Could not end the session cleanly:", error);
                })
                .then(function () {
                  delete item.collabId;
                  sharedSources = {};
                  collabState = collab.state();
                  host.touchItem(item);
                  host.persist();
                  renderCollabBar();
                  renderRail();
                  host.showToast("Collaboration stopped");
                });
              close();
            });
          });
          body.appendChild(stop);
        }
      });
    }

    function copyInvite() {
      var url = collab.linkFor(item.collabId);
      if (host.copyText) host.copyText(url, function () {
        host.showToast("Collaboration link copied");
      });
      else host.showToast(url);
    }

    /* --- export --- */

    function openExportSheet() {
      var total = timeline.duration(project);
      if (total <= 0) return host.showToast("Add a clip to the timeline first", true);
      if (!ns.player.canExport()) return host.showToast("This browser cannot record video", true);

      openSheet({
        title: "Export",
        hint: timeline.formatTime(total) + " · " + project.width + "×" + project.height,
        build: function (body, close) {
          var ratio = project.height / project.width;
          var sizes = [
            { label: "720p", width: 1280 },
            { label: "1080p", width: 1920 },
            { label: "Project size", width: project.width }
          ];
          var chosen = sizes[1];

          body.appendChild(
            el(
              "p",
              "ve-hint",
              "There is no render server, so the export is a real-time recording of the preview. It takes about as long as the video itself, and this tab has to stay in front the whole time. The finished file is saved to your account and downloaded here."
            )
          );

          var sizeField = row("Resolution");
          sizeField.appendChild(
            chipPicker(
              sizes.map(function (size) {
                return [size.label, size.label];
              }),
              chosen.label,
              function (value) {
                chosen = sizes.filter(function (size) {
                  return size.label === value;
                })[0];
              }
            )
          );
          body.appendChild(sizeField);

          var status = el("p", "ve-hint", "");
          var bar = el("div", "ve-progress");
          var fill = el("div", "ve-progress-fill");
          bar.appendChild(fill);
          bar.hidden = true;
          body.appendChild(bar);
          body.appendChild(status);

          var start = button(I.download + "<span>Start export</span>", "ve-btn ve-btn-primary", function () {
            start.disabled = true;
            bar.hidden = false;
            exportRunning = true;
            closeSelection();
            status.textContent = "Loading every clip…";
            var width = Math.round(chosen.width),
              height = Math.round(width * ratio);
            /* Recorders want even dimensions. */
            if (height % 2) height += 1;
            if (width % 2) width += 1;

            playerInstance
              .exportVideo({
                width: width,
                height: height,
                fps: project.fps,
                onProgress: function (fraction) {
                  fill.style.width = Math.round(fraction * 100) + "%";
                  status.textContent = "Recording " + Math.round(fraction * 100) + "% — " + timeline.formatTime(total * (1 - fraction)) + " to go";
                }
              })
              .then(function (result) {
                exportRunning = false;
                status.textContent = "Saving to your account…";
                return saveRender(result);
              })
              .then(function () {
                close();
                openRendersSheet();
              })
              .catch(function (error) {
                exportRunning = false;
                console.warn("Export failed:", error);
                status.textContent = (error && error.message) || "Export failed";
                start.disabled = false;
              });
          });
          body.appendChild(start);

          if ((item.renders || []).length) {
            body.appendChild(
              button(I.film + "<span>Past exports (" + item.renders.length + ")</span>", "ve-btn", function () {
                openRendersSheet();
              })
            );
          }
        }
      });
    }

    function closeSelection() {
      if (!selectedClipId) return;
      selectedClipId = null;
      markSelection();
      renderRail();
    }

    function openRendersSheet() {
      openSheet({
        title: "Exports",
        build: function (body) {
          function draw() {
            body.innerHTML = "";
            if (!(item.renders || []).length) {
              body.appendChild(el("div", "ve-empty", "No exports yet."));
              return;
            }
            item.renders
              .slice()
              .sort(function (a, b) {
                return (b.added || 0) - (a.added || 0);
              })
              .forEach(function (entry) {
                body.appendChild(buildFileCard(item, entry, "renders", draw));
              });
          }
          draw();
        }
      });
    }

    function saveRender(result) {
      var stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-"),
        base = (item.title || "Edited video").replace(/[\\/:*?"<>|]/g, "-"),
        name = base + " " + stamp + "." + result.extension,
        file;
      try {
        file = new File([result.blob], name, { type: result.mime });
      } catch (error) {
        file = result.blob;
      }
      /* Hand the user the file straight away — the upload continues behind it. */
      var url = URL.createObjectURL(result.blob),
        link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 60000);

      return media.addFiles(item, [file], { list: "renders", kind: "render", accept: "any" }).then(function () {
        host.showToast("Export finished — " + host.fileSize(result.blob.size));
        host.renderList();
      });
    }

    /* --- missing footage --- */

    function renderProblems() {
      var missing = 0;
      project.tracks.forEach(function (track) {
        track.clips.forEach(function (clip) {
          if (clip.sourceItemId && !hasSource(clip)) missing++;
        });
      });
      if (!missing) {
        if (problem.dataset.kind === "missing") clearProblem();
        return;
      }
      if (problem.dataset.kind === "playback" && !problem.hidden) return;
      problem.hidden = false;
      problem.dataset.kind = "missing";
      problem.innerHTML = "";
      problem.appendChild(el("b", null, missing + " clip" + (missing === 1 ? "" : "s") + " point at files that are gone"));
      problem.appendChild(
        button("Remove them", "ve-btn ve-btn-small ve-btn-danger", function () {
          timeline.pruneMissingSources(project, hasSource);
          selectedClipId = null;
          commit();
        })
      );
    }

    /* --- keyboard --- */

    function onKeyDown(event) {
      if (!activeView || activeView.itemId !== item.id) return;
      var target = event.target;
      if (target && target.closest && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (exportRunning) return;
      if (sheetOpen() || document.querySelector(".modal.open")) return;

      var meta = event.ctrlKey || event.metaKey;
      if (meta && !event.altKey) {
        var key = (event.key || "").toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          undo();
        } else if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          redo();
        } else if (key === "d" && selectedClipId) {
          event.preventDefault();
          var copy = timeline.duplicateClip(project, selectedClipId);
          if (copy) {
            selectedClipId = copy.id;
            commit();
          }
        }
        /* Every other browser and app shortcut stays untouched. */
        return;
      }
      if (event.altKey) return;

      if (event.code === "Space") {
        event.preventDefault();
        playerInstance.toggle();
        renderTransport();
      } else if (event.key === "s" || event.key === "S") {
        if (timeline.splitAt(project, playerInstance.time())) commit();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedClipId) {
        event.preventDefault();
        timeline.removeClip(project, selectedClipId);
        selectedClipId = null;
        commit();
      } else if (event.key === "Escape" && selectedClipId) {
        closeSelection();
      } else if (event.key === "ArrowLeft") {
        playerInstance.seek(playerInstance.time() - (event.shiftKey ? 1 : 1 / project.fps));
        syncScroll(true);
      } else if (event.key === "ArrowRight") {
        playerInstance.seek(playerInstance.time() + (event.shiftKey ? 1 : 1 / project.fps));
        syncScroll(true);
      } else if (event.key === "Home") {
        event.preventDefault();
        playerInstance.seek(0);
        syncScroll(true);
      } else if (event.key === "End") {
        event.preventDefault();
        playerInstance.seek(timeline.duration(project));
        syncScroll(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);

    var stopWatchingUploads = media.onUploadChange(function () {
      if (!dragging && !destroyed) renderProblems();
    });

    /* Every measurement in this view depends on how wide it actually is: the
       monitor, the lead padding that puts time zero under the needle, and the
       needle itself. Watching the element rather than the window means it also
       survives the sidebar opening, a keyboard appearing, and rotating a phone
       — which is exactly where a fixed-playhead timeline would otherwise drift. */
    var resizeFrame = null;
    function relayout() {
      resizeFrame = null;
      if (destroyed || dragging || !root.isConnected) return;
      sizeMonitor();
      renderTimeline();
      syncScroll(true);
    }
    function onResize() {
      if (destroyed || dragging || resizeFrame) return;
      resizeFrame = requestAnimationFrame(relayout);
    }
    /* A tab that is not being painted never runs requestAnimationFrame, so the
       first layout also goes out on a timer. Without that, a PWA restored from
       the background could come back with an unsized monitor. */
    function onVisible() {
      if (document.visibilityState === "visible") relayout();
    }
    document.addEventListener("visibilitychange", onVisible);
    var sizeWatcher = null;
    if (window.ResizeObserver) {
      sizeWatcher = new ResizeObserver(onResize);
      sizeWatcher.observe(root);
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    var view = {
      itemId: item.id,
      root: root,
      player: playerInstance,
      shareLabel: function () {
        return item.collabId ? "Collaborating" : "Share";
      },
      share: function () {
        openShareSheet();
      },
      sync: function () {
        ensureEditItem(item);
        project = item.project;
        baseline = JSON.stringify(item.project);
        if (!dragging) {
          sizeMonitor();
          renderTimeline();
          renderRail();
          renderProblems();
        }
        renderTransport();
        renderCollabBar();
      },
      destroy: function () {
        destroyed = true;
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
        if (sizeWatcher) sizeWatcher.disconnect();
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        clearTimeout(firstLayoutTimer);
        stopWatchingUploads();
        clearInterval(recorderTimer);
        clearTimeout(sourcePublishTimer);
        if (recorder) stopVoiceover();
        if (collab && sessionActive()) collab.detach();
        closeAllSheets();
        playerInstance.destroy();
      }
    };

    renderTransport();
    renderTimeline();
    renderRail();
    renderProblems();
    attachSession();
    renderCollabBar();

    /* The surface width and the monitor size both depend on measurements that
       are only real once the view is in the document. */
    requestAnimationFrame(relayout);
    var firstLayoutTimer = setTimeout(relayout, 0);

    return view;
  }

  /* =====================================================================
     Opening a collaboration invite
     ===================================================================== */

  /* index.html calls this when the app is opened with ?edit=<sessionId>. */
  ns.openInvite = function (sessionId) {
    if (!host || !collab || !sessionId) return Promise.resolve(false);
    var existing = host.items().filter(function (candidate) {
      return candidate.type === "edit" && candidate.collabId === sessionId;
    })[0];
    if (existing) {
      host.openItem(existing.id);
      host.showToast("Back in the shared edit");
      return Promise.resolve(true);
    }
    if (!collab.isAvailable()) {
      host.showToast("Sign in to open this collaboration link", true);
      return Promise.resolve(false);
    }
    return collab
      .peek(sessionId)
      .then(function (snapshot) {
        var item = newEditItem();
        item.title = snapshot.title || "Shared edit";
        item.collabId = sessionId;
        item.project = timeline.normalize(snapshot.project || timeline.createProject());
        host.createItem(item);
        host.showToast("Joined " + (snapshot.ownerName || "a") + "'s edit");
        return true;
      })
      .catch(function (error) {
        console.warn("Could not open the invite:", error);
        host.showToast((error && error.message) || "That collaboration link did not open", true);
        return false;
      });
  };

  /* =====================================================================
     Registration with the core app
     ===================================================================== */

  function useView(builder, item) {
    if (activeView) {
      activeView.destroy();
      activeView = null;
    }
    activeView = builder(item);
    return activeView.root;
  }

  function tearDown() {
    if (activeView) {
      activeView.destroy();
      activeView = null;
    }
  }

  /* Called by the core when the device's local copy is wiped on sign-out, so
     blob URLs pointing at deleted IndexedDB files are not left behind. */
  function reset() {
    tearDown();
    media.releaseAll();
    if (collab) collab.detach();
  }

  function bucketMeta(list, emptyLabel) {
    return function (item) {
      var entries = item[list] || [];
      if (!entries.length) return emptyLabel;
      var total = entries.reduce(function (sum, entry) {
        return sum + (entry.duration || 0);
      }, 0);
      var bytes = entries.reduce(function (sum, entry) {
        return sum + (entry.size || 0);
      }, 0);
      return entries.length + " file" + (entries.length === 1 ? "" : "s") + (total ? " · " + timeline.formatTime(total) : bytes ? " · " + host.fileSize(bytes) : "");
    };
  }

  function bucketText(list) {
    return function (item) {
      return (item[list] || [])
        .map(function (entry) {
          return entry.name || "";
        })
        .join(" ");
    };
  }

  ns.install = function (bridge) {
    host = bridge;
    media.install(bridge);
    if (collab) collab.install(bridge);

    return [
      {
        type: "video",
        label: "Video",
        menuLabel: "Video",
        manageLabel: "Video",
        manageHint: "Upload footage, B-roll and stills that sync to every device",
        defaultEnabled: false,
        icon: ICON_VIDEO,
        placeholder: "Untitled footage",
        hideCopy: true,
        ownsFiles: true,
        create: function () {
          return media.newVideoItem();
        },
        normalize: media.ensureVideoItem,
        files: function (item) {
          return item.clips || [];
        },
        text: bucketText("clips"),
        meta: bucketMeta("clips", "No footage"),
        hasContent: function (item) {
          return !!(item.clips || []).length;
        },
        build: function (item) {
          return useView(buildVideoView, item);
        },
        refresh: function (item) {
          if (activeView && activeView.itemId === item.id) activeView.sync();
        },
        detach: tearDown,
        reset: reset
      },
      {
        type: "file",
        label: "File",
        menuLabel: "File",
        manageLabel: "File",
        manageHint: "Any file at all, synced to your account and reachable everywhere",
        defaultEnabled: true,
        icon: ICON_FILE,
        placeholder: "Untitled files",
        hideCopy: true,
        ownsFiles: true,
        create: function () {
          return media.newFileItem();
        },
        normalize: media.ensureFileItem,
        files: function (item) {
          return item.files || [];
        },
        text: bucketText("files"),
        meta: bucketMeta("files", "No files"),
        hasContent: function (item) {
          return !!(item.files || []).length;
        },
        build: function (item) {
          return useView(buildFileItemView, item);
        },
        refresh: function (item) {
          if (activeView && activeView.itemId === item.id) activeView.sync();
        },
        detach: tearDown,
        reset: reset
      },
      {
        type: "edit",
        label: "Edited Video",
        menuLabel: "Edited Video",
        manageLabel: "Edited Video",
        manageHint: "A CapCut-style timeline with its own media, animations and live collaboration",
        defaultEnabled: false,
        icon: ICON_EDIT_VIDEO,
        placeholder: "Untitled edit",
        hideCopy: true,
        ownsFiles: true,
        create: newEditItem,
        normalize: ensureEditItem,
        /* Only the files this item actually owns. Timeline clips can also point
           at footage owned by other items — reporting those here would let
           deleting an edit delete someone else's source footage. */
        files: function (item) {
          return (item.pool || []).concat(item.voiceovers || []).concat(item.renders || []);
        },
        text: function (item) {
          var words = [];
          (((item.project || {}).tracks) || []).forEach(function (track) {
            track.clips.forEach(function (clip) {
              if (clip.text && clip.text.value) words.push(clip.text.value);
            });
          });
          return words.join(" ");
        },
        meta: function (item) {
          var project = item.project;
          if (!project) return "Empty edit";
          var count = timeline.clipCount(project),
            total = timeline.duration(project),
            live = item.collabId ? " · shared" : "";
          return (count ? count + " clip" + (count === 1 ? "" : "s") + " · " + timeline.formatTime(total) : "Empty timeline") + live;
        },
        hasContent: function (item) {
          return timeline.clipCount(item.project || { tracks: [] }) > 0;
        },
        build: function (item) {
          return useView(buildEditView, item);
        },
        refresh: function (item) {
          if (activeView && activeView.itemId === item.id) activeView.sync();
        },
        /* The core's Share button hands off to the open editor. */
        shareLabel: function (item) {
          return item.collabId ? "Collaborating" : "Share";
        },
        share: function (item) {
          if (activeView && activeView.itemId === item.id && activeView.share) activeView.share();
        },
        detach: tearDown,
        reset: reset
      }
    ];
  };
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
