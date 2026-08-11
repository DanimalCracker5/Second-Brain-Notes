/*
  Second Brain — video/player.js

  Plays a timeline project and renders it to a canvas, and records that same
  canvas to produce an exported file.

  How playback works
  ------------------
  The playhead is driven by the wall clock, not by any one media element. Every
  frame the engine looks at where the playhead is, asks the timeline which clip
  is active on each track, nudges that clip's media element to the matching
  source time, and composites the result onto the canvas. Because the clock is
  independent, gaps between clips and clips of different frame rates all behave
  the same way.

  Media elements are created lazily for clips near the playhead and released
  once they are far away, so a long timeline does not hold dozens of video
  decoders open at once.

  How export works
  ----------------
  There is no server and no ffmpeg here, so export is a real-time recording of
  the preview: canvas.captureStream() for the picture, a Web Audio mix for the
  sound, and MediaRecorder to write the file. A three minute cut takes about
  three minutes to export. That is the trade-off for a static site with no
  render backend.

  The canvas must stay untainted for captureStream() to work, which means every
  source has to be either a blob: URL from the device cache or a cloud URL
  served with CORS headers. video/media.js handles that; this file surfaces the
  error when it has not been arranged.
*/
(function (ns) {
  "use strict";

  var player = (ns.player = ns.player || {});

  var SEEK_TOLERANCE = 0.18; // seconds of drift before forcing a seek
  var PRELOAD_AHEAD = 6; // seconds of timeline to keep loaded ahead of the playhead
  var PRELOAD_BEHIND = 2;
  var RELEASE_AHEAD = 24;
  var RELEASE_BEHIND = 10;
  var SETTLE_MS = 700; // how long to keep drawing after a change while paused

  var EXPORT_TYPES = [
    { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { mime: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mime: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mime: "video/webm", extension: "webm" }
  ];

  function pickExportType() {
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < EXPORT_TYPES.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(EXPORT_TYPES[i].mime)) return EXPORT_TYPES[i];
      } catch (e) {}
    }
    return { mime: "", extension: "webm" };
  }
  player.pickExportType = pickExportType;
  player.canExport = function () {
    return !!(window.MediaRecorder && document.createElement("canvas").captureStream);
  };

  /*
    create(options)
      options.getProject()          -> the normalized project to play
      options.resolve(clip)         -> Promise<{url, crossOrigin}> for a clip's source
      options.onTick(time, playing) -> called every drawn frame
      options.onError(message)      -> user-facing problem, called at most once per cause
  */
  player.create = function (options) {
    var getProject = options.getProject,
      resolve = options.resolve,
      hostTick = options.onTick || function () {},
      onError = options.onError || function () {};

    /* Set by exportVideo() while a recording is running, cleared when the last
       frame has been captured. Sits alongside the host's own tick callback. */
    var exportWatcher = null;
    function onTick(time, isPlaying) {
      if (exportWatcher) exportWatcher(time);
      hostTick(time, isPlaying);
    }

    var canvas = document.createElement("canvas");
    canvas.className = "ve-canvas";
    var context = canvas.getContext("2d");

    var playhead = 0,
      playing = false,
      destroyed = false,
      frameHandle = null,
      lastFrameAt = 0,
      settleUntil = 0,
      exporting = false;

    /* clipId -> { element, clip, state:"loading"|"ready"|"failed", gain } */
    var pool = {};
    var reportedErrors = {};

    /* ---------------- audio graph ---------------- */

    var audioContext = null,
      masterGain = null,
      exportDestination = null;

    function ensureAudio() {
      if (audioContext) return audioContext;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        audioContext = new Ctor();
        masterGain = audioContext.createGain();
        masterGain.connect(audioContext.destination);
      } catch (e) {
        console.warn("Audio mixing is unavailable:", e);
        audioContext = null;
      }
      return audioContext;
    }

    /* A media element can only ever have one MediaElementAudioSourceNode, so
       the node is stashed on the element and reused. */
    function routeAudio(entry) {
      var ctx = ensureAudio();
      if (!ctx || entry.routed) return;
      try {
        var source = ctx.createMediaElementSource(entry.element),
          gain = ctx.createGain();
        source.connect(gain);
        gain.connect(masterGain);
        if (exportDestination) gain.connect(exportDestination);
        entry.gainNode = gain;
        entry.routed = true;
        entry.element.volume = 1;
      } catch (e) {
        /* Fall back to element volume — export audio may be missing but
           playback still works. */
        entry.routed = false;
      }
    }

    function setGain(entry, value) {
      var level = Math.max(0, Math.min(2, value));
      if (entry.routed && entry.gainNode) {
        if (Math.abs(entry.gainNode.gain.value - level) > 0.001) entry.gainNode.gain.value = level;
      } else {
        var clamped = Math.min(1, level);
        if (Math.abs(entry.element.volume - clamped) > 0.001) entry.element.volume = clamped;
      }
    }

    /* ---------------- media element pool ---------------- */

    function reportOnce(key, message) {
      if (reportedErrors[key]) return;
      reportedErrors[key] = true;
      onError(message);
    }

    /*
      The element is only built once the source has resolved, because a still
      image needs an <img> and everything else needs a media element — and the
      difference is not known until media.js has looked the file up.
    */
    function createEntry(clip, kind) {
      var entry = { element: null, clip: clip, state: "loading", routed: false, gainNode: null, kind: kind, still: false };
      pool[clip.id] = entry;

      function loadFailed(source) {
        entry.state = "failed";
        reportOnce(
          source.crossOrigin ? "cors" : "load",
          source.crossOrigin
            ? "This clip is only in the cloud and the browser blocked it. Cache it on this device, or set up Cloud Storage CORS — see video/README.md."
            : "A clip could not be decoded in this browser."
        );
      }

      resolve(clip)
        .then(function (source) {
          if (destroyed || pool[clip.id] !== entry) return;

          if (source.still) {
            var image = new Image();
            entry.still = true;
            /* crossOrigin has to be set before src or the canvas gets tainted. */
            if (source.crossOrigin) image.crossOrigin = "anonymous";
            image.onload = function () {
              entry.state = "ready";
              wake();
            };
            image.onerror = function () {
              loadFailed(source);
            };
            entry.element = image;
            image.src = source.url;
            return;
          }

          var element = document.createElement(kind === "audio" ? "audio" : "video");
          element.preload = "auto";
          element.playsInline = true;
          element.setAttribute("playsinline", "");
          element.muted = false;
          element.volume = 1;
          element.loop = false;
          /* Kept out of the layout; the picture is only ever read via drawImage. */
          element.style.display = "none";
          if (source.crossOrigin) element.crossOrigin = "anonymous";
          element.onloadeddata = function () {
            entry.state = "ready";
            routeAudio(entry);
            wake();
          };
          element.onerror = function () {
            loadFailed(source);
          };
          entry.element = element;
          element.src = source.url;
          try {
            element.load();
          } catch (e) {}
        })
        .catch(function (error) {
          if (destroyed || pool[clip.id] !== entry) return;
          entry.state = "failed";
          reportOnce("missing", error && error.message ? error.message : "A clip's file is missing.");
        });

      return entry;
    }

    function releaseEntry(clipId) {
      var entry = pool[clipId];
      if (!entry) return;
      delete pool[clipId];
      if (entry.gainNode) {
        try {
          entry.gainNode.disconnect();
        } catch (e) {}
      }
      if (!entry.element) return;
      if (entry.still) {
        entry.element.src = "";
        return;
      }
      try {
        entry.element.pause();
      } catch (e) {}
      entry.element.removeAttribute("src");
      try {
        entry.element.load();
      } catch (e) {}
    }

    /* Builds elements for clips coming up and frees the ones left behind.
       During export nothing is released — a mid-record reload would show as a
       black frame in the finished file. */
    function syncPool(project) {
      var wanted = {};
      (project.tracks || []).forEach(function (track) {
        if (track.kind === "text") return;
        track.clips.forEach(function (clip) {
          var start = clip.start,
            end = ns.timeline.clipEnd(clip);
          var near = exporting || (end > playhead - PRELOAD_BEHIND && start < playhead + PRELOAD_AHEAD);
          if (!near) return;
          wanted[clip.id] = true;
          if (!pool[clip.id]) createEntry(clip, track.kind);
          else pool[clip.id].clip = clip; // the clip object is replaced on edits
        });
      });
      if (exporting) return;
      Object.keys(pool).forEach(function (clipId) {
        if (wanted[clipId]) return;
        var clip = pool[clipId].clip,
          end = ns.timeline.clipEnd(clip);
        if (end < playhead - RELEASE_BEHIND || clip.start > playhead + RELEASE_AHEAD) releaseEntry(clipId);
      });
    }

    /* ---------------- drawing ---------------- */

    /*
      Runs `draw` with the frame transformed the way the clip's animations ask
      for. Rotation and scale happen around the centre of the frame, then the
      whole thing is offset — that is what makes "slide in from the right" and
      "zoom in" compose sensibly when both are set.
    */
    function withTransform(transform, opacity, draw) {
      var alpha = Math.max(0, Math.min(1, transform.opacity * opacity));
      if (alpha <= 0.002) return;
      var moved = transform.dx !== 0 || transform.dy !== 0 || transform.rotate !== 0 || transform.scale !== 1;
      if (alpha >= 0.999 && !moved) return draw();

      context.save();
      context.globalAlpha = alpha;
      if (moved) {
        context.translate(canvas.width / 2 + transform.dx * canvas.width, canvas.height / 2 + transform.dy * canvas.height);
        if (transform.rotate) context.rotate(transform.rotate);
        if (transform.scale !== 1) context.scale(transform.scale, transform.scale);
        context.translate(-canvas.width / 2, -canvas.height / 2);
      }
      draw();
      context.restore();
    }

    function sourceSize(entry) {
      var element = entry.element;
      if (!element) return null;
      var width = entry.still ? element.naturalWidth : element.videoWidth,
        height = entry.still ? element.naturalHeight : element.videoHeight;
      return width && height ? { width: width, height: height } : null;
    }

    function drawVideoClip(entry, clip) {
      var element = entry.element,
        size = entry.state === "ready" && sourceSize(entry);
      if (!size) return;

      var frameWidth = canvas.width,
        frameHeight = canvas.height,
        sourceRatio = size.width / size.height,
        frameRatio = frameWidth / frameHeight,
        width,
        height;

      if (clip.fit === "cover" ? sourceRatio < frameRatio : sourceRatio > frameRatio) {
        width = frameWidth;
        height = frameWidth / sourceRatio;
      } else {
        height = frameHeight;
        width = frameHeight * sourceRatio;
      }
      width *= clip.scale || 1;
      height *= clip.scale || 1;

      var x = (frameWidth - width) / 2 + ((clip.offsetX || 0) / 100) * frameWidth,
        y = (frameHeight - height) / 2 + ((clip.offsetY || 0) / 100) * frameHeight;

      try {
        context.drawImage(element, x, y, width, height);
      } catch (e) {
        /* A frame that is not decodable yet simply is not drawn. */
      }
    }

    /* The backing plate is drawn at a fixed transparency so the text stays
       readable over any footage; only its hue is the user's choice. */
    function plateColor(value) {
      var match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value || "");
      if (!match) return "rgba(0,0,0,.55)";
      return "rgba(" + parseInt(match[1], 16) + "," + parseInt(match[2], 16) + "," + parseInt(match[3], 16) + ",.62)";
    }

    function drawTextClip(clip) {
      var text = clip.text;
      if (!text || !text.value) return;
      var fontSize = (text.size / 100) * canvas.height * (clip.scale || 1),
        lines = String(text.value).split("\n"),
        lineHeight = fontSize * 1.25,
        x = (text.x / 100) * canvas.width,
        top = (text.y / 100) * canvas.height - ((lines.length - 1) * lineHeight) / 2;

      context.save();
      context.font = (text.weight || 700) + " " + Math.round(fontSize) + 'px "DM Sans", system-ui, sans-serif';
      context.textAlign = text.align || "center";
      context.textBaseline = "middle";

      if (text.background) {
        var widest = 0;
        lines.forEach(function (line) {
          widest = Math.max(widest, context.measureText(line).width);
        });
        var padding = fontSize * 0.35,
          boxWidth = widest + padding * 2,
          boxHeight = lines.length * lineHeight + padding,
          boxX = text.align === "left" ? x - padding : text.align === "right" ? x - boxWidth + padding : x - boxWidth / 2;
        context.fillStyle = plateColor(text.backgroundColor);
        context.fillRect(boxX, top - lineHeight / 2 - padding / 2, boxWidth, boxHeight);
      }
      if (text.shadow) {
        context.shadowColor = "rgba(0,0,0,.75)";
        context.shadowBlur = fontSize * 0.18;
        context.shadowOffsetY = fontSize * 0.05;
      }
      context.fillStyle = text.color || "#ffffff";
      lines.forEach(function (line, index) {
        context.fillText(line, x, top + index * lineHeight);
      });
      context.restore();
    }

    function drawFrame(project) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      /* Track order is bottom-up, so later tracks paint over earlier ones. */
      (project.tracks || []).forEach(function (track) {
        if (track.hidden) return;
        var clip = ns.timeline.clipAt(track, playhead);
        if (!clip) return;
        if (track.kind !== "video" && track.kind !== "text") return;

        var length = ns.timeline.clipLength(clip),
          local = playhead - clip.start,
          transform = ns.animations ? ns.animations.transformFor(clip, local, length) : { opacity: 1, scale: 1, dx: 0, dy: 0, rotate: 0 };

        withTransform(transform, typeof clip.opacity === "number" ? clip.opacity : 1, function () {
          if (track.kind === "video") {
            var entry = pool[clip.id];
            if (entry) drawVideoClip(entry, clip);
          } else {
            drawTextClip(clip);
          }
        });
      });
    }

    /* ---------------- the frame loop ---------------- */

    function syncMedia(project) {
      var activeIds = {};
      (project.tracks || []).forEach(function (track) {
        if (track.kind === "text") return;
        var clip = ns.timeline.clipAt(track, playhead);
        if (!clip) return;
        activeIds[clip.id] = true;
        var entry = pool[clip.id];
        if (!entry || entry.state !== "ready" || !entry.element || entry.still) return;

        var element = entry.element,
          target = ns.timeline.sourceTimeAt(clip, playhead);
        if (Math.abs(element.currentTime - target) > SEEK_TOLERANCE && !element.seeking) {
          try {
            element.currentTime = target;
          } catch (e) {}
        }
        var gain = ns.timeline.clipGainAt(clip, playhead) * (track.muted || track.hidden ? 0 : 1);
        setGain(entry, gain);

        if (playing && element.paused) {
          var attempt = element.play();
          if (attempt && attempt.catch) attempt.catch(function () {});
        } else if (!playing && !element.paused) {
          element.pause();
        }
      });

      /* Anything not on screen right now must be silent. */
      Object.keys(pool).forEach(function (clipId) {
        if (activeIds[clipId]) return;
        var entry = pool[clipId];
        if (!entry.element || entry.still) return;
        if (!entry.element.paused) entry.element.pause();
      });
    }

    function frame(now) {
      frameHandle = null;
      if (destroyed) return;
      var project = getProject();
      if (!project) return;

      var total = ns.timeline.duration(project);
      if (playing) {
        var delta = lastFrameAt ? (now - lastFrameAt) / 1000 : 0;
        playhead = Math.min(total, playhead + Math.max(0, Math.min(0.5, delta)));
        if (playhead >= total - 0.0005) {
          playhead = total;
          playing = false;
          settleUntil = now + SETTLE_MS;
        }
      }
      lastFrameAt = now;

      syncPool(project);
      syncMedia(project);
      drawFrame(project);
      onTick(playhead, playing);

      if (playing || now < settleUntil) schedule();
      else lastFrameAt = 0;
    }

    function schedule() {
      if (frameHandle || destroyed) return;
      frameHandle = requestAnimationFrame(frame);
    }

    /* Keeps drawing for a moment so a seek or an edit shows up even while
       paused, without leaving requestAnimationFrame running forever. */
    function wake(extraMs) {
      settleUntil = Math.max(settleUntil, performance.now() + (extraMs || SETTLE_MS));
      schedule();
    }

    /* ---------------- public surface ---------------- */

    var api = {
      canvas: canvas,

      /* Sizes the backing store. Preview stays modest on small screens; export
         swaps in the full resolution just before recording. */
      setResolution: function (width, height) {
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        wake();
      },

      projectChanged: function () {
        var project = getProject();
        if (project) {
          var total = ns.timeline.duration(project);
          if (playhead > total) playhead = total;
          syncPool(project);
        }
        wake();
      },

      time: function () {
        return playhead;
      },
      isPlaying: function () {
        return playing;
      },

      seek: function (time) {
        var project = getProject(),
          total = project ? ns.timeline.duration(project) : 0;
        playhead = Math.max(0, Math.min(total, time));
        wake();
      },

      play: function () {
        var project = getProject();
        if (!project) return;
        var total = ns.timeline.duration(project);
        if (total <= 0) return;
        if (playhead >= total - 0.0005) playhead = 0;
        var ctx = ensureAudio();
        if (ctx && ctx.state === "suspended") ctx.resume();
        playing = true;
        lastFrameAt = 0;
        schedule();
      },

      pause: function () {
        playing = false;
        wake();
      },

      toggle: function () {
        if (playing) api.pause();
        else api.play();
      },

      /* Waits until every clip in the project has loaded, used before export so
         the recording does not start on black frames. */
      preloadAll: function (timeoutMs) {
        var project = getProject();
        if (!project) return Promise.resolve();
        exporting = true; // stop the windowing from releasing anything
        syncPool(project);
        var deadline = Date.now() + (timeoutMs || 60000);
        return new Promise(function (done) {
          (function check() {
            var pending = Object.keys(pool).filter(function (clipId) {
              return pool[clipId].state === "loading";
            });
            if (!pending.length || Date.now() > deadline) return done();
            setTimeout(check, 150);
          })();
        });
      },

      /*
        Records the timeline in real time and resolves with the finished file.

        options.width / options.height  export resolution
        options.fps                     frame rate to capture at
        options.onProgress(fraction)    called as the playhead advances
      */
      exportVideo: function (options) {
        options = options || {};
        var project = getProject();
        if (!project) return Promise.reject(new Error("Nothing to export"));
        var total = ns.timeline.duration(project);
        if (total <= 0) return Promise.reject(new Error("The timeline is empty"));
        if (!player.canExport()) return Promise.reject(new Error("This browser cannot record video"));

        var type = pickExportType(),
          fps = options.fps || project.fps || 30,
          previousWidth = canvas.width,
          previousHeight = canvas.height;

        api.pause();
        api.seek(0);
        canvas.width = options.width || project.width;
        canvas.height = options.height || project.height;

        /*
          The audio track has to be *flowing* before recording starts. A
          MediaStreamDestination fed by a suspended AudioContext emits nothing,
          and a muxer given a permanently silent track can write a zero-byte
          file — so wait for the context to actually reach "running", and if it
          never does, record video only rather than risk an empty export.
        */
        function prepareAudio() {
          var ctx = ensureAudio();
          if (!ctx) return Promise.resolve(false);
          var resumed = ctx.state === "running" || !ctx.resume ? Promise.resolve() : ctx.resume().catch(function () {});
          return resumed.then(function () {
            if (ctx.state !== "running") return false;
            exportDestination = ctx.createMediaStreamDestination();
            /* Route what is already loaded; clips loaded later pick this up in
               routeAudio(). */
            Object.keys(pool).forEach(function (clipId) {
              var entry = pool[clipId];
              if (entry.gainNode) {
                try {
                  entry.gainNode.connect(exportDestination);
                } catch (e) {}
              }
            });
            return true;
          });
        }

        function restore() {
          exporting = false;
          if (exportDestination) {
            Object.keys(pool).forEach(function (clipId) {
              var entry = pool[clipId];
              if (!entry.gainNode) return;
              try {
                entry.gainNode.disconnect(exportDestination);
              } catch (e) {}
            });
            exportDestination = null;
          }
          canvas.width = previousWidth;
          canvas.height = previousHeight;
          wake();
        }

        return api
          .preloadAll(90000)
          .then(prepareAudio)
          .then(function () {
            return new Promise(function (settle, fail) {
              var stream;
              try {
                stream = canvas.captureStream(fps);
              } catch (error) {
                throw new Error(
                  "Export is blocked because a clip is loaded from the cloud without CORS headers. Cache the clips on this device, or set up Cloud Storage CORS — see video/README.md."
                );
              }
              if (exportDestination) {
                exportDestination.stream.getAudioTracks().forEach(function (track) {
                  stream.addTrack(track);
                });
              }

              var pixels = canvas.width * canvas.height,
                recorder;
              try {
                recorder = new MediaRecorder(
                  stream,
                  type.mime
                    ? { mimeType: type.mime, videoBitsPerSecond: Math.round(pixels * fps * 0.09), audioBitsPerSecond: 160000 }
                    : {}
                );
              } catch (error) {
                recorder = new MediaRecorder(stream);
              }

              var chunks = [],
                finished = false,
                watchdog = null;

              function done(error, result) {
                if (finished) return;
                finished = true;
                exportWatcher = null;
                clearInterval(watchdog);
                api.pause();
                if (recorder.state === "recording") {
                  try {
                    recorder.stop();
                  } catch (e) {}
                }
                if (error) fail(error);
                else settle(result);
              }

              recorder.ondataavailable = function (event) {
                if (event.data && event.data.size) chunks.push(event.data);
              };
              recorder.onerror = function (event) {
                done((event && event.error) || new Error("Recording failed"));
              };
              recorder.onstop = function () {
                var blob = new Blob(chunks, { type: type.mime || "video/webm" });
                /* A zero-byte result means the recorder never got usable frames.
                   Failing loudly is much better than handing over a broken file. */
                if (!blob.size) return done(new Error("The recording came out empty. Keep this tab in the foreground and try again."));
                done(null, { blob: blob, extension: type.extension, mime: type.mime || "video/webm" });
              };

              /* The export watcher rides on the normal tick callback so it sees
                 exactly the frames that were drawn. */
              exportWatcher = function (time) {
                if (options.onProgress) options.onProgress(Math.min(1, time / total));
                if (time >= total - 0.0005 && recorder.state === "recording") {
                  /* One extra beat so the last frame lands in the file. */
                  setTimeout(function () {
                    if (recorder.state === "recording") recorder.stop();
                  }, 250);
                  exportWatcher = null;
                }
              };

              recorder.start(1000);
              exporting = true;
              api.play();

              /* Browsers stop firing requestAnimationFrame in a background tab,
                 which freezes the playhead and would otherwise leave the export
                 hanging forever. Notice it and say what went wrong. */
              var lastSeen = api.time();
              watchdog = setInterval(function () {
                var now = api.time();
                if (now - lastSeen < 0.25 && now < total - 0.0005) {
                  done(new Error("Export stalled because this tab lost focus. Keep it in the foreground for the whole recording."));
                  return;
                }
                lastSeen = now;
              }, 2500);
            });
          })
          .then(function (result) {
            restore();
            return result;
          })
          .catch(function (error) {
            restore();
            throw error;
          });
      },

      clearErrors: function () {
        reportedErrors = {};
      },

      destroy: function () {
        destroyed = true;
        playing = false;
        if (frameHandle) cancelAnimationFrame(frameHandle);
        Object.keys(pool).forEach(releaseEntry);
        if (audioContext && audioContext.state !== "closed") {
          try {
            audioContext.close();
          } catch (e) {}
        }
        audioContext = null;
      }
    };

    api.setResolution(640, 360);
    return api;
  };
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
