/*
  Second Brain — video/media.js

  Everything about video and audio *files*: importing them, uploading them to
  the account's Cloud Storage, caching them on the device, resolving a playable
  URL, and listing everything available to pull into an edit.

  The rest of the video feature talks to files only through this file, so if the
  storage backend ever changes this is the only place that has to change.

  Host bridge
  -----------
  index.html calls SecondBrainVideo.install(host) at boot. `host` is the small
  set of core helpers this feature is allowed to use — see video/README.md for
  the contract. Nothing here reaches into the core IIFE directly.

  Cloud Storage layout (all under the account prefix so the storage meter in
  Settings → Account counts it):

    users/{uid}/videos/{itemId}/clips/{clipId}          source footage
    users/{uid}/edits/{itemId}/voiceovers/{clipId}      voiceovers recorded in an edit
    users/{uid}/edits/{itemId}/renders/{renderId}       exported cuts
*/
(function (ns) {
  "use strict";

  var media = (ns.media = ns.media || {});

  /* Source footage is far bigger than a note attachment, so this feature does
     not use the core's 25 MB attachment ceiling. Uploads are resumable. */
  var MAX_FILE_BYTES = (media.MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024); // 2 GB
  /* Files above this are streamed from the cloud instead of copied into
     IndexedDB, so a phone does not fill its quota with footage. */
  var CACHE_LIMIT_BYTES = (media.CACHE_LIMIT_BYTES = 400 * 1024 * 1024);
  /* Posters live inside the synced state document, so they must stay tiny. */
  var POSTER_WIDTH = 160;
  var POSTER_MAX_BYTES = 11 * 1024;
  /* An upload that transfers nothing for this long is treated as dead. */
  var UPLOAD_STALL_MS = 90 * 1000;

  var host = null;

  media.install = function (bridge) {
    host = bridge;
  };

  /* ---------------- item shapes ---------------- */

  function newVideoItem() {
    var item = host.baseItem();
    item.type = "video";
    item.clips = [];
    return item;
  }
  media.newVideoItem = newVideoItem;

  /* Defensive normalising: this data round-trips through Firestore and older
     app versions, so never trust a field's type. */
  function ensureVideoItem(item) {
    item.clips = Array.isArray(item.clips) ? item.clips : [];
    item.clips = item.clips.filter(function (clip) {
      return clip && typeof clip === "object";
    });
    item.clips.forEach(ensureFileEntry);
  }
  media.ensureVideoItem = ensureVideoItem;

  function ensureFileEntry(entry) {
    if (!entry.id) entry.id = host.uid();
    if (typeof entry.name !== "string" || !entry.name.trim()) entry.name = "Clip";
    if (typeof entry.type !== "string") entry.type = "";
    if (typeof entry.size !== "number") entry.size = 0;
    if (typeof entry.added !== "number") entry.added = Date.now();
    if (typeof entry.duration !== "number" || !isFinite(entry.duration)) entry.duration = 0;
    if (typeof entry.width !== "number") entry.width = 0;
    if (typeof entry.height !== "number") entry.height = 0;
    if (typeof entry.poster !== "string") delete entry.poster;
    if (typeof entry.storagePath !== "string") delete entry.storagePath;
  }
  media.ensureFileEntry = ensureFileEntry;

  function isAudioEntry(entry) {
    return /^audio\//.test(entry.type || "") || /\.(m4a|mp3|wav|ogg|weba)$/i.test(entry.name || "");
  }
  media.isAudioEntry = isAudioEntry;

  /* ---------------- probing a file for metadata and a poster ---------------- */

  /* Reads duration and dimensions out of a file the browser can already decode,
     and grabs a small poster frame. Resolves with zeros rather than rejecting
     so an odd codec never blocks an import. */
  function probeFile(file) {
    var audioOnly = /^audio\//.test(file.type || "");
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file),
        element = document.createElement(audioOnly ? "audio" : "video"),
        settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        element.removeAttribute("src");
        try { element.load(); } catch (e) {}
        URL.revokeObjectURL(url);
        resolve(result);
      }

      var timer = setTimeout(function () {
        finish({ duration: 0, width: 0, height: 0, poster: "" });
      }, 20000);

      element.preload = "metadata";
      element.muted = true;
      element.src = url;

      element.onerror = function () {
        finish({ duration: 0, width: 0, height: 0, poster: "" });
      };
      element.onloadedmetadata = function () {
        var info = {
          duration: isFinite(element.duration) ? element.duration : 0,
          width: element.videoWidth || 0,
          height: element.videoHeight || 0,
          poster: ""
        };
        if (audioOnly || !info.width) return finish(info);
        /* Seek a little way in — the first frame of a screen recording is
           often a blank desktop. */
        var target = info.duration > 1.2 ? Math.min(1, info.duration * 0.1) : 0;
        element.onseeked = function () {
          info.poster = grabPoster(element, info.width, info.height);
          finish(info);
        };
        try {
          element.currentTime = target;
        } catch (e) {
          finish(info);
        }
      };
    });
  }
  media.probeFile = probeFile;

  function grabPoster(element, width, height) {
    try {
      var scale = POSTER_WIDTH / width,
        canvas = document.createElement("canvas");
      canvas.width = POSTER_WIDTH;
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(element, 0, 0, canvas.width, canvas.height);
      var data = canvas.toDataURL("image/jpeg", 0.5);
      /* Posters ride along in the synced state document. Drop anything that
         would bloat it rather than risk the Firestore document limit. */
      return data.length <= POSTER_MAX_BYTES ? data : "";
    } catch (e) {
      return ""; // tainted canvas or no decoder — the UI falls back to an icon
    }
  }

  /* ---------------- storage paths ---------------- */

  function storagePathFor(ownerItem, entry) {
    var uid = host.getUser() && host.getUser().uid;
    if (!uid) return "";
    if (ownerItem.type === "video") return "users/" + uid + "/videos/" + ownerItem.id + "/clips/" + entry.id;
    if (entry.kind === "render") return "users/" + uid + "/edits/" + ownerItem.id + "/renders/" + entry.id;
    return "users/" + uid + "/edits/" + ownerItem.id + "/voiceovers/" + entry.id;
  }
  media.storagePathFor = storagePathFor;

  /* ---------------- upload tracking ---------------- */

  /* Live uploads keyed "ownerId:fileId". The editor reads this to draw progress
     and to warn before the tab closes. */
  var uploads = {};
  var uploadListeners = [];

  function uploadKey(ownerItem, entry) {
    return ownerItem.id + ":" + entry.id;
  }
  function notifyUploads() {
    uploadListeners.forEach(function (listener) {
      try { listener(); } catch (e) { console.warn(e); }
    });
  }
  media.onUploadChange = function (listener) {
    uploadListeners.push(listener);
    return function () {
      uploadListeners = uploadListeners.filter(function (other) {
        return other !== listener;
      });
    };
  };
  media.uploadState = function (ownerItem, entry) {
    return uploads[uploadKey(ownerItem, entry)] || null;
  };
  media.activeUploadCount = function () {
    return Object.keys(uploads).length;
  };

  /* Resumable upload with a stall watchdog. Firebase's own promise never times
     out, so a connection that dies mid-transfer would otherwise hang forever. */
  function uploadEntry(ownerItem, entry, file) {
    var storage = host.getStorage();
    if (!host.getUser() || !storage) return Promise.resolve(false);

    var key = uploadKey(ownerItem, entry);
    if (uploads[key]) return uploads[key].promise;

    var path = storagePathFor(ownerItem, entry);
    if (!path) return Promise.resolve(false);

    entry.syncState = "uploading";
    delete entry.cloudError;
    host.touchItem(ownerItem);
    host.persist();

    var record = { progress: 0, transferred: 0, total: file.size || 0, cancelled: false };
    uploads[key] = record;

    record.promise = new Promise(function (resolve, reject) {
      var task = storage.ref(path).put(file, { contentType: entry.type || file.type || "application/octet-stream" }),
        lastBytes = -1,
        settled = false;

      record.cancel = function () {
        record.cancelled = true;
        try { task.cancel(); } catch (e) {}
      };

      var watchdog = setInterval(function () {
        if (record.transferred !== lastBytes) {
          lastBytes = record.transferred;
          record.stalledSince = Date.now();
          return;
        }
        if (Date.now() - (record.stalledSince || Date.now()) > UPLOAD_STALL_MS) {
          clearInterval(watchdog);
          record.cancel();
        }
      }, 5000);
      record.stalledSince = Date.now();

      function done(error) {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        if (error) reject(error);
        else resolve(true);
      }

      task.on(
        "state_changed",
        function (snapshot) {
          record.transferred = snapshot.bytesTransferred;
          record.total = snapshot.totalBytes || record.total;
          record.progress = record.total ? snapshot.bytesTransferred / record.total : 0;
          notifyUploads();
        },
        done,
        function () {
          done(null);
        }
      );
    })
      .then(function () {
        entry.storagePath = path;
        entry.syncState = "cloud";
        delete entry.cloudError;
        host.touchItem(ownerItem);
        host.persist();
        host.scheduleUsageRefresh(0);
        return true;
      })
      .catch(function (error) {
        entry.syncState = "device";
        entry.cloudError = true;
        host.touchItem(ownerItem);
        host.persist();
        throw error;
      });

    function clear() {
      delete uploads[key];
      notifyUploads();
    }
    record.promise.then(clear, clear);
    notifyUploads();
    return record.promise;
  }
  media.uploadEntry = uploadEntry;

  /* ---------------- importing files ---------------- */

  /* Caching is best effort. A device that runs out of IndexedDB quota still
     works — playback falls back to streaming from the cloud. */
  function cacheLocally(ownerItem, entry, file) {
    if ((file.size || 0) > CACHE_LIMIT_BYTES) return Promise.resolve(false);
    return host
      .storeFile(ownerItem.id, entry.id, file)
      .then(function () {
        entry.cached = true;
        return true;
      })
      .catch(function (error) {
        console.warn("Video could not be cached on this device:", error);
        entry.cached = false;
        return false;
      });
  }

  /* Adds files to a Video item. Returns a promise that settles when every file
     has finished importing, but the UI updates continuously as it goes. */
  function addFiles(item, files, options) {
    options = options || {};
    var accepted = Array.prototype.slice.call(files || []).filter(function (file) {
      if (!file || !file.size) return false;
      if (file.size > MAX_FILE_BYTES) {
        host.showToast(file.name + " is larger than the 2 GB limit", true);
        return false;
      }
      var looksRight = /^(video|audio)\//.test(file.type || "") || /\.(mp4|mov|m4v|webm|mkv|avi|m4a|mp3|wav|ogg)$/i.test(file.name || "");
      if (!looksRight) {
        host.showToast(file.name + " is not a video or audio file", true);
        return false;
      }
      return true;
    });
    if (!accepted.length) return Promise.resolve([]);

    var list = options.list || "clips";
    item[list] = Array.isArray(item[list]) ? item[list] : [];

    var jobs = accepted.map(function (file) {
      var entry = {
        id: host.uid(),
        name: file.name || "Clip",
        type: file.type || "",
        size: file.size || 0,
        added: Date.now(),
        duration: 0,
        width: 0,
        height: 0,
        syncState: "saving"
      };
      if (options.kind) entry.kind = options.kind;
      item[list].push(entry);
      host.touchItem(item);
      host.persist();
      host.refreshItemEditor(item);

      return probeFile(file)
        .then(function (info) {
          entry.duration = info.duration;
          entry.width = info.width;
          entry.height = info.height;
          if (info.poster) entry.poster = info.poster;
          host.touchItem(item);
          host.persist();
          host.refreshItemEditor(item);
          return cacheLocally(item, entry, file);
        })
        .then(function () {
          entry.syncState = "device";
          host.touchItem(item);
          host.persist();
          host.refreshItemEditor(item);
          return uploadEntry(item, entry, file);
        })
        .then(function () {
          host.refreshItemEditor(item);
          host.renderList();
          return entry;
        })
        .catch(function (error) {
          console.warn("Video import failed:", error);
          if (entry.syncState === "saving") {
            item[list] = item[list].filter(function (other) {
              return other.id !== entry.id;
            });
            host.showToast("Couldn't import " + entry.name, true);
          } else {
            entry.syncState = "device";
            entry.cloudError = true;
            host.showToast(entry.name + " is on this device only — cloud upload failed", true);
          }
          host.touchItem(item);
          host.persist();
          host.refreshItemEditor(item);
          return null;
        });
    });

    return Promise.all(jobs).then(function (results) {
      var added = results.filter(Boolean);
      if (added.length) host.showToast(added.length + " file" + (added.length === 1 ? "" : "s") + " imported");
      return added;
    });
  }
  media.addFiles = addFiles;

  /* Retries the cloud half of an import for a file still sitting on device. */
  function retryUpload(ownerItem, entry) {
    if (media.uploadState(ownerItem, entry)) return;
    host
      .readFile(ownerItem.id, entry.id)
      .then(function (file) {
        if (!file) throw new Error("This file is not cached on this device");
        return uploadEntry(ownerItem, entry, file);
      })
      .then(function () {
        host.showToast("Uploaded to your account");
        host.refreshItemEditor(ownerItem);
      })
      .catch(function (error) {
        console.warn("Retry failed:", error);
        host.showToast("Still on this device only — open it on the device that has the file", true);
      });
  }
  media.retryUpload = retryUpload;

  function removeEntry(ownerItem, entry, listName) {
    var list = listName || "clips",
      active = media.uploadState(ownerItem, entry);
    if (active && active.cancel) active.cancel();

    ownerItem[list] = (ownerItem[list] || []).filter(function (other) {
      return other.id !== entry.id;
    });
    host.touchItem(ownerItem);
    host.persist();
    forgetResolved(ownerItem.id, entry.id);
    host.removeFile(ownerItem.id, entry.id);

    /* Only delete the cloud object when nothing else points at it. Duplicated
       items can share a storagePath. */
    var storage = host.getStorage(),
      shared = false;
    if (entry.storagePath) {
      host.forEachOwnedFile(function (other, owner) {
        if (owner === ownerItem && other.id === entry.id) return;
        if (other.storagePath === entry.storagePath) shared = true;
      });
    }
    if (storage && entry.storagePath && !shared) {
      storage
        .ref(entry.storagePath)
        .delete()
        .catch(function (error) {
          console.warn("Cloud cleanup skipped:", error);
        })
        .then(function () {
          host.scheduleUsageRefresh(0);
        });
    }
  }
  media.removeEntry = removeEntry;

  /* ---------------- resolving a playable URL ---------------- */

  /*
    Two ways a file becomes playable:

    1. It is cached in IndexedDB → a blob: URL. Same-origin, so the preview
       canvas stays clean and export works.
    2. It is only in the cloud → a Storage download URL used with
       crossOrigin="anonymous". That needs CORS on the bucket; without it the
       media element refuses to load and the editor shows the setup hint from
       video/README.md.

    Resolved URLs are cached for the session because creating a blob URL for a
    large file is not free and elements get rebuilt on every re-render.
  */
  var resolved = {};

  function resolveKey(itemId, fileId) {
    return itemId + ":" + fileId;
  }
  function forgetResolved(itemId, fileId) {
    var key = resolveKey(itemId, fileId),
      hit = resolved[key];
    if (hit && hit.revoke) URL.revokeObjectURL(hit.url);
    delete resolved[key];
  }
  media.forgetResolved = forgetResolved;

  media.releaseAll = function () {
    Object.keys(resolved).forEach(function (key) {
      if (resolved[key].revoke) URL.revokeObjectURL(resolved[key].url);
      delete resolved[key];
    });
  };

  function resolveEntry(ownerItem, entry) {
    var key = resolveKey(ownerItem.id, entry.id);
    if (resolved[key]) return Promise.resolve(resolved[key]);

    return host
      .readFile(ownerItem.id, entry.id)
      .catch(function () {
        return null;
      })
      .then(function (file) {
        if (file) {
          resolved[key] = { url: URL.createObjectURL(file), local: true, revoke: true, crossOrigin: false };
          return resolved[key];
        }
        var storage = host.getStorage();
        if (!storage || !entry.storagePath) throw new Error("This file is not available on this device yet");
        return storage
          .ref(entry.storagePath)
          .getDownloadURL()
          .then(function (url) {
            resolved[key] = { url: url, local: false, revoke: false, crossOrigin: true };
            return resolved[key];
          });
      });
  }
  media.resolveEntry = resolveEntry;

  /* Pulls a cloud file into the local cache so scrubbing is smooth and export
     is guaranteed to work. Needs bucket CORS — see video/README.md. */
  function downloadToCache(ownerItem, entry, onProgress) {
    var storage = host.getStorage();
    if (!storage || !entry.storagePath) return Promise.reject(new Error("Nothing to download"));
    if ((entry.size || 0) > CACHE_LIMIT_BYTES) return Promise.reject(new Error("This file is too large to cache on the device"));

    return storage
      .ref(entry.storagePath)
      .getDownloadURL()
      .then(function (url) {
        return new Promise(function (resolve, reject) {
          var request = new XMLHttpRequest();
          request.open("GET", url);
          request.responseType = "blob";
          request.onprogress = function (event) {
            if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
          };
          request.onload = function () {
            if (request.status >= 200 && request.status < 300) resolve(request.response);
            else reject(new Error("Download failed (" + request.status + ")"));
          };
          request.onerror = function () {
            var error = new Error("Download blocked — Cloud Storage CORS is not configured");
            error.corsLikely = true;
            reject(error);
          };
          request.send();
        });
      })
      .then(function (blob) {
        var file;
        try {
          file = new File([blob], entry.name || "clip", { type: entry.type || blob.type });
        } catch (e) {
          file = blob;
        }
        return host.storeFile(ownerItem.id, entry.id, file);
      })
      .then(function () {
        entry.cached = true;
        forgetResolved(ownerItem.id, entry.id);
        host.touchItem(ownerItem);
        host.persist();
        return true;
      });
  }
  media.downloadToCache = downloadToCache;

  /* ---------------- the library ---------------- */

  /*
    Everything in the account an edit can pull from, flattened into one list:
    clips on Video items, recordings on Audio items, and voiceovers recorded
    into edits. Each entry is what timeline.createMediaClip() expects.
  */
  function libraryEntries(options) {
    options = options || {};
    var entries = [];

    function push(item, entry, kind) {
      entries.push({
        kind: kind,
        itemId: item.id,
        itemTitle: item.title || "Untitled " + (kind === "audio" ? "audio" : "video"),
        itemType: item.type,
        folderId: item.folderId || null,
        folderName: host.folderName(item.folderId),
        fileId: entry.id,
        name: entry.name || "Clip",
        duration: entry.duration || 0,
        size: entry.size || 0,
        width: entry.width || 0,
        height: entry.height || 0,
        poster: entry.poster || "",
        added: entry.added || 0,
        entry: entry,
        item: item
      });
    }

    host.items().forEach(function (item) {
      if (item.type === "video") {
        (item.clips || []).forEach(function (entry) {
          push(item, entry, isAudioEntry(entry) ? "audio" : "video");
        });
      } else if (item.type === "audio") {
        (item.recordings || []).forEach(function (entry) {
          push(item, entry, "audio");
        });
      } else if (item.type === "edit") {
        (item.voiceovers || []).forEach(function (entry) {
          push(item, entry, "audio");
        });
      }
    });

    if (options.kind) {
      entries = entries.filter(function (entry) {
        return entry.kind === options.kind;
      });
    }
    if (options.query) {
      var needle = options.query.toLowerCase();
      entries = entries.filter(function (entry) {
        return (entry.name + " " + entry.itemTitle + " " + (entry.folderName || "")).toLowerCase().indexOf(needle) >= 0;
      });
    }
    if (options.folderId) {
      entries = entries.filter(function (entry) {
        return entry.folderId === options.folderId;
      });
    }
    return entries.sort(function (a, b) {
      return (b.added || 0) - (a.added || 0);
    });
  }
  media.libraryEntries = libraryEntries;

  /* Resolves a timeline clip's source back to the item and file entry that own
     it. Returns null when the footage has since been deleted. */
  function findSource(itemId, fileId) {
    var found = null;
    host.items().forEach(function (item) {
      if (found) return;
      var lists = item.type === "video" ? [item.clips] : item.type === "audio" ? [item.recordings] : item.type === "edit" ? [item.voiceovers] : [];
      lists.forEach(function (list) {
        (list || []).forEach(function (entry) {
          if (item.id === itemId && entry.id === fileId) found = { item: item, entry: entry };
        });
      });
    });
    return found;
  }
  media.findSource = findSource;

  function sourceExists(itemId, fileId) {
    return !!findSource(itemId, fileId);
  }
  media.sourceExists = sourceExists;

  /* ---------------- display helpers ---------------- */

  function syncLabel(ownerItem, entry) {
    var active = media.uploadState(ownerItem, entry);
    if (active) return "Uploading " + Math.round(active.progress * 100) + "%";
    if (entry.syncState === "saving") return "Reading file…";
    if (entry.cloudError) return "On this device only — upload failed";
    if (entry.storagePath) return entry.cached ? "In your account · cached here" : "In your account";
    return "On this device";
  }
  media.syncLabel = syncLabel;

  function entrySummary(ownerItem, entry) {
    var parts = [];
    if (entry.duration) parts.push(ns.timeline.formatTime(entry.duration));
    if (entry.width && entry.height) parts.push(entry.width + "×" + entry.height);
    if (entry.size) parts.push(host.fileSize(entry.size));
    parts.push(syncLabel(ownerItem, entry));
    return parts.join(" · ");
  }
  media.entrySummary = entrySummary;
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
