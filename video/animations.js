/*
  Second Brain — video/animations.js

  The animation registry. Like video/timeline.js this file is pure: it holds no
  DOM and no app state, it just turns "which animation, how far through it are
  we" into a transform the player applies while drawing a clip.

  Adding an animation
  -------------------
  One call, anywhere after this file has loaded:

      SecondBrainVideo.animations.register({
        id: "drop-in",              // stored in the project, never change it
        label: "Drop in",
        kind: "in",                 // "in" | "out" | "loop"
        defaultDuration: 0.6,
        apply: function (p, t) {    // p = 0..1, t = the transform being built
          t.dy -= (1 - p) * 0.35;   // fractions of the frame
          t.opacity *= p;
        }
      });

  It immediately appears in the editor's Animation sheet and starts working in
  the preview and in exports. Nothing else has to change — the id is stored as a
  plain string in the project, and an id this build does not know is simply
  ignored, so a project made on a newer build still opens here.

  The transform
  -------------
      { opacity, scale, dx, dy, rotate }

  dx / dy are fractions of the frame (0.5 = half a frame across), rotate is in
  radians, scale multiplies. `apply` receives it half-built and mutates it, so
  an entrance, an exit and a loop can all run at once and compose.

  Progress
  --------
    kind "in"    p runs 0 -> 1 over `duration` seconds from the clip's start.
                 p = 1 must be the untouched frame.
    kind "out"   p runs 0 -> 1 over the `duration` seconds ending at the clip's
                 end. p = 0 must be the untouched frame.
    kind "loop"  p cycles 0 -> 1 every `duration` seconds for the whole clip.
*/
(function (ns) {
  "use strict";

  var animations = (ns.animations = ns.animations || {});

  var registry = {};
  var order = [];

  function clamp01(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  /* ---------------- easings ---------------- */

  var ease = (animations.ease = {
    linear: function (p) {
      return p;
    },
    out: function (p) {
      return 1 - Math.pow(1 - p, 3);
    },
    inOut: function (p) {
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    },
    back: function (p) {
      var c = 1.70158 + 1;
      return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
    },
    elastic: function (p) {
      if (p === 0 || p === 1) return p;
      return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
    sine: function (p) {
      return Math.sin(p * Math.PI * 2);
    }
  });

  /* ---------------- registry ---------------- */

  function register(def) {
    if (!def || !def.id || typeof def.apply !== "function") return null;
    var entry = {
      id: def.id,
      label: def.label || def.id,
      kind: def.kind === "out" ? "out" : def.kind === "loop" ? "loop" : "in",
      group: def.group || "",
      defaultDuration: typeof def.defaultDuration === "number" ? def.defaultDuration : 0.6,
      minDuration: typeof def.minDuration === "number" ? def.minDuration : 0.1,
      maxDuration: typeof def.maxDuration === "number" ? def.maxDuration : 4,
      apply: def.apply
    };
    if (!registry[entry.id]) order.push(entry.id);
    registry[entry.id] = entry;
    return entry;
  }
  animations.register = register;

  animations.get = function (id) {
    return (id && registry[id]) || null;
  };

  /* Everything of one kind, in registration order, with a "None" entry first so
     the editor can render one flat list of choices. */
  animations.list = function (kind) {
    var list = [{ id: "", label: "None", kind: kind, defaultDuration: 0.5, minDuration: 0.1, maxDuration: 4 }];
    order.forEach(function (id) {
      if (!kind || registry[id].kind === kind) list.push(registry[id]);
    });
    return list;
  };

  animations.count = function () {
    return order.length;
  };

  /* A short human summary of what a clip has on it, for the editor's rail. */
  animations.summary = function (clip) {
    var anim = (clip && clip.anim) || {},
      names = [];
    ["in", "out", "loop"].forEach(function (slot) {
      var def = animations.get(anim[slot] && anim[slot].id);
      if (def) names.push(def.label);
    });
    return names.join(" · ");
  };

  /* ---------------- evaluation ---------------- */

  function identity() {
    return { opacity: 1, scale: 1, dx: 0, dy: 0, rotate: 0 };
  }
  animations.identity = identity;

  /*
    The transform for `clip` at `localTime` seconds into it. `length` is the
    clip's length on the timeline. Safe to call for every frame of every clip:
    with no animations set it returns the identity transform without allocating
    anything beyond the object itself.
  */
  function transformFor(clip, localTime, length) {
    var transform = identity(),
      anim = clip && clip.anim;
    if (!anim) return transform;

    var entrance = animations.get(anim.in && anim.in.id);
    if (entrance) {
      var inDuration = Math.max(0.05, Math.min(anim.in.d || entrance.defaultDuration, length));
      var p = clamp01(localTime / inDuration);
      if (p < 1) entrance.apply(p, transform);
    }

    var exit = animations.get(anim.out && anim.out.id);
    if (exit) {
      var outDuration = Math.max(0.05, Math.min(anim.out.d || exit.defaultDuration, length));
      var since = localTime - (length - outDuration);
      if (since > 0) exit.apply(clamp01(since / outDuration), transform);
    }

    var loop = animations.get(anim.loop && anim.loop.id);
    if (loop) {
      var period = Math.max(0.1, anim.loop.d || loop.defaultDuration);
      loop.apply((localTime % period) / period, transform, localTime, length);
    }

    return transform;
  }
  animations.transformFor = transformFor;

  /* =====================================================================
     The built-in library

     Keep these small and composable. Anything fancier is better as a new
     registration than as a special case inside the player.
     ===================================================================== */

  /* --- entrances --- */

  register({
    id: "fade-in",
    label: "Fade in",
    kind: "in",
    group: "Basic",
    defaultDuration: 0.5,
    apply: function (p, t) {
      t.opacity *= p;
    }
  });

  register({
    id: "zoom-in",
    label: "Zoom in",
    kind: "in",
    group: "Basic",
    defaultDuration: 0.6,
    apply: function (p, t) {
      var e = ease.out(p);
      t.scale *= 0.65 + 0.35 * e;
      t.opacity *= Math.min(1, p * 1.6);
    }
  });

  register({
    id: "zoom-out-in",
    label: "Punch in",
    kind: "in",
    group: "Basic",
    defaultDuration: 0.6,
    apply: function (p, t) {
      var e = ease.out(p);
      t.scale *= 1.35 - 0.35 * e;
      t.opacity *= Math.min(1, p * 1.6);
    }
  });

  register({
    id: "slide-left",
    label: "Slide from right",
    kind: "in",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dx += (1 - ease.out(p)) * 0.6;
      t.opacity *= Math.min(1, p * 2);
    }
  });

  register({
    id: "slide-right",
    label: "Slide from left",
    kind: "in",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dx -= (1 - ease.out(p)) * 0.6;
      t.opacity *= Math.min(1, p * 2);
    }
  });

  register({
    id: "slide-up",
    label: "Rise up",
    kind: "in",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dy += (1 - ease.out(p)) * 0.4;
      t.opacity *= Math.min(1, p * 2);
    }
  });

  register({
    id: "slide-down",
    label: "Drop down",
    kind: "in",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dy -= (1 - ease.out(p)) * 0.4;
      t.opacity *= Math.min(1, p * 2);
    }
  });

  register({
    id: "pop-in",
    label: "Pop",
    kind: "in",
    group: "Energetic",
    defaultDuration: 0.5,
    apply: function (p, t) {
      t.scale *= 0.3 + 0.7 * ease.back(p);
      t.opacity *= Math.min(1, p * 2.5);
    }
  });

  register({
    id: "spin-in",
    label: "Spin in",
    kind: "in",
    group: "Energetic",
    defaultDuration: 0.7,
    apply: function (p, t) {
      var e = ease.out(p);
      t.rotate -= (1 - e) * Math.PI * 0.5;
      t.scale *= 0.5 + 0.5 * e;
      t.opacity *= Math.min(1, p * 2);
    }
  });

  register({
    id: "bounce-in",
    label: "Bounce in",
    kind: "in",
    group: "Energetic",
    defaultDuration: 0.9,
    apply: function (p, t) {
      t.scale *= 0.4 + 0.6 * ease.elastic(p);
      t.opacity *= Math.min(1, p * 3);
    }
  });

  /* --- exits --- */

  register({
    id: "fade-out",
    label: "Fade out",
    kind: "out",
    group: "Basic",
    defaultDuration: 0.5,
    apply: function (p, t) {
      t.opacity *= 1 - p;
    }
  });

  register({
    id: "zoom-out",
    label: "Zoom out",
    kind: "out",
    group: "Basic",
    defaultDuration: 0.6,
    apply: function (p, t) {
      t.scale *= 1 - 0.35 * ease.inOut(p);
      t.opacity *= 1 - p;
    }
  });

  register({
    id: "zoom-in-out",
    label: "Punch out",
    kind: "out",
    group: "Basic",
    defaultDuration: 0.6,
    apply: function (p, t) {
      t.scale *= 1 + 0.4 * ease.inOut(p);
      t.opacity *= 1 - p;
    }
  });

  register({
    id: "slide-out-left",
    label: "Slide off left",
    kind: "out",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dx -= ease.inOut(p) * 0.7;
      t.opacity *= 1 - Math.max(0, p - 0.5) * 2;
    }
  });

  register({
    id: "slide-out-right",
    label: "Slide off right",
    kind: "out",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dx += ease.inOut(p) * 0.7;
      t.opacity *= 1 - Math.max(0, p - 0.5) * 2;
    }
  });

  register({
    id: "slide-out-up",
    label: "Slide off top",
    kind: "out",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dy -= ease.inOut(p) * 0.5;
      t.opacity *= 1 - Math.max(0, p - 0.5) * 2;
    }
  });

  register({
    id: "slide-out-down",
    label: "Slide off bottom",
    kind: "out",
    group: "Slide",
    defaultDuration: 0.55,
    apply: function (p, t) {
      t.dy += ease.inOut(p) * 0.5;
      t.opacity *= 1 - Math.max(0, p - 0.5) * 2;
    }
  });

  register({
    id: "spin-out",
    label: "Spin out",
    kind: "out",
    group: "Energetic",
    defaultDuration: 0.7,
    apply: function (p, t) {
      var e = ease.inOut(p);
      t.rotate += e * Math.PI * 0.5;
      t.scale *= 1 - 0.5 * e;
      t.opacity *= 1 - p;
    }
  });

  /* --- loops --- */

  register({
    id: "ken-burns",
    label: "Ken Burns",
    kind: "loop",
    group: "Camera",
    defaultDuration: 12,
    minDuration: 2,
    maxDuration: 60,
    /* A slow push that never resets, so it reads as a camera move rather than a
       loop. `elapsed` is the real time into the clip. */
    apply: function (p, t, elapsed, length) {
      var travel = Math.min(1, elapsed / Math.max(0.1, length));
      t.scale *= 1 + 0.14 * travel;
      t.dx += 0.02 * travel;
    }
  });

  register({
    id: "pulse",
    label: "Pulse",
    kind: "loop",
    group: "Rhythm",
    defaultDuration: 1.2,
    minDuration: 0.2,
    maxDuration: 8,
    apply: function (p, t) {
      t.scale *= 1 + 0.035 * ease.sine(p);
    }
  });

  register({
    id: "sway",
    label: "Sway",
    kind: "loop",
    group: "Rhythm",
    defaultDuration: 3.5,
    minDuration: 0.5,
    maxDuration: 12,
    apply: function (p, t) {
      t.dx += 0.02 * ease.sine(p);
      t.rotate += 0.02 * ease.sine(p + 0.25);
    }
  });

  register({
    id: "float",
    label: "Float",
    kind: "loop",
    group: "Rhythm",
    defaultDuration: 3,
    minDuration: 0.5,
    maxDuration: 12,
    apply: function (p, t) {
      t.dy += 0.015 * ease.sine(p);
    }
  });

  register({
    id: "shake",
    label: "Shake",
    kind: "loop",
    group: "Rhythm",
    defaultDuration: 0.25,
    minDuration: 0.08,
    maxDuration: 2,
    apply: function (p, t) {
      t.dx += 0.008 * ease.sine(p);
      t.dy += 0.008 * ease.sine(p * 1.7 + 0.3);
    }
  });
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
