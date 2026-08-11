/*
  Second Brain — video/timeline.js

  The timeline data model for an "Edited Video" item. This file is deliberately
  pure: no DOM, no Firebase, no reads of the app state. Every function takes a
  project object and returns a value or mutates that project. That makes the
  editing rules easy to reason about (and easy to change) without touching the
  UI in video/editor.js or the playback engine in video/player.js.

  Shape of a project:

    project = {
      width, height, fps,
      tracks: [ track, ... ]           // index 0 renders at the bottom
    }

    track = {
      id, kind: "video" | "audio" | "text",
      name, muted, hidden, locked,
      color,                           // "" = follow the app theme, or "#rrggbb"
      clips: [ clip, ... ]             // always sorted by clip.start, never overlapping
    }

    clip = {
      id,
      sourceItemId, sourceFileId,      // null on text clips
      srcDuration,                     // full length of the source file, 0 for text
      start,                           // position on the timeline, in seconds
      in, out,                         // slice taken from the source, in seconds
      volume, muted, fadeIn, fadeOut,
      fit, scale, offsetX, offsetY,    // video framing
      opacity, color,                  // opacity 0..1, color "" = follow the track
      anim: { in:{id,d}, out:{id,d}, loop:{id,d} },
      text                             // text clips only, see textDefaults()
    }

  Animation ids are stored as plain strings and are *never* validated here — the
  registry lives in video/animations.js and the player treats an unknown id as
  "no animation". That is what makes adding a new animation a one-line change
  later on: a project saved on a newer build still opens on an older one.

  Invariant maintained by every mutator here: clips on one track are sorted by
  start and never overlap. Moves and trims clamp against their neighbours
  instead of pushing them around, which keeps the behaviour predictable.
*/
(function (ns) {
  "use strict";

  var timeline = (ns.timeline = ns.timeline || {});

  var DEFAULTS = (timeline.DEFAULTS = { width: 1920, height: 1080, fps: 30 });
  var MIN_CLIP = (timeline.MIN_CLIP = 0.1);
  var SNAP_WINDOW = (timeline.SNAP_WINDOW = 0.09);
  var TRACK_KINDS = (timeline.TRACK_KINDS = ["video", "audio", "text"]);

  /* Frame sizes offered in the editor. Height is derived so a switch never
     invents a resolution the encoder cannot record. */
  var ASPECTS = (timeline.ASPECTS = [
    { id: "16:9", label: "16:9", hint: "YouTube", width: 1920, height: 1080 },
    { id: "9:16", label: "9:16", hint: "Shorts · Reels · TikTok", width: 1080, height: 1920 },
    { id: "1:1", label: "1:1", hint: "Square", width: 1080, height: 1080 },
    { id: "4:5", label: "4:5", hint: "Feed", width: 1080, height: 1350 },
    { id: "4:3", label: "4:3", hint: "Classic", width: 1440, height: 1080 }
  ]);

  var idCounter = 0;
  function newId() {
    idCounter++;
    return "t" + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 6);
  }
  timeline.newId = newId;

  /* ---------------- small numeric helpers ---------------- */

  function num(value, fallback) {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : fallback;
  }
  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }
  /* Timeline positions are kept at millisecond precision so repeated drags do
     not accumulate floating point dust. */
  function tidy(seconds) {
    return Math.round(num(seconds, 0) * 1000) / 1000;
  }
  timeline.tidy = tidy;

  function hex(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "";
  }
  timeline.hex = hex;

  function clipLength(clip) {
    return Math.max(MIN_CLIP, tidy(num(clip.out, 0) - num(clip.in, 0)));
  }
  function clipEnd(clip) {
    return tidy(num(clip.start, 0) + clipLength(clip));
  }
  timeline.clipLength = clipLength;
  timeline.clipEnd = clipEnd;

  function sortClips(track) {
    track.clips.sort(function (a, b) {
      return a.start - b.start;
    });
  }

  /* ---------------- construction and normalising ---------------- */

  function textDefaults() {
    return {
      value: "Your text",
      size: 7, // percent of frame height
      color: "#ffffff",
      align: "center",
      x: 50, // percent of frame width
      y: 82, // percent of frame height
      weight: 700,
      shadow: true,
      background: false,
      backgroundColor: "#000000"
    };
  }
  timeline.textDefaults = textDefaults;

  function animDefaults() {
    return { in: { id: "", d: 0.5 }, out: { id: "", d: 0.5 }, loop: { id: "", d: 2 } };
  }
  timeline.animDefaults = animDefaults;

  function createTrack(kind, name) {
    return {
      id: newId(),
      kind: TRACK_KINDS.indexOf(kind) >= 0 ? kind : "video",
      name: name || "",
      muted: false,
      hidden: false,
      locked: false,
      color: "",
      clips: []
    };
  }
  timeline.createTrack = createTrack;

  function createProject() {
    return {
      width: DEFAULTS.width,
      height: DEFAULTS.height,
      fps: DEFAULTS.fps,
      tracks: [createTrack("video", "Video 1"), createTrack("audio", "Audio 1")]
    };
  }
  timeline.createProject = createProject;

  /* A media clip built from a library entry. `source` carries the identity of
     the file the clip points at; nothing else in this file resolves it. */
  function createMediaClip(source, options) {
    options = options || {};
    var duration = Math.max(MIN_CLIP, num(source.duration, 0) || 5);
    /* A still has no natural length, so it gets a very long source and a short
       default slice — trimming it out is then just an ordinary edge drag. */
    var srcDuration = source.still ? num(source.srcDuration, 3600) : duration;
    return {
      id: newId(),
      sourceItemId: source.itemId,
      sourceFileId: source.fileId,
      srcDuration: tidy(srcDuration),
      start: tidy(options.start || 0),
      in: 0,
      out: tidy(duration),
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      fit: "contain",
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      opacity: 1,
      color: "",
      anim: animDefaults(),
      text: null
    };
  }
  timeline.createMediaClip = createMediaClip;

  function createTextClip(options) {
    options = options || {};
    var length = Math.max(MIN_CLIP, num(options.length, 3));
    var clip = {
      id: newId(),
      sourceItemId: null,
      sourceFileId: null,
      srcDuration: 0,
      start: tidy(options.start || 0),
      in: 0,
      out: tidy(length),
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      fit: "contain",
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      opacity: 1,
      color: "",
      anim: animDefaults(),
      text: textDefaults()
    };
    if (options.value) clip.text.value = options.value;
    return clip;
  }
  timeline.createTextClip = createTextClip;

  function normalizeAnim(clip) {
    var defaults = animDefaults(),
      source = clip.anim && typeof clip.anim === "object" ? clip.anim : {};
    var out = {};
    ["in", "out", "loop"].forEach(function (slot) {
      var value = source[slot] && typeof source[slot] === "object" ? source[slot] : {};
      out[slot] = {
        id: typeof value.id === "string" ? value.id : "",
        d: clamp(num(value.d, defaults[slot].d), 0.05, 10)
      };
    });
    clip.anim = out;
  }

  function normalizeClip(clip, kind) {
    if (!clip || typeof clip !== "object") return null;
    if (!clip.id) clip.id = newId();

    var isText = kind === "text";
    clip.sourceItemId = isText ? null : clip.sourceItemId || null;
    clip.sourceFileId = isText ? null : clip.sourceFileId || null;
    if (!isText && (!clip.sourceItemId || !clip.sourceFileId)) return null;

    clip.srcDuration = Math.max(0, tidy(num(clip.srcDuration, 0)));
    clip.start = Math.max(0, tidy(num(clip.start, 0)));
    clip.in = Math.max(0, tidy(num(clip.in, 0)));
    clip.out = tidy(num(clip.out, clip.in + 1));

    /* A source can come back shorter than it was when the clip was made — for
       instance after a re-upload. Pull the slice back inside the source. */
    if (!isText && clip.srcDuration > 0) {
      clip.in = clamp(clip.in, 0, Math.max(0, clip.srcDuration - MIN_CLIP));
      clip.out = clamp(clip.out, clip.in + MIN_CLIP, clip.srcDuration);
    }
    if (clip.out - clip.in < MIN_CLIP) clip.out = tidy(clip.in + MIN_CLIP);

    clip.volume = clamp(num(clip.volume, 1), 0, 2);
    clip.muted = clip.muted === true;
    var length = clipLength(clip);
    clip.fadeIn = clamp(num(clip.fadeIn, 0), 0, length);
    clip.fadeOut = clamp(num(clip.fadeOut, 0), 0, length);
    clip.fit = clip.fit === "cover" ? "cover" : "contain";
    clip.scale = clamp(num(clip.scale, 1), 0.1, 4);
    clip.offsetX = clamp(num(clip.offsetX, 0), -100, 100);
    clip.offsetY = clamp(num(clip.offsetY, 0), -100, 100);
    clip.opacity = clamp(num(clip.opacity, 1), 0, 1);
    clip.color = hex(clip.color);
    normalizeAnim(clip);

    if (isText) {
      var defaults = textDefaults(),
        text = clip.text && typeof clip.text === "object" ? clip.text : {};
      Object.keys(defaults).forEach(function (key) {
        if (typeof defaults[key] === "number") text[key] = num(text[key], defaults[key]);
        else if (typeof defaults[key] === "boolean") text[key] = text[key] === undefined ? defaults[key] : text[key] === true;
        else if (typeof text[key] !== "string") text[key] = defaults[key];
      });
      text.size = clamp(text.size, 1, 40);
      text.x = clamp(text.x, 0, 100);
      text.y = clamp(text.y, 0, 100);
      text.weight = clamp(Math.round(text.weight / 100) * 100, 300, 900);
      if (["left", "center", "right"].indexOf(text.align) < 0) text.align = "center";
      if (!hex(text.color)) text.color = "#ffffff";
      if (!hex(text.backgroundColor)) text.backgroundColor = "#000000";
      clip.text = text;
    } else {
      clip.text = null;
    }
    return clip;
  }

  /* Removes overlap on a track by nudging later clips forward. Only used while
     normalising data that arrived from elsewhere; interactive edits clamp. */
  function separate(track) {
    sortClips(track);
    var cursor = 0;
    track.clips.forEach(function (clip) {
      if (clip.start < cursor) clip.start = tidy(cursor);
      cursor = clipEnd(clip);
    });
  }

  function normalize(project) {
    if (!project || typeof project !== "object") project = createProject();
    project.width = clamp(Math.round(num(project.width, DEFAULTS.width)), 160, 4096);
    project.height = clamp(Math.round(num(project.height, DEFAULTS.height)), 160, 4096);
    project.fps = clamp(Math.round(num(project.fps, DEFAULTS.fps)), 12, 60);

    if (!Array.isArray(project.tracks)) project.tracks = [];
    project.tracks = project.tracks.filter(function (track) {
      return track && typeof track === "object";
    });
    project.tracks.forEach(function (track, index) {
      if (!track.id) track.id = newId();
      if (TRACK_KINDS.indexOf(track.kind) < 0) track.kind = "video";
      if (typeof track.name !== "string" || !track.name) track.name = trackKindLabel(track.kind) + " " + (index + 1);
      track.muted = track.muted === true;
      track.hidden = track.hidden === true;
      track.locked = track.locked === true;
      track.color = hex(track.color);
      if (!Array.isArray(track.clips)) track.clips = [];
      track.clips = track.clips
        .map(function (clip) {
          return normalizeClip(clip, track.kind);
        })
        .filter(Boolean);
      separate(track);
    });

    /* Always keep at least one video and one audio lane so the editor has
       somewhere to drop the first clip. */
    if (!project.tracks.some(function (t) { return t.kind === "video"; })) project.tracks.unshift(createTrack("video", "Video 1"));
    if (!project.tracks.some(function (t) { return t.kind === "audio"; })) project.tracks.push(createTrack("audio", "Audio 1"));
    return project;
  }
  timeline.normalize = normalize;

  function trackKindLabel(kind) {
    return kind === "audio" ? "Audio" : kind === "text" ? "Text" : "Video";
  }
  timeline.trackKindLabel = trackKindLabel;

  /* ---------------- lookups ---------------- */

  function duration(project) {
    var end = 0;
    (project.tracks || []).forEach(function (track) {
      track.clips.forEach(function (clip) {
        end = Math.max(end, clipEnd(clip));
      });
    });
    return tidy(end);
  }
  timeline.duration = duration;

  function findTrack(project, trackId) {
    return (project.tracks || []).find(function (track) {
      return track.id === trackId;
    }) || null;
  }
  timeline.findTrack = findTrack;

  /* Returns { track, clip, index } so callers can act without re-scanning. */
  function findClip(project, clipId) {
    var found = null;
    (project.tracks || []).forEach(function (track) {
      track.clips.forEach(function (clip, index) {
        if (clip.id === clipId) found = { track: track, clip: clip, index: index };
      });
    });
    return found;
  }
  timeline.findClip = findClip;

  function clipCount(project) {
    return (project.tracks || []).reduce(function (total, track) {
      return total + track.clips.length;
    }, 0);
  }
  timeline.clipCount = clipCount;

  function clipAt(track, time) {
    return track.clips.find(function (clip) {
      return time >= clip.start && time < clipEnd(clip);
    }) || null;
  }
  timeline.clipAt = clipAt;

  /* Everything that should be heard or drawn at `time`, bottom track first. */
  function activeClips(project, time) {
    var active = [];
    (project.tracks || []).forEach(function (track) {
      var clip = clipAt(track, time);
      if (clip) active.push({ track: track, clip: clip });
    });
    return active;
  }
  timeline.activeClips = activeClips;

  /* Where a clip sits within its own slice of the source, at a timeline time. */
  function sourceTimeAt(clip, time) {
    return tidy(num(clip.in, 0) + (time - num(clip.start, 0)));
  }
  timeline.sourceTimeAt = sourceTimeAt;

  /* Volume including fades, so the player does not have to know fade rules. */
  function clipGainAt(clip, time) {
    var offset = time - clip.start,
      length = clipLength(clip),
      gain = clip.muted ? 0 : clamp(num(clip.volume, 1), 0, 2);
    if (clip.fadeIn > 0 && offset < clip.fadeIn) gain *= clamp(offset / clip.fadeIn, 0, 1);
    if (clip.fadeOut > 0 && offset > length - clip.fadeOut) gain *= clamp((length - offset) / clip.fadeOut, 0, 1);
    return gain;
  }
  timeline.clipGainAt = clipGainAt;

  /* ---------------- neighbours and free space ---------------- */

  function neighbours(track, clip) {
    var before = null,
      after = null;
    track.clips.forEach(function (other) {
      if (other === clip) return;
      if (clipEnd(other) <= clip.start + 0.0005) {
        if (!before || clipEnd(other) > clipEnd(before)) before = other;
      } else if (other.start >= clip.start - 0.0005) {
        if (!after || other.start < after.start) after = other;
      }
    });
    return { before: before, after: after };
  }

  /* The window a clip of `length` can occupy on `track` around `wanted`,
     ignoring `skipClip` (the clip being dragged). */
  function freeWindow(track, wanted, length, skipClip) {
    var blockers = track.clips.filter(function (clip) {
      return clip !== skipClip;
    });
    var low = 0,
      high = Infinity;
    blockers.forEach(function (clip) {
      var end = clipEnd(clip);
      if (end <= wanted + 0.0005) low = Math.max(low, end);
    });
    blockers.forEach(function (clip) {
      if (clip.start >= low - 0.0005 && clip.start >= wanted - 0.0005) high = Math.min(high, clip.start);
    });
    if (high - low < length) return null;
    return { low: low, high: high - length };
  }

  /* First position at or after `from` where a clip of `length` fits. */
  function firstFreeStart(track, from, length, skipClip) {
    var blockers = track.clips
      .filter(function (clip) {
        return clip !== skipClip;
      })
      .slice()
      .sort(function (a, b) {
        return a.start - b.start;
      });
    var cursor = Math.max(0, tidy(from));
    for (var i = 0; i < blockers.length; i++) {
      var clip = blockers[i];
      if (clipEnd(clip) <= cursor + 0.0005) continue;
      if (clip.start - cursor >= length - 0.0005) return cursor;
      cursor = clipEnd(clip);
    }
    return cursor;
  }
  timeline.firstFreeStart = firstFreeStart;

  function trackEnd(track) {
    return track.clips.reduce(function (end, clip) {
      return Math.max(end, clipEnd(clip));
    }, 0);
  }
  timeline.trackEnd = trackEnd;

  /* ---------------- snapping ---------------- */

  /* Clip edges and the playhead are magnetic, which is what makes assembling a
     cut by dragging feel accurate without zooming all the way in. */
  function snapPoints(project, skipClipId, playhead) {
    var points = [0];
    if (typeof playhead === "number") points.push(tidy(playhead));
    (project.tracks || []).forEach(function (track) {
      track.clips.forEach(function (clip) {
        if (clip.id === skipClipId) return;
        points.push(tidy(clip.start));
        points.push(clipEnd(clip));
      });
    });
    return points;
  }
  timeline.snapPoints = snapPoints;

  function snapTime(time, points, window) {
    var limit = typeof window === "number" ? window : SNAP_WINDOW,
      best = time,
      bestGap = limit;
    points.forEach(function (point) {
      var gap = Math.abs(point - time);
      if (gap < bestGap) {
        bestGap = gap;
        best = point;
      }
    });
    return tidy(best);
  }
  timeline.snapTime = snapTime;

  /* ---------------- mutations ---------------- */

  function addTrack(project, kind, name) {
    var track = createTrack(kind, name || trackKindLabel(kind) + " " + (countKind(project, kind) + 1));
    /* Video lanes stack upward from the bottom; audio and text sit after them
       so the track list reads video → text → audio top to bottom in the UI. */
    project.tracks.push(track);
    return track;
  }
  timeline.addTrack = addTrack;

  function countKind(project, kind) {
    return (project.tracks || []).filter(function (track) {
      return track.kind === kind;
    }).length;
  }
  timeline.countKind = countKind;

  function removeTrack(project, trackId) {
    var track = findTrack(project, trackId);
    if (!track) return false;
    /* Never leave the project without a lane of a kind the editor relies on. */
    if (countKind(project, track.kind) <= 1 && track.kind !== "text") return false;
    project.tracks = project.tracks.filter(function (other) {
      return other !== track;
    });
    return true;
  }
  timeline.removeTrack = removeTrack;

  /* Moves a track one place through the stack, staying inside its own kind so
     the lane order the editor draws never has to reshuffle categories. */
  function moveTrack(project, trackId, direction) {
    var tracks = project.tracks || [],
      index = tracks.findIndex(function (track) {
        return track.id === trackId;
      });
    if (index < 0) return false;
    var kind = tracks[index].kind,
      step = direction < 0 ? -1 : 1,
      target = index + step;
    while (target >= 0 && target < tracks.length && tracks[target].kind !== kind) target += step;
    if (target < 0 || target >= tracks.length) return false;
    var moved = tracks.splice(index, 1)[0];
    tracks.splice(target, 0, moved);
    return true;
  }
  timeline.moveTrack = moveTrack;

  /* Places `clip` on `track` at the first free slot at or after `start`. */
  function addClip(project, trackId, clip, start) {
    var track = findTrack(project, trackId);
    if (!track) return null;
    clip.start = firstFreeStart(track, typeof start === "number" ? start : trackEnd(track), clipLength(clip), null);
    track.clips.push(clip);
    sortClips(track);
    return clip;
  }
  timeline.addClip = addClip;

  /* Appends to the end of the track, which is what "add to timeline" does. */
  function appendClip(project, trackId, clip) {
    return addClip(project, trackId, clip, trackEnd(findTrack(project, trackId) || { clips: [] }));
  }
  timeline.appendClip = appendClip;

  function removeClip(project, clipId) {
    var hit = findClip(project, clipId);
    if (!hit || hit.track.locked) return false;
    hit.track.clips.splice(hit.index, 1);
    return true;
  }
  timeline.removeClip = removeClip;

  /* Deletes a clip and pulls everything after it on the same track back to
     close the gap — CapCut's delete behaviour. */
  function rippleDelete(project, clipId) {
    var hit = findClip(project, clipId);
    if (!hit || hit.track.locked) return false;
    var length = clipLength(hit.clip),
      from = hit.clip.start;
    hit.track.clips.splice(hit.index, 1);
    hit.track.clips.forEach(function (clip) {
      if (clip.start >= from) clip.start = Math.max(0, tidy(clip.start - length));
    });
    sortClips(hit.track);
    return true;
  }
  timeline.rippleDelete = rippleDelete;

  function duplicateClip(project, clipId) {
    var hit = findClip(project, clipId);
    if (!hit || hit.track.locked) return null;
    var copy = JSON.parse(JSON.stringify(hit.clip));
    copy.id = newId();
    return addClip(project, hit.track.id, copy, clipEnd(hit.clip));
  }
  timeline.duplicateClip = duplicateClip;

  /* Moves a clip, optionally to another track of the same kind. Returns the
     start it actually landed on, clamped to the free space it fits in. */
  function moveClip(project, clipId, targetTrackId, start) {
    var hit = findClip(project, clipId);
    if (!hit || hit.track.locked) return null;
    var target = targetTrackId ? findTrack(project, targetTrackId) : hit.track;
    if (!target || target.kind !== hit.track.kind || target.locked) target = hit.track;

    var clip = hit.clip,
      length = clipLength(clip),
      wanted = Math.max(0, tidy(start));
    var window = freeWindow(target, wanted, length, target === hit.track ? clip : null);
    if (!window) {
      /* The requested spot is taken; fall back to the next opening after it. */
      wanted = firstFreeStart(target, wanted, length, target === hit.track ? clip : null);
    } else {
      wanted = clamp(wanted, window.low, window.high);
    }

    if (target !== hit.track) {
      hit.track.clips.splice(hit.index, 1);
      target.clips.push(clip);
    }
    clip.start = tidy(wanted);
    sortClips(target);
    return clip.start;
  }
  timeline.moveClip = moveClip;

  /* Drags a clip edge. `edge` is "start" or "end"; `time` is the timeline
     position the edge is being dragged to. Both the source bounds and the
     neighbouring clips limit how far it can go. */
  function trimClip(project, clipId, edge, time) {
    var hit = findClip(project, clipId);
    if (!hit || hit.track.locked) return null;
    var clip = hit.clip,
      isText = hit.track.kind === "text",
      around = neighbours(hit.track, clip),
      limitBefore = around.before ? clipEnd(around.before) : 0,
      limitAfter = around.after ? around.after.start : Infinity;

    if (edge === "start") {
      var headroom = isText ? Infinity : clip.in; // source frames available before the cut
      var lowest = Math.max(limitBefore, clip.start - headroom);
      var highest = clipEnd(clip) - MIN_CLIP;
      var newStart = clamp(tidy(time), lowest, highest);
      var shift = newStart - clip.start;
      clip.start = tidy(newStart);
      if (!isText) clip.in = tidy(clip.in + shift);
      else clip.out = tidy(clip.out - shift);
    } else {
      var tail = isText ? Infinity : clip.srcDuration - clip.out; // frames left after the cut
      var maxEnd = Math.min(limitAfter, clipEnd(clip) + tail);
      var minEnd = clip.start + MIN_CLIP;
      var newEnd = clamp(tidy(time), minEnd, maxEnd);
      clip.out = tidy(clip.in + (newEnd - clip.start));
    }

    var length = clipLength(clip);
    clip.fadeIn = clamp(clip.fadeIn, 0, length);
    clip.fadeOut = clamp(clip.fadeOut, 0, length);
    sortClips(hit.track);
    return clip;
  }
  timeline.trimClip = trimClip;

  /* Cuts every clip that straddles `time` in two. When `clipId` is given only
     that clip is cut. Returns how many cuts were made. */
  function splitAt(project, time, clipId) {
    var at = tidy(time),
      cuts = 0;
    (project.tracks || []).forEach(function (track) {
      if (track.locked) return;
      track.clips.slice().forEach(function (clip) {
        if (clipId && clip.id !== clipId) return;
        if (at <= clip.start + MIN_CLIP || at >= clipEnd(clip) - MIN_CLIP) return;
        var tailStart = at - clip.start,
          tail = JSON.parse(JSON.stringify(clip));
        tail.id = newId();
        tail.start = at;
        tail.in = tidy(clip.in + tailStart);
        tail.fadeIn = 0;
        /* An entrance belongs to the head and an exit to the tail, otherwise a
           split makes the animation fire twice in the middle of the cut. */
        tail.anim.in = { id: "", d: tail.anim.in.d };
        clip.anim.out = { id: "", d: clip.anim.out.d };

        clip.out = tidy(clip.in + tailStart);
        clip.fadeOut = 0;
        clip.fadeIn = clamp(clip.fadeIn, 0, clipLength(clip));
        tail.fadeOut = clamp(tail.fadeOut, 0, clipLength(tail));

        track.clips.push(tail);
        cuts++;
      });
      sortClips(track);
    });
    return cuts;
  }
  timeline.splitAt = splitAt;

  /* Drops every clip pointing at a source that no longer exists. `exists` is a
     callback so this file stays independent of how media is stored. */
  function pruneMissingSources(project, exists) {
    var removed = 0;
    (project.tracks || []).forEach(function (track) {
      if (track.kind === "text") return;
      var before = track.clips.length;
      track.clips = track.clips.filter(function (clip) {
        return exists(clip.sourceItemId, clip.sourceFileId);
      });
      removed += before - track.clips.length;
    });
    return removed;
  }
  timeline.pruneMissingSources = pruneMissingSources;

  /* Every distinct source referenced by the project, for preloading. */
  function usedSources(project) {
    var seen = {},
      list = [];
    (project.tracks || []).forEach(function (track) {
      track.clips.forEach(function (clip) {
        if (!clip.sourceItemId || !clip.sourceFileId) return;
        var key = clip.sourceItemId + "/" + clip.sourceFileId;
        if (seen[key]) return;
        seen[key] = true;
        list.push({ itemId: clip.sourceItemId, fileId: clip.sourceFileId, key: key });
      });
    });
    return list;
  }
  timeline.usedSources = usedSources;

  /* ---------------- frame size ---------------- */

  function aspectOf(project) {
    var ratio = project.width / project.height,
      best = null,
      bestGap = Infinity;
    ASPECTS.forEach(function (aspect) {
      var gap = Math.abs(aspect.width / aspect.height - ratio);
      if (gap < bestGap) {
        bestGap = gap;
        best = aspect;
      }
    });
    return bestGap < 0.02 ? best : null;
  }
  timeline.aspectOf = aspectOf;

  function setAspect(project, aspectId) {
    var aspect = ASPECTS.filter(function (candidate) {
      return candidate.id === aspectId;
    })[0];
    if (!aspect) return false;
    project.width = aspect.width;
    project.height = aspect.height;
    return true;
  }
  timeline.setAspect = setAspect;

  function formatTime(seconds, withFrames, fps) {
    seconds = Math.max(0, num(seconds, 0));
    var whole = Math.floor(seconds),
      minutes = Math.floor(whole / 60),
      rest = whole % 60,
      text = minutes + ":" + (rest < 10 ? "0" : "") + rest;
    if (!withFrames) return text;
    var frames = Math.floor((seconds - whole) * (fps || DEFAULTS.fps));
    return text + "." + (frames < 10 ? "0" : "") + frames;
  }
  timeline.formatTime = formatTime;
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
