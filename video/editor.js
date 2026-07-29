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
  var MIN_ZOOM = 6;
  var MAX_ZOOM = 400;

  var ICON_VIDEO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 11 6-3.5v9L15 13z"/></svg>';
  var ICON_EDIT_VIDEO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v14"/><path d="m12 12 4 2-4 2z"/></svg>';

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

  function slider(labelText, value, min, max, step, onInput, formatValue) {
    var wrap = field(labelText),
      row = el("div", "ve-slider-row"),
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
    row.appendChild(input);
    row.appendChild(readout);
    wrap.appendChild(row);
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
    placeholder.innerHTML = media.isAudioEntry(entry || {}) ? "♪" : ICON_VIDEO;
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

    /* --- committing a change --- */

    function commit(options) {
      options = options || {};
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

    /* --- monitor and transport --- */

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
    monitor.onclick = function () {
      playerInstance.toggle();
      renderTransport();
    };
    /* Preview at a size that a phone can composite comfortably; export uses the
       project resolution. */
    playerInstance.setResolution(Math.min(project.width, 960), Math.round(Math.min(project.width, 960) * (project.height / project.width)));

    var playButton, timeReadout;

    function renderTransport() {
      transport.innerHTML = "";
      playButton = button(
        playerInstance.isPlaying()
          ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
        "ve-play",
        function () {
          playerInstance.toggle();
          renderTransport();
        },
        playerInstance.isPlaying() ? "Pause" : "Play"
      );
      transport.appendChild(playButton);

      timeReadout = el("div", "ve-time");
      timeReadout.textContent = timeline.formatTime(playerInstance.time(), true, project.fps) + " / " + timeline.formatTime(timeline.duration(project));
      transport.appendChild(timeReadout);

      var tools = el("div", "ve-transport-tools");
      tools.appendChild(
        button("Split", "ve-btn", function () {
          var cuts = timeline.splitAt(project, playerInstance.time());
          if (!cuts) return host.showToast("Move the playhead over a clip to split it", true);
          commit();
          host.showToast(cuts + " clip" + (cuts === 1 ? "" : "s") + " split");
        }, "Split every clip under the playhead")
      );
      tools.appendChild(
        button("−", "ve-btn ve-btn-icon", function () {
          setZoom(zoom() / 1.5);
        }, "Zoom out")
      );
      tools.appendChild(
        button("+", "ve-btn ve-btn-icon", function () {
          setZoom(zoom() * 1.5);
        }, "Zoom in")
      );
      tools.appendChild(
        button("Export", "ve-btn ve-btn-primary", function () {
          openExportDialog();
        }, "Render this cut to a video file")
      );
      transport.appendChild(tools);
    }

    function updatePlayhead(time) {
      if (timeReadout) timeReadout.textContent = timeline.formatTime(time, true, project.fps) + " / " + timeline.formatTime(timeline.duration(project));
      if (playheadNode) playheadNode.style.transform = "translateX(" + time * zoom() + "px)";
      if (playButton) {
        var wantPause = playerInstance.isPlaying();
        if (playButton.getAttribute("aria-label") === "Play" && wantPause) renderTransport();
        else if (playButton.getAttribute("aria-label") === "Pause" && !wantPause) renderTransport();
      }
    }

    /* --- zoom --- */

    function zoom() {
      return zoomByItem[item.id] || DEFAULT_ZOOM;
    }
    function setZoom(next) {
      zoomByItem[item.id] = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      renderTimeline();
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
    var scroller = el("div", "ve-scroller");
    var surface = el("div", "ve-surface");
    surface.appendChild(ruler);
    surface.appendChild(lanes);
    surface.appendChild(playheadNode);
    scroller.appendChild(surface);
    timelineWrap.appendChild(scroller);
    root.appendChild(timelineWrap);

    var trackControls = el("div", "ve-track-actions");
    root.appendChild(trackControls);

    function renderTrackControls() {
      trackControls.innerHTML = "";
      trackControls.appendChild(
        button("+ Media", "ve-btn ve-btn-primary", function () {
          openMediaPicker();
        }, "Pull footage or audio from your account into this edit")
      );
      trackControls.appendChild(
        button("+ Text", "ve-btn", function () {
          addTextClip();
        })
      );
      trackControls.appendChild(
        button("+ Voiceover", "ve-btn", function () {
          toggleVoiceover();
        }, "Record straight into this edit")
      );
      trackControls.appendChild(
        button("+ Video track", "ve-btn", function () {
          timeline.addTrack(project, "video");
          commit();
        })
      );
      trackControls.appendChild(
        button("+ Audio track", "ve-btn", function () {
          timeline.addTrack(project, "audio");
          commit();
        })
      );
      if (recorder) {
        var live = el("span", "ve-recording", "Recording " + timeline.formatTime((Date.now() - recorder.started) / 1000) + " — tap +Voiceover to stop");
        trackControls.appendChild(live);
      }
    }

    /* Rebuilds the whole timeline. Cheap at this scale and it keeps the DOM a
       plain function of the project, which is much easier to reason about than
       incremental patching. Never called while a drag is in flight. */
    function renderTimeline() {
      if (dragging) return;
      var total = timeline.duration(project),
        pxPerSecond = zoom(),
        width = Math.max(total * pxPerSecond + 240, scroller.clientWidth || 320);
      surface.style.width = width + "px";

      /* --- ruler --- */
      ruler.innerHTML = "";
      var step = tickStep(pxPerSecond);
      for (var time = 0; time <= total + step; time += step) {
        var tick = el("div", "ve-tick");
        tick.style.left = time * pxPerSecond + "px";
        tick.appendChild(el("span", null, timeline.formatTime(time)));
        ruler.appendChild(tick);
      }

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
      renderTrackControls();
    }

    function tickStep(pxPerSecond) {
      var candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] * pxPerSecond >= 64) return candidates[i];
      }
      return 600;
    }

    function buildLane(track, pxPerSecond) {
      var laneRow = el("div", "ve-lane-row ve-lane-" + track.kind + (track.id === activeTrackId ? " is-active" : ""));

      var head = el("div", "ve-lane-head");
      head.appendChild(el("b", null, track.name));
      var headTools = el("div", "ve-lane-tools");
      headTools.appendChild(
        button(track.muted ? "Unmute" : "Mute", "ve-chip" + (track.muted ? " is-off" : ""), function () {
          track.muted = !track.muted;
          commit();
        })
      );
      if (track.kind !== "audio") {
        headTools.appendChild(
          button(track.hidden ? "Show" : "Hide", "ve-chip" + (track.hidden ? " is-off" : ""), function () {
            track.hidden = !track.hidden;
            commit();
          })
        );
      }
      headTools.appendChild(
        button("Remove", "ve-chip ve-chip-danger", function () {
          if (track.clips.length && !confirm("Remove " + track.name + " and its " + track.clips.length + " clip(s) from this edit?")) return;
          if (!timeline.removeTrack(project, track.id)) return host.showToast("Keep at least one " + track.kind + " track", true);
          commit();
        })
      );
      head.appendChild(headTools);
      laneRow.appendChild(head);

      var lane = el("div", "ve-lane");
      lane.setAttribute("data-track-id", track.id);
      lane.onpointerdown = function (event) {
        if (event.target !== lane) return;
        activeTrackId = track.id;
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
      block.style.width = Math.max(10, timeline.clipLength(clip) * pxPerSecond) + "px";
      block.setAttribute("data-clip-id", clip.id);

      if (track.kind === "video" && source && source.entry.poster) block.style.backgroundImage = "url(" + source.entry.poster + ")";

      var caption = el("span", "ve-clip-caption");
      caption.textContent = missing ? "Missing file" : track.kind === "text" ? clip.text.value.split("\n")[0] : source ? source.entry.name : "Clip";
      block.appendChild(caption);

      ["start", "end"].forEach(function (edge) {
        var handle = el("div", "ve-handle ve-handle-" + edge);
        handle.onpointerdown = function (event) {
          event.stopPropagation();
          beginTrim(event, block, track, clip, edge, pxPerSecond);
        };
        block.appendChild(handle);
      });

      block.onpointerdown = function (event) {
        selectedClipId = clip.id;
        activeTrackId = track.id;
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
        var start = Math.abs(snappedStart - wantedStart) <= Math.abs(snappedEnd - wantedStart) ? snappedStart : snappedEnd;
        start = Math.max(0, start);
        block.style.left = start * pxPerSecond + "px";
        block.dataset.pendingStart = start;

        var overLane = laneUnder(moveEvent.clientY);
        if (overLane) targetTrack = overLane;
      }

      function finish() {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", finish);
        block.classList.remove("is-dragging");
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
        pending = timeline.snapTime((edge === "start" ? originalStart : originalEnd) + dx, points);
        /* Preview the trim without committing, so the model stays clean until
           the pointer is released. */
        var previewStart = edge === "start" ? Math.min(pending, originalEnd - timeline.MIN_CLIP) : originalStart,
          previewEnd = edge === "start" ? originalEnd : Math.max(pending, originalStart + timeline.MIN_CLIP);
        block.style.left = Math.max(0, previewStart) * pxPerSecond + "px";
        block.style.width = Math.max(10, (previewEnd - previewStart) * pxPerSecond) + "px";
      }

      function finish() {
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", finish);
        block.removeEventListener("pointercancel", finish);
        block.classList.remove("is-trimming");
        dragging = false;
        timeline.trimClip(project, clip.id, edge, pending);
        commit();
      }

      block.addEventListener("pointermove", move);
      block.addEventListener("pointerup", finish);
      block.addEventListener("pointercancel", finish);
    }

    /* --- inspector --- */

    var inspector = el("div", "ve-inspector");
    root.appendChild(inspector);

    function renderInspector() {
      inspector.innerHTML = "";
      var hit = selectedClipId ? timeline.findClip(project, selectedClipId) : null;
      if (!hit) {
        inspector.appendChild(el("p", "ve-hint", "Tap a clip on the timeline to trim it, change its volume, or restyle its text. Drag a clip to move it, or drag its edges to trim."));
        renderMissingNotice();
        renderRenders();
        return;
      }

      var clip = hit.clip,
        track = hit.track,
        source = clip.sourceItemId ? media.findSource(clip.sourceItemId, clip.sourceFileId) : null;

      var head = el("div", "ve-inspector-head");
      head.appendChild(el("b", null, track.kind === "text" ? "Text clip" : source ? source.entry.name : "Missing file"));
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
        button("Split here", "ve-btn", function () {
          if (!timeline.splitAt(project, playerInstance.time(), clip.id)) return host.showToast("Put the playhead inside this clip first", true);
          commit();
        })
      );
      actions.appendChild(
        button("Duplicate", "ve-btn", function () {
          var copy = timeline.duplicateClip(project, clip.id);
          if (copy) selectedClipId = copy.id;
          commit();
        })
      );
      actions.appendChild(
        button("Delete", "ve-btn", function () {
          timeline.removeClip(project, clip.id);
          selectedClipId = null;
          commit();
        })
      );
      actions.appendChild(
        button("Delete & close gap", "ve-btn ve-btn-danger", function () {
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
          })
        );
        var length = timeline.clipLength(clip);
        grid.appendChild(
          slider("Fade in", clip.fadeIn, 0, Math.max(0.5, Math.min(5, length)), 0.05, function (value) {
            clip.fadeIn = value;
            host.touchItem(item);
            host.save();
          }, function (value) {
            return Number(value).toFixed(2) + "s";
          })
        );
        grid.appendChild(
          slider("Fade out", clip.fadeOut, 0, Math.max(0.5, Math.min(5, length)), 0.05, function (value) {
            clip.fadeOut = value;
            host.touchItem(item);
            host.save();
          }, function (value) {
            return Number(value).toFixed(2) + "s";
          })
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
          })
        );
        grid.appendChild(
          slider("Nudge across", clip.offsetX, -50, 50, 1, function (value) {
            clip.offsetX = value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          }, function (value) {
            return value + "%";
          })
        );
        grid.appendChild(
          slider("Nudge down", clip.offsetY, -50, 50, 1, function (value) {
            clip.offsetY = value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          }, function (value) {
            return value + "%";
          })
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
          })
        );
        grid.appendChild(
          slider("Across", text.x, 0, 100, 1, function (value) {
            text.x = value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          })
        );
        grid.appendChild(
          slider("Down", text.y, 0, 100, 1, function (value) {
            text.y = value;
            host.touchItem(item);
            host.save();
            playerInstance.projectChanged();
          })
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
        var row = el("div", "ve-render-row");
        row.appendChild(el("b", null, entry.name));
        row.appendChild(el("small", null, media.entrySummary(item, entry)));
        row.appendChild(
          button("Download", "ve-btn", function () {
            downloadEntry(item, entry);
          })
        );
        row.appendChild(
          button("Remove", "ve-btn ve-btn-danger", function () {
            if (!confirm("Delete " + entry.name + " from your account?")) return;
            media.removeEntry(item, entry, "renders");
            renderInspector();
          })
        );
        section.appendChild(row);
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
            card.appendChild(posterNode(entry.entry, "ve-picker-poster"));
            var info = el("div", "ve-picker-info");
            info.appendChild(el("b", null, entry.name));
            info.appendChild(
              el(
                "small",
                null,
                [entry.duration ? timeline.formatTime(entry.duration) : null, entry.itemTitle, entry.folderName, entry.kind === "audio" ? "Audio" : "Video"]
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
        body.appendChild(sizeRow);

        var status = el("p", "ve-hint", "");
        var bar = el("div", "ve-progress");
        var fill = el("div", "ve-progress-fill");
        bar.appendChild(fill);
        bar.hidden = true;
        body.appendChild(bar);
        body.appendChild(status);

        var start = button("Start export", "ve-btn ve-btn-primary", function () {
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
      /* Leave browser and app shortcuts alone (the core owns Ctrl+Enter). */
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector(".ve-modal") || document.querySelector(".modal.open")) return;

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
      } else if (event.key === "ArrowLeft") {
        playerInstance.seek(playerInstance.time() - (event.shiftKey ? 1 : 1 / project.fps));
      } else if (event.key === "ArrowRight") {
        playerInstance.seek(playerInstance.time() + (event.shiftKey ? 1 : 1 / project.fps));
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
