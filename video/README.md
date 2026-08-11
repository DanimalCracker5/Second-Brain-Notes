# Video editor

Everything for the **Video**, **File** and **Edited Video** item types lives in
this folder. The rest of Second Brain is in `../index.html` and contains no
media code — it only calls `SecondBrainVideo.install()` once at boot and then
asks the type registry whenever it needs to know something about an item.

**If you are an AI or a person adding to the video editor, this folder is the
only place you should need to change.**

## Files, and what belongs in each

| File | Owns | Depends on |
| --- | --- | --- |
| `timeline.js` | The project data model and every editing rule: tracks, clips, move, trim, split, duplicate, ripple delete, snapping, track colour, lock, frame size, duration. **Pure — no DOM, no Firebase, no app state.** | nothing |
| `animations.js` | The animation registry and the transform an animation produces at a moment in a clip. **Pure.** Adding an animation is one `register()` call here — see below. | nothing |
| `media.js` | Files. Importing, probing for duration/dimensions/poster, resumable Cloud Storage upload with progress, device cache, resolving a playable URL, and the library of everything an edit can pull from. | `timeline.js` (formatting only) |
| `collab.js` | Live multi-person editing: the Firestore session document, presence, debounced pushes, and the shared footage URLs. | nothing |
| `player.js` | Playing the timeline onto a canvas, the audio mix, and export via `MediaRecorder`. | `timeline.js`, `animations.js` |
| `editor.js` | All DOM and event handling for the three item types, and the registration call the core app uses. Loaded last. | all of the above |
| `video-editor.css` | Styles. Every selector is prefixed `.ve-`. Colours come from the core theme's CSS variables. | — |
| `cors.json` | Bucket CORS config. See [Cloud Storage CORS](#cloud-storage-cors). | — |

Load order in `index.html` is
`timeline → animations → media → collab → player → editor`. None of them run
anything at load time; they only attach to `window.SecondBrainVideo`.

The `?v=` query on each `<script>` and on the stylesheet is a cache buster.
**Bump it whenever you change a file here**, or returning devices will keep the
old copy.

## The three item types

**Video** (`type: "video"`) is a footage bucket. It holds uploaded video, audio
and stills in `item.clips`. Put these in folders like `Footage` or `B-Roll`.
Nothing is edited here.

**File** (`type: "file"`) is a general file bucket — `item.files` holds anything
at all: PDFs, exports, archives, images. It uses exactly the same upload, cache
and sync machinery as Video, which is why it lives in this folder. Anything in
it that the timeline understands (video, audio, images) also appears in the
editor's media picker.

**Edited Video** (`type: "edit"`) is a timeline. It owns:

- `item.project` — a `timeline.js` project.
- `item.pool` — **its own media**, imported straight into the edit.
- `item.voiceovers` — recorded straight into the edit.
- `item.renders` — finished exports.
- `item.collabId` — the live session id, when one has been started.

A timeline clip stores only `sourceItemId` + `sourceFileId`, so the same footage
can appear in any number of edits without being uploaded twice, and deleting an
edit never deletes footage owned by a Video or File item. That distinction is
enforced by the `files()` hook each type registers — an edit reports only its
pool, voiceovers and renders as its own files.

## The timeline model

```js
project = { width, height, fps, tracks: [track, …] }   // tracks[0] renders at the bottom

track = { id, kind: "video"|"audio"|"text", name,
          muted, hidden, locked,
          color,            // "" = follow the app theme, or "#rrggbb"
          clips: [clip, …] }  // always sorted by start, never overlapping

clip  = { id, sourceItemId, sourceFileId, srcDuration,
          start, in, out,
          volume, muted, fadeIn, fadeOut,
          fit, scale, offsetX, offsetY, opacity,
          color,            // "" = follow the track
          anim: { in:{id,d}, out:{id,d}, loop:{id,d} },
          text }            // text clips only
```

Invariant maintained by every mutator: clips on one track are sorted by start
and never overlap. Moves and trims clamp against their neighbours instead of
pushing them around. A locked track refuses every mutation.

**Stills** have no natural length, so an image clip is given a very long
`srcDuration` (`media.STILL_SOURCE_SECONDS`) and a short default slice. Making
it longer is then just an ordinary edge drag.

## Adding an animation

One call, anywhere after `animations.js` has loaded:

```js
SecondBrainVideo.animations.register({
  id: "drop-in",            // stored in the project — never change it later
  label: "Drop in",
  kind: "in",               // "in" | "out" | "loop"
  defaultDuration: 0.6,
  apply: function (p, t) {  // p = 0..1, t = the transform being built
    t.dy -= (1 - p) * 0.35; // dx/dy are fractions of the frame
    t.opacity *= p;
  }
});
```

It immediately appears in the editor's Animation sheet and works in the preview
and in exports. The transform is `{ opacity, scale, dx, dy, rotate }`; an
entrance, an exit and a loop compose onto the same object.

Animation ids are stored as plain strings and are never validated by
`timeline.js`, so a project saved on a build that has more animations still
opens on an older one — the unknown id is simply ignored.

## The editor's shape

The edit view is phone-first and follows CapCut, because that shape works
one-handed:

```
sticky monitor  →  transport  →  timeline  →  sticky action rail
```

**The playhead does not move.** It is a fixed needle down the middle of the
timeline and the film scrolls underneath it. That means:

- `time = scroller.scrollLeft / pixelsPerSecond` — one source of truth.
- The surface is padded left and right by half the viewport, so the first and
  last frame can reach the needle.
- Zooming only has to re-lay the film and put the same moment back under the
  needle; there is no anchor maths.
- Scrubbing is a thumb flick, and a two-finger pinch zooms.

Everything beyond that is a bottom sheet (`openSheet()`), which is a centred
card on a desktop. There are no track headers on the timeline itself — track
colour, name, mute, hide, lock, reorder and delete all live in the Tracks sheet,
which is what frees the full width for the film on a phone.

Track colours default to the app's accent rotated by kind and index, so the
timeline re-tints itself when the app theme changes. A hand-picked colour is
stored on the track (or on a single clip) as a hex string.

## How the core app is extended

`index.html` has a small **item type registry** (search for
`item type registry` in that file). A type definition is a plain object; every
key except `type` is optional:

```js
{
  type: "edit",              // the value stored in item.type
  label: "Edited Video",     // shown in the sidebar and item menus
  menuLabel: "Edited Video", // entry in the New menu
  manageLabel, manageHint,   // the row in Settings → Manage
  defaultEnabled: true,      // whether New offers it out of the box
  icon: "<svg…>",            // sidebar icon
  placeholder: "Untitled edit",
  hideCopy: true,            // hide the top bar's Copy All button
  ownsFiles: true,           // the item itself is a file-owning document
  create()                   // -> a brand new item
  normalize(item)            // coerce data arriving from sync or an old version
  files(item)                // -> the attachment-shaped files this item owns
  text(item)                 // -> searchable plain text
  meta(item)                 // -> the one-line summary in the sidebar and header
  hasContent(item)           // -> true if the item is not effectively empty
  build(item)                // -> the editor DOM element
  refresh(item)              // update in place instead of rebuilding build()
  shareLabel(item)           // -> the top bar Share button's label
  share(item, anchor)        // the type takes over the Share button entirely
  detach()                   // tear down timers, media elements, listeners
  reset()                    // the device's local copy was wiped (sign-out)
}
```

`build()` should give its root element `data-item-editor="<item.id>"`. Implement
`refresh()` whenever a rebuild would lose state the user cares about — the
timeline editor does, because rebuilding would reset the playhead and cancel a
drag.

### The host bridge

`SecondBrainVideo.install(host)` receives the *only* core functions this feature
may use, and returns the array of type definitions. Nothing here reaches into
the core IIFE directly, so the core stays free to change internally.

```
uid()                       baseItem()              persist()   save()
showToast(text, isError)    escapeHtml(text)        fileSize(bytes)
items()                     folders()               folderName(folderId)
currentItem()               touchItem(item)         renderList()
refreshItemEditor(item)     createItem(item)        openItem(itemId)
copyText(text, done)
storeFile(ownerId, fileId, file)   readFile(ownerId, fileId)   removeFile(ownerId, fileId)
getUser()                   getStorage()            getDb()
scheduleUsageRefresh(delayMs)
forEachOwnedFile(handler)   // handler(file, doc, item) across every item
```

`storeFile` / `readFile` / `removeFile` use the same IndexedDB store as note
attachments, keyed `ownerId:fileId`, so signing out clears cached footage along
with everything else.

## Collaboration

The Share button on an Edited Video starts a **live session**: one Firestore
document, `editSessions/{sessionId}`, holding the whole project as a JSON string
plus a revision counter. Anyone signed in who opens
`https://…/?edit=<sessionId>` joins the same timeline.

```
{ ownerId, ownerName, itemId, title,
  project: "<json>",   // the timeline
  sources: "<json>",   // shared download URLs for the footage
  rev, updatedAt, updatedBy }
```

A timeline is a small document, so sending the whole thing on every change is
both simpler and more robust than an operational transform, and it can never
leave two devices holding structurally different projects. Writes are debounced
to ~600 ms and never overlap. **Last write wins**: two people editing the same
clip in the same instant will see one of the two edits; two people working on
different parts of the timeline both keep their work.

Presence is a `peers` subcollection, one small document per device, refreshed on
a 12 second heartbeat; anything not seen for 45 s is treated as gone.

**Footage.** Clips reference files in the owner's Cloud Storage, which an
invited editor has no permission to read. So whoever *does* have a file
publishes a Storage download URL into `sources`; those URLs carry their own
access token, which is what makes the footage playable for everyone. The
consequence — stated in the Share sheet — is that anyone with the session link
can watch the footage used in the edit, and a URL already handed out stays valid
until the file is deleted or its token is revoked in the Firebase console.

Rules for the collection are in `../firestore.rules`. **Deploy them** before the
feature will work:

```bash
firebase deploy --only firestore:rules
```

## Cloud Storage layout

Everything lives under the account prefix so the meter in
**Settings → Account & sync** counts it and can clean up orphans:

```
users/{uid}/videos/{itemId}/clips/{clipId}          source footage
users/{uid}/files/{itemId}/{fileId}                 File item attachments
users/{uid}/edits/{itemId}/pool/{fileId}            an edit's own media
users/{uid}/edits/{itemId}/voiceovers/{clipId}      voiceovers
users/{uid}/edits/{itemId}/renders/{renderId}       exports
```

`storage.rules` already grants a signed-in user full access to their own
`users/{uid}/**`, so no rules change was needed.

Only file *metadata* (name, size, duration, dimensions, storage path, and a
poster thumbnail under 11 KB) goes into the synced Firestore state document.
The media itself never does.

## Cloud Storage CORS

Preview and export composite video onto a `<canvas>`. A cross-origin video
taints the canvas, which makes `captureStream()` — and therefore export — fail.
The editor avoids that in two ways:

1. Files cached on the device play from a `blob:` URL, which is same-origin.
2. Files only in the cloud are loaded with `crossOrigin="anonymous"`, which
   needs CORS headers on the bucket.

If the bucket has no CORS config, cloud-only clips will not load and the editor
says so. Fix it once with the Google Cloud SDK:

```bash
gcloud storage buckets update gs://second-brain-4077e.firebasestorage.app --cors-file=video/cors.json
```

Add any new origin you serve the app from to `cors.json` first. This is also
what makes the **Cache here** button work, which downloads a clip to the device
for smoother scrubbing. Collaboration needs it too, since a guest's footage
always arrives cross-origin.

## Export is a real-time recording

There is no render server and no ffmpeg here — this is a static site. Export
plays the timeline once and records the canvas plus the audio mix with
`MediaRecorder`. Consequences worth knowing before you try to "fix" it:

- A three minute cut takes about three minutes to export.
- The tab has to stay in the foreground; background tabs get throttled.
- The container is MP4 where the browser supports recording it, otherwise WebM.
  Both upload fine to YouTube.

A faster, frame-exact export would mean adding `ffmpeg.wasm` (tens of MB, and
it would have to be self-hosted) or a real backend. Both are much larger
changes than they look.

## Limits

| Thing | Value | Where |
| --- | --- | --- |
| Max file size | 2 GB | `media.MAX_FILE_BYTES` |
| Cached on device | files up to 400 MB | `media.CACHE_LIMIT_BYTES` |
| Poster thumbnail | 160 px wide, under 11 KB | `media.js` |
| Upload stall timeout | 90 s with no bytes transferred | `media.js` |
| Shortest clip | 0.1 s | `timeline.MIN_CLIP` |
| Undo history | 90 steps per open edit | `editor.js` |
| Collaboration push | debounced 600 ms | `collab.js` |

Note the Firebase **Spark** plan caps Cloud Storage at 5 GB total. Raw footage
fills that quickly; the storage meter in Settings → Account & sync shows where
it is going.

## Keyboard shortcuts in an edit

| Key | Action |
| --- | --- |
| Space | Play / pause |
| S | Split every clip under the playhead |
| Delete / Backspace | Delete the selected clip |
| ← / → | Nudge one frame (hold Shift for one second) |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo timeline changes |
| Ctrl+D | Duplicate the selected clip |
| Home / End | Jump to the start / end of the edit |
| Esc | Deselect the current clip |
| Ctrl + mouse wheel | Zoom the timeline |
| Mouse wheel | Scrub the timeline |

Undo history lives in `editor.js` only — the timeline is a small JSON document,
so history is a capped stack of serialized snapshots kept per open editor. It
is not synced and resets when the item is closed.

On touch screens a clip is selected with one tap and only drags once selected,
so a finger on a full lane can still scrub the timeline. This is done purely
with `touch-action` (see `.ve-clip` in the CSS) plus a `pointerType` check in
`editor.js`. Trim handles only appear on the selected clip for the same reason.
