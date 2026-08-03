# Video editor

Everything for the **Video** and **Edited Video** item types lives in this
folder. The rest of Second Brain is in `../index.html` and does not contain
video code — it only calls `SecondBrainVideo.install()` once at boot and then
asks the type registry whenever it needs to know something about an item.

**If you are an AI or a person adding to the video editor, this folder is the
only place you should need to change.**

## Files, and what belongs in each

| File | Owns | Depends on |
| --- | --- | --- |
| `timeline.js` | The project data model and every editing rule: tracks, clips, move, trim, split, duplicate, ripple delete, snapping, duration. **Pure — no DOM, no Firebase, no app state.** | nothing |
| `media.js` | Files. Importing, probing for duration/dimensions/poster, resumable Cloud Storage upload with progress, device cache, resolving a playable URL, and the library of everything an edit can pull from. | `timeline.js` (formatting only) |
| `player.js` | Playing the timeline onto a canvas, the audio mix, and export via `MediaRecorder`. | `timeline.js` |
| `editor.js` | All DOM and event handling for both item types, and the registration call the core app uses. Loaded last. | all of the above |
| `video-editor.css` | Styles. Every selector is prefixed `.ve-`. Colours come from the core theme's CSS variables. | — |
| `cors.json` | Bucket CORS config. See [Cloud Storage CORS](#cloud-storage-cors). | — |

Load order in `index.html` is `timeline → media → player → editor`. None of them
run anything at load time; they only attach to `window.SecondBrainVideo`.

## The two item types

**Video** (`type: "video"`) is a footage bucket. It holds uploaded video and
audio files in `item.clips`. Put these in folders like `Footage` and `B-Roll`.
Nothing is edited here.

**Edited Video** (`type: "edit"`) is a timeline. `item.project` is a
`timeline.js` project whose clips *reference* files owned by Video items
elsewhere in the account — usually in a different folder. It also owns two of
its own file lists: `item.voiceovers` (recorded straight into the edit) and
`item.renders` (finished exports).

Because a timeline clip only stores `sourceItemId` + `sourceFileId`, the same
footage can appear in any number of edits without being uploaded twice, and
deleting an edit never deletes footage. That distinction is enforced by the
`files()` hook each type registers — an edit reports only its voiceovers and
renders as its own files.

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
refreshItemEditor(item)
storeFile(ownerId, fileId, file)   readFile(ownerId, fileId)   removeFile(ownerId, fileId)
getUser()                   getStorage()            scheduleUsageRefresh(delayMs)
forEachOwnedFile(handler)   // handler(file, doc, item) across every item
```

`storeFile` / `readFile` / `removeFile` use the same IndexedDB store as note
attachments, keyed `ownerId:fileId`, so signing out clears cached footage along
with everything else.

## Cloud Storage layout

Everything lives under the account prefix so the meter in
**Settings → Account & sync** counts it and can clean up orphans:

```
users/{uid}/videos/{itemId}/clips/{clipId}          source footage
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
for smoother scrubbing.

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
| Home / End | Jump to the start / end of the edit |
| Esc | Deselect the current clip |
| Ctrl + mouse wheel | Zoom the timeline around the cursor |

Undo history lives in `editor.js` only — the timeline is a small JSON document,
so history is a capped stack of serialized snapshots kept per open editor. It
is not synced and resets when the item is closed.

On touch screens a clip is selected with one tap and only drags once selected,
so a finger on a full lane can still scroll the timeline. This is done purely
with `touch-action` (see `.ve-clip` in the CSS) plus a pointerType check in
`editor.js`.
