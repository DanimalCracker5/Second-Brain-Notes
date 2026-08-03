/*
  Second Brain — video/editor.js

  The user interface for the two item types this feature adds, and the place
  where they are registered with the core app.

    "video"  — Footage. Holds uploaded video and audio files. Put these in
               folders like B-Roll or Footage. Nothing is edited here; it is the
               library the timeline pulls from.

    "edit"   — Edited Video. A timeline that references files from any Video or
               Audio item in the account, plus voiceovers recorded into it.
               Usually lives in a different folder from the footage.

  This file owns DOM and event handling only. The editing rules live in
  video/timeline.js, files live in video/media.js, and playback and export live
  in video/player.js. If you are adding a feature, start by asking which of
  those four it belongs to.

  Loaded last of the four scripts, so it also defines SecondBrainVideo.install(),
  which index.html calls once at boot. See video/README.md.
*/
(function (ns) {
  "use strict";

  var timeline = ns.timeline;
  var media = ns.media;

  var host = null;

  /* Only one editor is on screen at a time — the core renders a single item. */
  var activeView = null;

  /* Zoom is a viewing preference, not content, so it is kept per session rather
     than synced into the item. */
  var zoomByItem = {};
  var DEFAULT_ZOOM = 60; // pixels per second
  var MIN_ZOOM = 4;
  var MAX_ZOOM = 400;

  /* How many timeline states the undo history keeps per open edit. */
  var HISTORY_LIMIT = 80;

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
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    skipStart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h2.2v14H7z"/><path d="M19 5.5v13L9.8 12z"/></svg>',
    undo: stroked('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 2),
    redo: stroked('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>', 2),
    scissors: stroked('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.1 7.6 20 19M8.1 16.4 20 5"/>'),
    zoomIn: stroked('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5M8 11h6M11 8v6"/>', 2),
    zoomOut: stroked('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5M8 11h6"/>', 2),
    fit: stroked('<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>', 2),
    download: stroked('<path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>', 2),
    plus: stroked('<path d="M12 5v14M5 12h14"/>', 2.2),
    film: stroked('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M8 4.5v15M16 4.5v15M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5"/>', 1.6),
    text: stroked('<path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6"/>', 2),
    mic: stroked('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>'),
    layers: stroked('<path d="m12 3.5 8.5 4.7L12 12.9 3.5 8.2z"/><path d="m3.5 13 8.5 4.7 8.5-4.7"/>'),
    wave: stroked('<path d="M4 10v4M8 7.5v9M12 4.5v15M16 7.5v9M20 10v4"/>', 2),
    volume: stroked('<path d="M11 5.5 6.8 9H4v6h2.8L11 18.5z"/><path d="M14.5 9.5a3.6 3.6 0 0 1 0 5M17 7a7 7 0 0 1 0 10"/>'),
    volumeOff: stroked('<path d="M11 5.5 6.8 9H4v6h2.8L11 18.5z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>'),
    eye: stroked('<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/>', 1.6),
    eyeOff: stroked('<path d="m4 4.5 16 15M9.8 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.8 3.5M6.6 7.7C4 9.5 2.5 12 2.5 12S6 18 12 18a9 9 0 0 0 4.3-1.1"/>', 1.6),
    trash: stroked('<path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6"/>', 1.6),
    copy: stroked('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 14.5V6a2 2 0 0 1 2-2h8.5"/>', 1.8)
  };

  var ICON_VIDEO = I.film;
  var ICON_EDIT_VIDEO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v14"/><path d="m12 12 4 2-4 2z"/></svg>';

  var TRACK_ICONS = { video: I.film, audio: I.wave, text: I.text };

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
    wrap.appendChild(el("span", "ve-field-label", labelText));
    if (hint) wrap.appendChild(el("small", "ve-field-hint", hint));
    return wrap;
  }

  /* True while the user is interacting with a control, so background refreshes
     (upload progress, autosave) do not yank it away mid-adjustment. */
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

  function posterNode(entry, className) {
    if (entry && entry.poster) {
      var image = el("img", className || "ve-poster");
      image.src = entry.poster;
      image.alt = "";
      image.loading = "lazy";
      return image;
    }
    var placeholder = el("div", (className || "ve-poster") + " ve-poster-empty");
    placeholder.innerHTML = media.isAudioEntry(entry || {}) ? I.wave : ICON_VIDEO;
    return placeholder;
  }

  /* Full-screen overlay used for the media picker and the export dialog. */
  function openOverlay(title, buildBody) {
    var scrim = el("div", "ve-modal"),
      box = el("div", "ve-modal-box"),
      head = el("div", "ve-modal-head");
    head.appendChild(el("h3", null, title));
    head.appendChild(
      button("✕", "ve-modal-close", function () {
        close();
      }, "Close")
    );
    box.appendChild(head);
    var body = el("div", "ve-modal-body");
    box.appendChild(body);
    scrim.appendChild(box);
    scrim.onclick = function (event) {
      if (event.target === scrim) close();
    };
    document.body.appendChild(scrim);

    function close() {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKey, true);

    buildBody(body, close);
    return { close: close, body: body };
  }

  /* =====================================================================
     Footage editor — the "video" item type
     ===================================================================== */

  function buildVideoView(item) {
    var root = el("section", "ve-video");
    root.setAttribute("data-item-editor", item.id);

    var intro = el("div", "ve-intro");
    intro.appendChild(el("p", "ve-hint", "Upload screen recordings, B-roll, or any footage. Files go straight to your account so every signed-in device can edit with them."));
    root.appendChild(intro);

    /* --- import controls --- */
    var picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "video/*,audio/*";
    picker.multiple = true;
    picker.hidden = true;
    picker.onchange = function () {
      if (picker.files && picker.files.length) media.addFiles(item, picker.files);
      picker.value = "";
    };
    root.appendChild(picker);

    var drop = el("div", "ve-drop");
    drop.innerHTML = '<div class="ve-drop-icon">' + ICON_VIDEO + "</div>";
    drop.appendChild(el("b", null, "Add footage"));
    drop.appendChild(el("small", null, "Drop files here, or tap to choose. Up to 2 GB per file."));
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
      if (event.dataTransfer && event.dataTransfer.files.length) media.addFiles(item, event.dataTransfer.files);
    });
    root.appendChild(drop);

    var listWrap = el("div", "ve-clip-grid");
    root.appendChild(listWrap);

    function sync() {
      if (isEditingControl(listWrap)) return; // someone is renaming a clip
      listWrap.innerHTML = "";
      var clips = item.clips || [];
      if (!clips.length) {
        listWrap.appendChild(el("div", "ve-empty", "No footage yet. Add a file above and it will appear here and in every edit's media library."));
        return;
      }
      clips.forEach(function (entry) {
        listWrap.appendChild(buildClipCard(item, entry, sync));
      });
    }

    sync();
    var stopWatching = media.onUploadChange(sync);
    return { itemId: item.id, root: root, sync: sync, destroy: stopWatching };
  }

  function buildClipCard(item, entry, sync) {
    var card = el("article", "ve-clip-card");
    card.appendChild(posterNode(entry));

    var body = el("div", "ve-clip-body");
    var name = document.createElement("input");
    name.className = "ve-clip-name";
    name.value = entry.name || "";
    name.setAttribute("aria-label", "File name");
    name.oninput = function () {
      entry.name = name.value;
      host.touchItem(item);
      host.save();
    };
    body.appendChild(name);
    body.appendChild(el("small", "ve-clip-summary", media.entrySummary(item, entry)));

    var upload = media.uploadState(item, entry);
    if (upload) {
      var bar = el("div", "ve-progress");
      var fill = el("div", "ve-progress-fill");
      fill.style.width = Math.round(upload.progress * 100) + "%";
      bar.appendChild(fill);
      body.appendChild(bar);
    }
    card.appendChild(body);

    var actions = el("div", "ve-clip-actions");
    actions.appendChild(
      button("Preview", "ve-btn", function () {
        previewEntry(item, entry);
      })
    );
    if (entry.storagePath && !entry.cached && (entry.size || 0) <= media.CACHE_LIMIT_BYTES) {
      actions.appendChild(
        button("Cache here", "ve-btn", function (event) {
          var node = event.currentTarget;
          node.disabled = true;
          node.textContent = "Caching…";
          media
            .downloadToCache(item, entry, function (fraction) {
              node.textContent = "Caching " + Math.round(fraction * 100) + "%";
            })
            .then(function () {
              host.showToast("Cached on this device");
              sync();
            })
            .catch(function (error) {
              console.warn(error);
              node.disabled = false;
              node.textContent = "Cache here";
              host.showToast(error.corsLikely ? "Blocked by Cloud Storage CORS — see video/README.md" : "Could not cache this file", true);
            });
        }, "Copy this file onto this device for smoother editing")
      );
    }
    if (entry.cloudError) {
      actions.appendChild(
        button("Retry upload", "ve-btn", function () {
          media.retryUpload(item, entry);
        })
      );
    }
    actions.appendChild(
      button("Remove", "ve-btn ve-btn-danger", function () {
        if (!confirm("Remove " + (entry.name || "this file") + "? Any edit using it will show the clip as missing.")) return;
        media.removeEntry(item, entry, "clips");
        host.renderList();
        sync();
        host.showToast("File removed");
      })
    );
    card.appendChild(actions);
    return card;
  }

  function previewEntry(ownerItem, entry) {
    openOverlay(entry.name || "Preview", function (body) {
      var note = el("p", "ve-hint", "Loading…");
      body.appendChild(note);
      var element = document.createElement(media.isAudioEntry(entry) ? "audio" : "video");
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
          note.textContent = error && error.message ? error.message : "This file is not available here.";
        });
    });
  }

  /* =====================================================================
     Timeline editor — the "edit" item type
     ===================================================================== */

  function newEditItem() {
    var item = host.baseItem();
    item.type = "edit";
    item.title = "";
    item.project = timeline.createProject();
    item.voiceovers = [];
    item.renders = [];
    return item;
  }

  function ensureEditItem(item) {
    item.project = timeline.normalize(item.project);
    item.voiceovers = Array.isArray(item.voiceovers) ? item.voiceovers : [];
    item.renders = Array.isArray(item.renders) ? item.renders : [];
    item.voiceovers.forEach(media.ensureFileEntry);
    item.renders.forEach(function (entry) {
      media.ensureFileEntry(entry);
      entry.kind = "render";
    });
  }

  function buildEditView(item) {
    ensureEditItem(item);

    var project = item.project,
      selectedClipId = null,
      activeTrackId = null,
      dragging = false,
      exportRunning = false;

    var root = el("section", "ve-edit");
    root.setAttribute("data-item-editor", item.id);
    root.tabIndex = -1;

    /* --- undo history ---

       The whole timeline is a small JSON document, so history is just a stack
       of serialized snapshots. `baseline` always holds the state as of the last
       recorded step; commit() compares against it and pushes the difference. */

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
      try {
        item.project = JSON.parse(json);
      } catch (error) {
        return;
      }
      ensureEditItem(item);
      project = item.project;
      baseline = JSON.stringify(item.project);
      if (selectedClipId && !timeline.findClip(project, selectedClipId)) selectedClipId = null;
      host.touchItem(item);
      host.persist();
      problem.hidden = true;
      playerInstance.clearErrors();
      playerInstance.projectChanged();
      renderTimeline();
      renderInspector();
      renderTransport();
    }

    /* --- committing a change --- */

    function commit(options) {
      options = options || {};
      markHistory();
      host.touchItem(item);
      host.persist();
      /* Give a failed clip another chance to report itself — the edit may have
         been the fix (a clip removed, a source re-cached). */
      problem.hidden = true;
      playerInstance.clearErrors();
      playerInstance.projectChanged();
      if (!options.skipRedraw) {
        renderTimeline();
        renderInspector();
      }
      renderTransport();
    }

    /* --- monitor --- */

    var stage = el("div", "ve-stage");
    var monitor = el("div", "ve-monitor");
    stage.appendChild(monitor);

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
        problem.hidden = false;
        problem.textContent = message;
      }
    });
    monitor.appendChild(playerInstance.canvas);

    var monitorOverlay = el("div", "ve-monitor-overlay");
    monitorOverlay.innerHTML = I.play;
    monitor.appendChild(monitorOverlay);

    monitor.onclick = function () {
      playerInstance.toggle();
      renderTransport();
    };
    /* Preview at a size that a phone can composite comfortably; export uses the
       project resolution. */
    playerInstance.setResolution(Math.min(project.width, 960), Math.round(Math.min(project.width, 960) * (project.height / project.width)));

    /* --- zoom --- */

    function zoom() {
      return zoomByItem[item.id] || DEFAULT_ZOOM;
    }

    function clampZoom(value) {
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    }

    /* Zooms while keeping the time under `clientX` fixed on screen, so the
       timeline grows around the point being looked at instead of drifting. */
    function zoomAround(factor, clientX) {
      if (dragging) return;
      var previous = zoom(),
        next = clampZoom(previous * factor);
      if (Math.abs(next - previous) < 0.001) return;
      var anchor = Math.max(0, (clientX - ruler.getBoundingClientRect().left) / previous);
      zoomByItem[item.id] = next;
      renderTimeline();
      var offset = clientX - scroller.getBoundingClientRect().left - headWidth;
      scroller.scrollLeft = Math.max(0, anchor * next - offset);
    }

    function zoomStep(factor) {
      var rect = scroller.getBoundingClientRect();
      zoomAround(factor, rect.left + headWidth + (rect.width - headWidth) / 2);
    }

    function zoomToFit() {
      if (dragging) return;
      var total = timeline.duration(project);
      if (total <= 0) return;
      var available = scroller.clientWidth - headWidth - 28;
      if (available < 60) return;
      zoomByItem[item.id] = clampZoom(available / total);
      renderTimeline();
      scroller.scrollLeft = 0;
    }

    /* --- source resolution --- */

    function resolveClip(clip) {
      var source = media.findSource(clip.sourceItemId, clip.sourceFileId);
      if (!source) return Promise.reject(new Error("A clip's source file is no longer in your account."));
      return media.resolveEntry(source.item, source.entry);
    }

    /* --- timeline surface --- */

    var timelineWrap = el("div", "ve-timeline");
    var ruler = el("div", "ve-ruler");
    var lanes = el("div", "ve-lanes");
    var playheadNode = el("div", "ve-playhead");
    var guideNode = el("div", "ve-snap-guide");
    guideNode.hidden = true;
    var cornerNode = el("div", "ve-corner");
    var scroller = el("div", "ve-scroller");
    var surface = el("div", "ve-surface");
    surface.appendChild(ruler);
    surface.appendChild(lanes);
    surface.appendChild(guideNode);
    surface.appendChild(playheadNode);
    surface.appendChild(cornerNode);
    scroller.appendChild(surface);
    timelineWrap.appendChild(scroller);

    var emptyState = el("div", "ve-timeline-empty");
    emptyState.hidden = true;
    emptyState.appendChild(el("b", null, "This edit is empty"));
    emptyState.appendChild(el("small", null, "Pull footage from your account to start cutting."));
    emptyState.appendChild(
      button(I.plus + "<span>Add media</span>", "ve-btn ve-btn-primary", function () {
        openMediaPicker();
      })
    );
    timelineWrap.appendChild(emptyState);
    root.appendChild(timelineWrap);

    var trackControls = el("div", "ve-track-actions");
    root.appendChild(trackControls);

    /* Track headers are emulated-sticky: they sit in the surface's left padding
       and are pushed along by the scroll offset, so they never leave view. */
    var headWidth = 118;
    scroller.addEventListener(
      "scroll",
      function () {
        surface.style.setProperty("--scroll-x", scroller.scrollLeft + "px");
      },
      { passive: true }
    );

    /* Ctrl+wheel (or pinch on a trackpad) zooms around the cursor. */
    timelineWrap.addEventListener(
      "wheel",
      function (event) {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        zoomAround(event.deltaY < 0 ? 1.25 : 0.8, event.clientX);
      },
      { passive: false }
    );

    /* --- transport --- */

    var playBtn, timeNow, timeTotal, undoBtn, redoBtn, lastPlaying = false;

    (function buildTransport() {
      var main = el("div", "ve-transport-main");
      main.appendChild(
        button(I.skipStart, "ve-tbtn", function () {
          playerInstance.pause();
          playerInstance.seek(0);
          scroller.scrollLeft = 0;
          renderTransport();
        }, "Back to start (Home)")
      );
      playBtn = button(I.play, "ve-play", function () {
        playerInstance.toggle();
        renderTransport();
      }, "Play");
      main.appendChild(playBtn);
      var time = el("div", "ve-time");
      timeNow = el("span", "ve-time-now", "0:00.00");
      timeTotal = el("span", "ve-time-total", "0:00");
      time.appendChild(timeNow);
      time.appendChild(el("span", "ve-time-sep", "/"));
      time.appendChild(timeTotal);
      main.appendChild(time);
      transport.appendChild(main);

      var tools = el("div", "ve-transport-tools");
      undoBtn = button(I.undo, "ve-tbtn", undo, "Undo (Ctrl+Z)");
      redoBtn = button(I.redo, "ve-tbtn", redo, "Redo (Ctrl+Shift+Z)");
      tools.appendChild(undoBtn);
      tools.appendChild(redoBtn);
      tools.appendChild(el("span", "ve-tsep"));
      tools.appendChild(
        button(I.scissors + "<span>Split</span>", "ve-tbtn", function () {
          var cuts = timeline.splitAt(project, playerInstance.time());
          if (!cuts) return host.showToast("Move the playhead over a clip to split it", true);
          commit();
          host.showToast(cuts + " clip" + (cuts === 1 ? "" : "s") + " split");
        }, "Split every clip under the playhead (S)")
      );
      tools.appendChild(el("span", "ve-tsep"));
      tools.appendChild(
        button(I.zoomOut, "ve-tbtn", function () {
          zoomStep(1 / 1.5);
        }, "Zoom out")
      );
      tools.appendChild(button(I.fit, "ve-tbtn", zoomToFit, "Fit the whole edit on screen"));
      tools.appendChild(
        button(I.zoomIn, "ve-tbtn", function () {
          zoomStep(1.5);
        }, "Zoom in")
      );
      tools.appendChild(el("span", "ve-tsep"));
      tools.appendChild(
        button(I.download + "<span>Export</span>", "ve-btn ve-btn-primary ve-export", function () {
          openExportDialog();
        }, "Render this cut to a video file")
      );
      transport.appendChild(tools);
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

    /* Keeps the playhead on screen while playing, parked about a third of the
       way in so upcoming clips are visible. */
    function ensurePlayheadVisible() {
      var px = playerInstance.time() * zoom(),
        view = scroller.clientWidth - headWidth;
      if (view <= 40) return;
      var left = scroller.scrollLeft;
      if (px < left + 4) scroller.scrollLeft = Math.max(0, px - view * 0.3);
      else if (px > left + view - 16) scroller.scrollLeft = Math.max(0, px - view * 0.3);
    }

    function updatePlayhead(time) {
      if (timeNow) timeNow.textContent = timeline.formatTime(time, true, project.fps);
      if (playheadNode) playheadNode.style.transform = "translateX(" + time * zoom() + "px)";
      var playing = playerInstance.isPlaying();
      if (playing && !dragging) ensurePlayheadVisible();
      if (playing !== lastPlaying) renderTransport();
    }

    /* --- rendering the timeline ---

       Rebuilds the whole thing. Cheap at this scale and it keeps the DOM a
       plain function of the project, which is much easier to reason about than
       incremental patching. Never called while a drag is in flight. */

    function renderTimeline() {
      if (dragging) return;
      headWidth = parseFloat(getComputedStyle(surface).paddingLeft) || 118;
      var total = timeline.duration(project),
        pxPerSecond = zoom(),
        width = Math.max(total * pxPerSecond + 240, scroller.clientWidth - headWidth || 320);
      surface.style.width = width + "px";

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
        minorPx >= 12 ? "repeating-linear-gradient(90deg, var(--line-soft) 0 1px, transparent 1px " + minorPx + "px)" : "none";
      lanes.style.backgroundImage = "repeating-linear-gradient(90deg, var(--line-soft) 0 1px, transparent 1px " + step * pxPerSecond + "px)";

      /* --- tracks --- */
      lanes.innerHTML = "";
      /* Displayed top-down as audio, text, then video, so the video lanes sit
         nearest the timeline floor like every other editor. */
      var ordered = project.tracks
        .map(function (track, index) {
          return { track: track, index: index };
        })
        .sort(function (a, b) {
          var rank = { audio: 0, text: 1, video: 2 };
          if (rank[a.track.kind] !== rank[b.track.kind]) return rank[a.track.kind] - rank[b.track.kind];
          return b.index - a.index;
        });

      ordered.forEach(function (row) {
        lanes.appendChild(buildLane(row.track, pxPerSecond));
      });

      playheadNode.style.transform = "translateX(" + playerInstance.time() * pxPerSecond + "px)";

      var empty = timeline.clipCount(project) === 0;
      emptyState.hidden = !empty;
      timelineWrap.classList.toggle("is-empty", empty);

      renderTrackControls();
    }

    function tickStep(pxPerSecond) {
      var candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] * pxPerSecond >= 64) return candidates[i];
      }
      return 600;
    }

    function tickLabel(time, step) {
      if (step >= 1) return timeline.formatTime(time);
      var whole = Math.floor(time + 0.0001);
      return timeline.formatTime(whole) + "." + Math.round((time - whole) * 10);
    }

    function buildLane(track, pxPerSecond) {
      var laneRow = el("div", "ve-lane-row ve-lane-" + track.kind + (track.id === activeTrackId ? " is-active" : ""));

      var head = el("div", "ve-lane-head");
      var title = el("div", "ve-lane-title");
      title.innerHTML = TRACK_ICONS[track.kind] || "";
      title.appendChild(el("b", null, track.name));
      head.appendChild(title);

      var headTools = el("div", "ve-lane-tools");
      headTools.appendChild(
        button(track.muted ? I.volumeOff : I.volume, "ve-ibtn" + (track.muted ? " is-off" : ""), function () {
          track.muted = !track.muted;
          commit();
        }, track.muted ? "Unmute track" : "Mute track")
      );
      if (track.kind !== "audio") {
        headTools.appendChild(
          button(track.hidden ? I.eyeOff : I.eye, "ve-ibtn" + (track.hidden ? " is-off" : ""), function () {
            track.hidden = !track.hidden;
            commit();
          }, track.hidden ? "Show track" : "Hide track")
        );
      }
      headTools.appendChild(
        button(I.trash, "ve-ibtn ve-ibtn-danger", function () {
          if (track.clips.length && !confirm("Remove " + track.name + " and its " + track.clips.length + " clip(s) from this edit?")) return;
          if (!timeline.removeTrack(project, track.id)) return host.showToast("Keep at least one " + track.kind + " track", true);
          commit();
        }, "Remove track")
      );
      head.appendChild(headTools);
      laneRow.appendChild(head);

      var lane = el("div", "ve-lane");
      lane.setAttribute("data-track-id", track.id);
      lane.onpointerdown = function (event) {
        if (event.target !== lane) return;
        activeTrackId = track.id;
        if (selectedClipId) {
          selectedClipId = null;
          renderInspector();
        }
        scrubTo(event);
        renderTimeline();
      };
      track.clips.forEach(function (clip) {
        lane.appendChild(buildClipBlock(track, clip, pxPerSecond));
      });
      laneRow.appendChild(lane);
      return laneRow;
    }

    function buildClipBlock(track, clip, pxPerSecond) {
      var source = clip.sourceItemId ? media.findSource(clip.sourceItemId, clip.sourceFileId) : null,
        missing = !!clip.sourceItemId && !source;

      var block = el("div", "ve-clip ve-clip-" + track.kind + (clip.id === selectedClipId ? " is-selected" : "") + (missing ? " is-missing" : ""));
      block.style.left = clip.start * pxPerSecond + "px";
      block.style.width = Math.max(12, timeline.clipLength(clip) * pxPerSecond) + "px";
      block.setAttribute("data-clip-id", clip.id);

      /* Video clips show their poster repeated like a filmstrip. */
      if (track.kind === "video" && source && source.entry.poster) {
        var strip = el("div", "ve-clip-strip");
        strip.style.backgroundImage = "url(" + source.entry.poster + ")";
        block.appendChild(strip);
      }

      var caption = el("span", "ve-clip-caption");
      caption.textContent = missing ? "Missing file" : track.kind === "text" ? clip.text.value.split("\n")[0] : source ? source.entry.name : "Clip";
      block.appendChild(caption);

      ["start", "end"].forEach(function (edge) {
        var handle = el("div", "ve-handle ve-handle-" + edge);
        handle.onpointerdown = function (event) {
          event.stopPropagation();
          /* On touch, an unselected clip's edge is a tap target for selecting,
             not trimming — same rule as the clip body below. */
          if (event.pointerType === "touch" && selectedClipId !== clip.id) {
            selectedClipId = clip.id;
            activeTrackId = track.id;
            renderTimeline();
            renderInspector();
            return;
          }
          beginTrim(event, block, track, clip, edge, pxPerSecond);
        };
        block.appendChild(handle);
      });

      block.onpointerdown = function (event) {
        var wasSelected = selectedClipId === clip.id;
        selectedClipId = clip.id;
        activeTrackId = track.id;
        /* Touch is two-step, like every phone editor: the first tap selects
           (and leaves the gesture free to scroll the timeline), dragging only
           starts once the clip is already selected. Mouse drags immediately. */
        if (event.pointerType === "touch" && !wasSelected) {
          renderTimeline();
          renderInspector();
          return;
        }
        beginMove(event, block, track, clip, pxPerSecond);
      };
      return block;
    }

    /* --- scrubbing --- */

    /* Time zero is the left edge of the ruler, not of the surface: the surface
       is padded to leave room for the sticky track headers. Measuring the DOM
       means this cannot drift out of step with the CSS. */
    function timeAtClientX(clientX) {
      return Math.max(0, (clientX - ruler.getBoundingClientRect().left) / zoom());
    }

    function scrubTo(event) {
      playerInstance.pause();
      playerInstance.seek(timeAtClientX(event.clientX));
      renderTransport();
    }

    /* Pointer capture is best effort — it throws if the pointer is already
       gone, and losing it only costs a little drag smoothness. */
    function capture(node, pointerId) {
      try {
        node.setPointerCapture(pointerId);
      } catch (e) {}
    }

    ruler.onpointerdown = function (event) {
      scrubTo(event);
      capture(ruler, event.pointerId);
      var move = function (moveEvent) {
        scrubTo(moveEvent);
      };
      var up = function () {
        ruler.removeEventListener("pointermove", move);
        ruler.removeEventListener("pointerup", up);
        ruler.removeEventListener("pointercancel", up);
      };
      ruler.addEventListener("pointermove", move);
      ruler.addEventListener("pointerup", up);
      ruler.addEventListener("pointercancel", up);
    };

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

    /* --- dragging clips ---

       The model is only touched on release. While the pointer is down the block
       moves with inline styles, which keeps the drag smooth and means a
       re-render triggered by an autosave cannot pull the DOM out from under it.
    */

    function beginMove(event, block, track, clip, pxPerSecond) {
      var startX = event.clientX,
        startY = event.clientY,
        originalLeft = clip.start * pxPerSecond,
        moved = false,
        targetTrack = track,
        points = timeline.snapPoints(project, clip.id, playerInstance.time()),
        length = timeline.clipLength(clip);

      dragging = true;
      capture(block, event.pointerId);
      block.classList.add("is-dragging");

      /* Which lane the pointer is over. Measured from the lane rectangles rather
         than with elementFromPoint, so a modal, the sign-in gate, or any other
         overlay cannot break dragging a clip to another track. Only the vertical
         position matters — horizontal is the time axis. */
      function laneUnder(clientY) {
        var found = null;
        Array.prototype.forEach.call(lanes.querySelectorAll(".ve-lane"), function (lane) {
          if (found) return;
          var rect = lane.getBoundingClientRect();
          if (clientY < rect.top || clientY > rect.bottom) return;
          var candidate = timeline.findTrack(project, lane.getAttribute("data-track-id"));
          if (candidate && candidate.kind === track.kind) found = candidate;
        });
        return found;
      }

      function move(moveEvent) {
        var dx = moveEvent.clientX - startX,
          dy = moveEvent.clientY - startY;
        if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        moved = true;
        var wantedStart = Math.max(0, (originalLeft + dx) / pxPerSecond);
        /* Snap either edge of the clip, whichever is closer to a marker. */
        var snappedStart = timeline.snapTime(wantedStart, points),
          snappedEnd = timeline.snapTime(wantedStart + length, points) - length;
        var pickStart = Math.abs(snappedStart - wantedStart) <= Math.abs(snappedEnd - wantedStart);
        var start = Math.max(0, pickStart ? snappedStart : snappedEnd);
        block.style.left = start * pxPerSecond + "px";
        block.dataset.pendingStart = start;

        if (Math.abs(start - wantedStart) > 0.0008) showGuide(pickStart ? start : start + length);
        else hideGuide();

        var overLane = laneUnder(moveEvent.clientY);
        if (overLane) targetTrack = overLane;
      }

      function finish() {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", finish);
        block.classList.remove("is-dragging");
        hideGuide();
        dragging = false;
        if (!moved) {
          renderTimeline();
          renderInspector();
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
      var startX = event.clientX,
        points = timeline.snapPoints(project, clip.id, playerInstance.time()),
        originalStart = clip.start,
        originalEnd = timeline.clipEnd(clip),
        pending = edge === "start" ? originalStart : originalEnd;

      dragging = true;
      selectedClipId = clip.id;
      capture(block, event.pointerId);
      block.classList.add("is-trimming");

      function move(moveEvent) {
        var dx = (moveEvent.clientX - startX) / pxPerSecond;
        var raw = (edge === "start" ? originalStart : originalEnd) + dx;
        pending = timeline.snapTime(raw, points);
        if (Math.abs(pending - raw) > 0.0008) showGuide(pending);
        else hideGuide();
        /* Preview the trim without committing, so the model stays clean until
           the pointer is released. */
        var previewStart = edge === "start" ? Math.min(pending, originalEnd - timeline.MIN_CLIP) : originalStart,
          previewEnd = edge === "start" ? originalEnd : Math.max(pending, originalStart + timeline.MIN_CLIP);
        block.style.left = Math.max(0, previewStart) * pxPerSecond + "px";
        block.style.width = Math.max(12, (previewEnd - previewStart) * pxPerSecond) + "px";
      }

      function finish() {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", finish);
        block.classList.remove("is-trimming");
        hideGuide();
        dragging = false;
        timeline.trimClip(project, clip.id, edge, pending);
        commit();
      }

      block.addEventListener("pointermove", move);
      block.addEventListener("pointerup", finish);
      block.addEventListener("pointercancel", finish);
    }

    /* --- track controls --- */

    function renderTrackControls() {
      trackControls.innerHTML = "";
      trackControls.appendChild(
        button(I.plus + "<span>Media</span>", "ve-btn ve-btn-primary", function () {
          openMediaPicker();
        }, "Pull footage or audio from your account into this edit")
      );
      trackControls.appendChild(
        button(I.text + "<span>Text</span>", "ve-btn", function () {
          addTextClip();
        }, "Add a title at the playhead")
      );
      if (recorder) {
        trackControls.appendChild(
          button(
            '<span class="ve-rec-dot"></span><span>Stop · ' + timeline.formatTime((Date.now() - recorder.started) / 1000) + "</span>",
            "ve-btn ve-btn-rec",
            function () {
              toggleVoiceover();
            },
            "Stop recording"
          )
        );
      } else {
        trackControls.appendChild(
          button(I.mic + "<span>Voiceover</span>", "ve-btn", function () {
            toggleVoiceover();
          }, "Record straight into this edit")
        );
      }
      trackControls.appendChild(el("span", "ve-flex-gap"));
      trackControls.appendChild(
        button(I.layers + "<span>Video track</span>", "ve-btn ve-btn-quiet", function () {
          timeline.addTrack(project, "video");
          commit();
        }, "Add another video track")
      );
      trackControls.appendChild(
        button(I.wave + "<span>Audio track</span>", "ve-btn ve-btn-quiet", function () {
          timeline.addTrack(project, "audio");
          commit();
        }, "Add another audio track")
      );
    }

    /* --- inspector --- */

    var inspector = el("div", "ve-inspector");
    root.appendChild(inspector);

    function renderInspector() {
      inspector.innerHTML = "";
      var hit = selectedClipId ? timeline.findClip(project, selectedClipId) : null;
      if (!hit) {
        var empty = el("div", "ve-inspector-empty");
        empty.appendChild(el("p", "ve-hint", "Select a clip to edit it — drag it to move, drag its edges to trim."));
        var keys = el("div", "ve-keys");
        [["Space", "Play"], ["S", "Split"], ["Del", "Delete"], ["Ctrl+Z", "Undo"]].forEach(function (pair) {
          var key = el("span", "ve-key");
          key.appendChild(el("kbd", null, pair[0]));
          key.appendChild(el("small", null, pair[1]));
          keys.appendChild(key);
        });
        empty.appendChild(keys);
        inspector.appendChild(empty);
        renderMissingNotice();
        renderRenders();
        return;
      }

      var clip = hit.clip,
        track = hit.track,
        source = clip.sourceItemId ? media.findSource(clip.sourceItemId, clip.sourceFileId) : null;

      var head = el("div", "ve-inspector-head");
      var title = el("div", "ve-inspector-title");
      title.appendChild(el("span", "ve-kind ve-kind-" + track.kind));
      title.appendChild(el("b", null, track.kind === "text" ? "Text clip" : source ? source.entry.name : "Missing file"));
      head.appendChild(title);
      head.appendChild(
        el(
          "small",
          null,
          timeline.formatTime(clip.start) +
            " → " +
            timeline.formatTime(timeline.clipEnd(clip)) +
            " · " +
            timeline.formatTime(timeline.clipLength(clip)) +
            " long" +
            (source ? " · from " + (source.item.title || "Untitled") : "")
        )
      );
      inspector.appendChild(head);

      var actions = el("div", "ve-inspector-actions");
      actions.appendChild(
        button(I.scissors + "<span>Split here</span>", "ve-btn", function () {
          if (!timeline.splitAt(project, playerInstance.time(), clip.id)) return host.showToast("Put the playhead inside this clip first", true);
          commit();
        })
      );
      actions.appendChild(
        button(I.copy + "<span>Duplicate</span>", "ve-btn", function () {
          var copy = timeline.duplicateClip(project, clip.id);
          if (copy) selectedClipId = copy.id;
          commit();
        })
      );
      actions.appendChild(
        button(I.trash + "<span>Delete</span>", "ve-btn", function () {
          timeline.removeClip(project, clip.id);
          selectedClipId = null;
          commit();
        })
      );
      actions.appendChild(
        button(I.trash + "<span>Delete & close gap</span>", "ve-btn ve-btn-danger", function () {
          timeline.rippleDelete(project, clip.id);
          selectedClipId = null;
          commit();
        })
      );
      inspector.appendChild(actions);

      var grid = el("div", "ve-inspector-grid");

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
        var length = timeline.clipLength(clip);
        grid.appendChild(
          slider("Fade in", clip.fadeIn, 0, Math.max(0.5, Math.min(5, length)), 0.05, function (value) {
            clip.fadeIn = value;
            host.touchItem(item);
            host.save();
          }, function (value) {
            return Number(value).toFixed(2) + "s";
          }, settle)
        );
        grid.appendChild(
          slider("Fade out", clip.fadeOut, 0, Math.max(0.5, Math.min(5, length)), 0.05, function (value) {
            clip.fadeOut = value;
            host.touchItem(item);
            host.save();
          }, function (value) {
            return Number(value).toFixed(2) + "s";
          }, settle)
        );
        var muteRow = row("Mute this clip");
        muteRow.appendChild(
          button(clip.muted ? "Muted" : "Audible", "ve-chip" + (clip.muted ? " is-off" : ""), function () {
            clip.muted = !clip.muted;
            commit();
          })
        );
        grid.appendChild(muteRow);
      }

      if (track.kind === "video") {
        var fitRow = row("Framing", "Contain letterboxes the clip, cover fills the frame");
        fitRow.appendChild(
          button(clip.fit === "cover" ? "Cover" : "Contain", "ve-chip", function () {
            clip.fit = clip.fit === "cover" ? "contain" : "cover";
            commit();
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

      if (track.kind === "text") {
        var text = clip.text;
        var valueField = field("Text");
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
        area.onchange = settle;
        valueField.appendChild(area);
        grid.appendChild(valueField);

        var colorField = field("Colour");
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
        colorField.appendChild(color);
        grid.appendChild(colorField);

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

        var alignRow = row("Alignment");
        ["left", "center", "right"].forEach(function (option) {
          alignRow.appendChild(
            button(option, "ve-chip" + (text.align === option ? " is-on" : ""), function () {
              text.align = option;
              commit();
            })
          );
        });
        grid.appendChild(alignRow);

        var plateRow = row("Backing plate", "A dark box behind the text for readability");
        plateRow.appendChild(
          button(text.background ? "On" : "Off", "ve-chip" + (text.background ? " is-on" : ""), function () {
            text.background = !text.background;
            commit();
          })
        );
        grid.appendChild(plateRow);
      }

      inspector.appendChild(grid);
      renderMissingNotice();
      renderRenders();
    }

    function renderMissingNotice() {
      var missing = 0;
      project.tracks.forEach(function (track) {
        track.clips.forEach(function (clip) {
          if (clip.sourceItemId && !media.sourceExists(clip.sourceItemId, clip.sourceFileId)) missing++;
        });
      });
      if (!missing) return;
      var notice = el("div", "ve-notice");
      notice.appendChild(el("b", null, missing + " clip" + (missing === 1 ? "" : "s") + " point at files that are gone"));
      notice.appendChild(
        button("Remove them", "ve-btn ve-btn-danger", function () {
          timeline.pruneMissingSources(project, media.sourceExists);
          selectedClipId = null;
          commit();
        })
      );
      inspector.appendChild(notice);
    }

    function renderRenders() {
      if (!(item.renders || []).length) return;
      var section = el("div", "ve-renders");
      section.appendChild(el("h4", null, "Exports"));
      item.renders.forEach(function (entry) {
        var renderRow = el("div", "ve-render-row");
        renderRow.appendChild(el("b", null, entry.name));
        renderRow.appendChild(el("small", null, media.entrySummary(item, entry)));
        renderRow.appendChild(
          button("Download", "ve-btn", function () {
            downloadEntry(item, entry);
          })
        );
        renderRow.appendChild(
          button("Remove", "ve-btn ve-btn-danger", function () {
            if (!confirm("Delete " + entry.name + " from your account?")) return;
            media.removeEntry(item, entry, "renders");
            renderInspector();
          })
        );
        section.appendChild(renderRow);
      });
      inspector.appendChild(section);
    }

    /* --- adding content --- */

    function firstTrackOfKind(kind) {
      var active = activeTrackId ? timeline.findTrack(project, activeTrackId) : null;
      if (active && active.kind === kind) return active;
      return project.tracks.filter(function (track) {
        return track.kind === kind;
      })[0];
    }

    function addLibraryEntry(entry) {
      var kind = entry.kind === "audio" ? "audio" : "video",
        track = firstTrackOfKind(kind);
      if (!track) track = timeline.addTrack(project, kind);
      var clip = timeline.createMediaClip({ itemId: entry.itemId, fileId: entry.fileId, duration: entry.duration });
      timeline.appendClip(project, track.id, clip);
      selectedClipId = clip.id;
      activeTrackId = track.id;
      commit();
    }

    function addTextClip() {
      var track = project.tracks.filter(function (candidate) {
        return candidate.kind === "text";
      })[0];
      if (!track) track = timeline.addTrack(project, "text", "Text 1");
      var clip = timeline.createTextClip({ start: playerInstance.time(), length: 3 });
      timeline.addClip(project, track.id, clip, playerInstance.time());
      selectedClipId = clip.id;
      activeTrackId = track.id;
      commit();
    }

    function openMediaPicker() {
      openOverlay("Media in your account", function (body, close) {
        var controls = el("div", "ve-picker-controls");
        var search = document.createElement("input");
        search.type = "search";
        search.className = "ve-search";
        search.placeholder = "Search files, items, or folders";
        controls.appendChild(search);

        var kindFilter = "all";
        var kindRow = el("div", "ve-chip-row");
        [["all", "Everything"], ["video", "Video"], ["audio", "Audio"]].forEach(function (pair) {
          kindRow.appendChild(
            button(pair[1], "ve-chip" + (kindFilter === pair[0] ? " is-on" : ""), function (event) {
              kindFilter = pair[0];
              Array.prototype.forEach.call(kindRow.children, function (child) {
                child.classList.remove("is-on");
              });
              event.currentTarget.classList.add("is-on");
              draw();
            })
          );
        });
        controls.appendChild(kindRow);

        var folderFilter = null;
        var folders = host.folders();
        if (folders.length) {
          var folderRow = el("div", "ve-chip-row");
          var markFolder = function (node) {
            Array.prototype.forEach.call(folderRow.children, function (child) {
              child.classList.remove("is-on");
            });
            node.classList.add("is-on");
            draw();
          };
          folderRow.appendChild(
            button("All folders", "ve-chip is-on", function (event) {
              folderFilter = null;
              markFolder(event.currentTarget);
            })
          );
          folders.forEach(function (folder) {
            folderRow.appendChild(
              button(folder.name, "ve-chip", function (event) {
                folderFilter = folder.id;
                markFolder(event.currentTarget);
              })
            );
          });
          controls.appendChild(folderRow);
        }
        body.appendChild(controls);

        var results = el("div", "ve-picker-grid");
        body.appendChild(results);

        function draw() {
          var entries = media.libraryEntries({
            kind: kindFilter === "all" ? null : kindFilter,
            query: search.value.trim(),
            folderId: folderFilter
          });
          results.innerHTML = "";
          if (!entries.length) {
            results.appendChild(
              el("div", "ve-empty", "Nothing here yet. Create a Video item in a folder like Footage or B-Roll and upload your clips, and they will show up here.")
            );
            return;
          }
          entries.forEach(function (entry) {
            var card = el("button", "ve-picker-card");
            card.type = "button";
            var thumb = el("div", "ve-picker-thumb");
            thumb.appendChild(posterNode(entry.entry, "ve-picker-poster"));
            if (entry.duration) thumb.appendChild(el("span", "ve-picker-length", timeline.formatTime(entry.duration)));
            card.appendChild(thumb);
            var info = el("div", "ve-picker-info");
            info.appendChild(el("b", null, entry.name));
            info.appendChild(
              el(
                "small",
                null,
                [entry.itemTitle, entry.folderName, entry.kind === "audio" ? "Audio" : "Video"]
                  .filter(Boolean)
                  .join(" · ")
              )
            );
            card.appendChild(info);
            card.onclick = function () {
              addLibraryEntry(entry);
              host.showToast("Added " + entry.name);
            };
            results.appendChild(card);
          });
        }

        search.oninput = draw;
        draw();
        body.appendChild(
          el("p", "ve-hint", "Clips are added to the end of the current track. Adding the same file twice is free — it is one upload either way.")
        );
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
            renderTrackControls();
            saveVoiceover(new Blob(chunks, { type: instance.mimeType || mime || "audio/webm" }), seconds);
          };
          instance.start();
          recorderTimer = setInterval(renderTrackControls, 500);
          renderTrackControls();
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

    /* --- export --- */

    function openExportDialog() {
      var total = timeline.duration(project);
      if (total <= 0) return host.showToast("Add a clip to the timeline first", true);
      if (!ns.player.canExport()) return host.showToast("This browser cannot record video", true);

      openOverlay("Export this cut", function (body, close) {
        var ratio = project.height / project.width;
        var sizes = [
          { label: "720p", width: 1280 },
          { label: "1080p", width: 1920 },
          { label: "Project size (" + project.width + "×" + project.height + ")", width: project.width }
        ];
        var chosen = sizes[0];

        body.appendChild(
          el(
            "p",
            "ve-hint",
            "There is no render server, so the export is a real-time recording of the preview. It takes about as long as the video itself (" +
              timeline.formatTime(total) +
              "), and this tab has to stay in front the whole time. The finished file is saved to your account and downloaded here."
          )
        );

        var sizeField = row("Resolution");
        var sizeRow = el("div", "ve-chip-row");
        sizes.forEach(function (size, index) {
          sizeRow.appendChild(
            button(size.label, "ve-chip" + (index === 0 ? " is-on" : ""), function (event) {
              chosen = size;
              Array.prototype.forEach.call(sizeRow.children, function (child) {
                child.classList.remove("is-on");
              });
              event.currentTarget.classList.add("is-on");
            })
          );
        });
        sizeField.appendChild(sizeRow);
        body.appendChild(sizeField);

        var status = el("p", "ve-hint", "");
        var bar = el("div", "ve-progress");
        var fill = el("div", "ve-progress-fill");
        bar.appendChild(fill);
        bar.hidden = true;
        body.appendChild(bar);
        body.appendChild(status);

        var start = button(I.download + "<span>Start export</span>", "ve-btn ve-btn-primary ve-export-start", function () {
          start.disabled = true;
          bar.hidden = false;
          exportRunning = true;
          status.textContent = "Loading every clip…";
          var width = Math.round(chosen.width),
            height = Math.round(width * ratio);
          /* Recorders want even dimensions. */
          if (height % 2) height += 1;

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
              return saveRender(result, width, height);
            })
            .then(function () {
              close();
              renderInspector();
            })
            .catch(function (error) {
              exportRunning = false;
              console.warn("Export failed:", error);
              status.textContent = error && error.message ? error.message : "Export failed";
              start.disabled = false;
            });
        });
        body.appendChild(start);
      });
    }

    function saveRender(result, width, height) {
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

      return media.addFiles(item, [file], { list: "renders", kind: "render" }).then(function () {
        host.showToast("Export finished — " + host.fileSize(result.blob.size));
        host.renderList();
      });
    }

    function downloadEntry(ownerItem, entry) {
      media
        .resolveEntry(ownerItem, entry)
        .then(function (source) {
          var link = document.createElement("a");
          link.href = source.url;
          link.download = entry.name || "export";
          link.target = "_blank";
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        })
        .catch(function (error) {
          host.showToast(error && error.message ? error.message : "That file is not available here", true);
        });
    }

    /* --- keyboard --- */

    function onKeyDown(event) {
      if (!activeView || activeView.itemId !== item.id) return;
      var target = event.target;
      if (target && target.closest && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (exportRunning) return;
      if (document.querySelector(".ve-modal") || document.querySelector(".modal.open")) return;

      var meta = event.ctrlKey || event.metaKey;
      if (meta && !event.altKey) {
        var key = (event.key || "").toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          undo();
        } else if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          redo();
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
        selectedClipId = null;
        renderTimeline();
        renderInspector();
      } else if (event.key === "ArrowLeft") {
        playerInstance.seek(playerInstance.time() - (event.shiftKey ? 1 : 1 / project.fps));
        ensurePlayheadVisible();
      } else if (event.key === "ArrowRight") {
        playerInstance.seek(playerInstance.time() + (event.shiftKey ? 1 : 1 / project.fps));
        ensurePlayheadVisible();
      } else if (event.key === "Home") {
        event.preventDefault();
        playerInstance.seek(0);
        scroller.scrollLeft = 0;
      } else if (event.key === "End") {
        event.preventDefault();
        playerInstance.seek(timeline.duration(project));
        ensurePlayheadVisible();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    var stopWatchingUploads = media.onUploadChange(function () {
      if (!dragging && !isEditingControl(inspector)) renderInspector();
    });

    var view = {
      itemId: item.id,
      root: root,
      player: playerInstance,
      sync: function () {
        ensureEditItem(item);
        project = item.project;
        baseline = JSON.stringify(item.project);
        if (!dragging) {
          renderTimeline();
          renderInspector();
        }
        renderTransport();
      },
      destroy: function () {
        document.removeEventListener("keydown", onKeyDown);
        stopWatchingUploads();
        clearInterval(recorderTimer);
        if (recorder) stopVoiceover();
        playerInstance.destroy();
      }
    };

    renderTransport();
    renderTimeline();
    renderInspector();
    /* The surface width depends on the scroller's measured width, which is only
       known once it is in the document. */
    requestAnimationFrame(function () {
      if (root.isConnected) renderTimeline();
    });

    return view;
  }

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
  }

  ns.install = function (bridge) {
    host = bridge;
    media.install(bridge);

    return [
      {
        type: "video",
        label: "Video",
        menuLabel: "Video",
        manageLabel: "Video",
        manageHint: "Upload footage and B-roll that syncs to every device",
        defaultEnabled: true,
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
        text: function (item) {
          return (item.clips || [])
            .map(function (clip) {
              return clip.name || "";
            })
            .join(" ");
        },
        meta: function (item) {
          var clips = item.clips || [];
          if (!clips.length) return "No footage";
          var total = clips.reduce(function (sum, clip) {
            return sum + (clip.duration || 0);
          }, 0);
          return clips.length + " file" + (clips.length === 1 ? "" : "s") + (total ? " · " + timeline.formatTime(total) : "");
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
        type: "edit",
        label: "Edited Video",
        menuLabel: "Edited Video",
        manageLabel: "Edited Video",
        manageHint: "Cut footage from your account on a timeline, with voiceovers and text",
        defaultEnabled: true,
        icon: ICON_EDIT_VIDEO,
        placeholder: "Untitled edit",
        hideCopy: true,
        ownsFiles: true,
        create: newEditItem,
        normalize: ensureEditItem,
        /* Only the files this item actually owns. Timeline clips point at
           footage owned by Video items — reporting those here would let
           deleting an edit delete the source footage. */
        files: function (item) {
          return (item.voiceovers || []).concat(item.renders || []);
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
            total = timeline.duration(project);
          return count ? count + " clip" + (count === 1 ? "" : "s") + " · " + timeline.formatTime(total) : "Empty timeline";
        },
        build: function (item) {
          return useView(buildEditView, item);
        },
        refresh: function (item) {
          if (activeView && activeView.itemId === item.id) activeView.sync();
        },
        detach: tearDown,
        reset: reset
      }
    ];
  };
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
