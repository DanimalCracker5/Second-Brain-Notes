/*
  Second Brain — video/collab.js

  Live, multi-person editing of one timeline, opened from the Share button.

  The model
  ---------
  A session is a single Firestore document, `editSessions/{sessionId}`, holding
  the whole project as a JSON string plus a revision counter. Everyone with the
  link and a signed-in account reads and writes that one document:

      { ownerId, ownerName, itemId, title,
        project: "<json>",     // the timeline
        sources: "<json>",     // shared download URLs for the footage
        rev, updatedAt, updatedBy }

  A timeline is a *small* document — a few hundred clips is tens of kilobytes —
  so sending the whole thing on every change is both simpler and more robust
  than an operational transform, and it can never leave two devices holding
  structurally different projects. Writes are debounced, and the last write for
  a given moment wins. Two people editing the same clip at the same instant will
  see one of the two edits; two people working on different parts of the
  timeline both keep their work.

  Presence lives in a `peers` subcollection, one small document per device,
  refreshed on a heartbeat. Anything that has not checked in for a while is
  treated as gone.

  Footage
  -------
  Clips reference files in the *owner's* Cloud Storage, which an invited editor
  has no permission to read. So whoever does have the file publishes a Storage
  download URL into `sources`. Those URLs carry their own access token, which is
  what makes the footage playable for everyone in the session.

  That means: anyone with the session link can watch the footage used in the
  edit. Ending the session stops future changes syncing, but a URL already
  handed out stays valid until the file is deleted or its token is revoked in
  the Firebase console. Say so in the UI — video/editor.js does.

  Firestore rules for this collection are in firestore.rules.
*/
(function (ns) {
  "use strict";

  var collab = (ns.collab = ns.collab || {});

  var COLLECTION = "editSessions";
  var PUSH_DEBOUNCE_MS = 600;
  var HEARTBEAT_MS = 12000;
  var PEER_STALE_MS = 45000;

  var host = null;

  collab.install = function (bridge) {
    host = bridge;
  };

  /* A per-tab identity. Two tabs on one account are two collaborators, which is
     exactly what you want when checking a cut on a phone and a laptop. */
  var clientId = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  collab.clientId = clientId;

  function db() {
    return host && host.getDb ? host.getDb() : null;
  }
  function user() {
    return host && host.getUser ? host.getUser() : null;
  }

  collab.isAvailable = function () {
    return !!(db() && user());
  };

  collab.linkFor = function (sessionId) {
    var url = new URL(location.href);
    url.hash = "";
    url.search = "?edit=" + encodeURIComponent(sessionId);
    return url.toString();
  };

  /* ---------------- the live session ---------------- */

  var session = null;

  function emptyState() {
    return { active: false, sessionId: "", role: "", status: "off", peers: [], error: "" };
  }

  collab.state = function () {
    if (!session) return emptyState();
    return {
      active: true,
      sessionId: session.id,
      role: session.role,
      status: session.status,
      peers: livePeers(),
      error: session.error || ""
    };
  };

  function livePeers() {
    if (!session) return [];
    var now = Date.now();
    return Object.keys(session.peers)
      .map(function (id) {
        return session.peers[id];
      })
      .filter(function (peer) {
        return peer && peer.id !== clientId && now - (peer.at || 0) < PEER_STALE_MS;
      })
      .sort(function (a, b) {
        return (a.name || "").localeCompare(b.name || "");
      });
  }

  function announce() {
    if (session && session.onChange) {
      try {
        session.onChange(collab.state());
      } catch (e) {
        console.warn(e);
      }
    }
  }

  function setStatus(status, error) {
    if (!session) return;
    session.status = status;
    session.error = error || "";
    announce();
  }

  function displayName() {
    var account = user();
    if (!account) return "Someone";
    return account.displayName || (account.email || "").split("@")[0] || "Someone";
  }

  /* ---------------- creating and finding sessions ---------------- */

  /* Starts a session for an item that has never been shared. Resolves with the
     session id, which the caller stores on the item as `collabId`. */
  function create(item, project, sources) {
    var database = db(),
      account = user();
    if (!database || !account) return Promise.reject(new Error("Sign in to start collaborating"));

    var ref = database.collection(COLLECTION).doc();
    return ref
      .set({
        ownerId: account.uid,
        ownerName: displayName(),
        itemId: item.id,
        title: item.title || "Untitled edit",
        project: JSON.stringify(project),
        sources: JSON.stringify(sources || {}),
        rev: 1,
        updatedAt: Date.now(),
        updatedBy: clientId
      })
      .then(function () {
        return ref.id;
      });
  }
  collab.create = create;

  /* One-shot read, used when opening an invite link before any local item for
     it exists. */
  function peek(sessionId) {
    var database = db();
    if (!database) return Promise.reject(new Error("Sign in to open this link"));
    return database
      .collection(COLLECTION)
      .doc(sessionId)
      .get()
      .then(function (snapshot) {
        if (!snapshot.exists) throw new Error("That collaboration link has ended");
        var data = snapshot.data() || {};
        return {
          id: sessionId,
          ownerId: data.ownerId || "",
          ownerName: data.ownerName || "Someone",
          title: data.title || "Untitled edit",
          project: parse(data.project, null),
          sources: parse(data.sources, {})
        };
      });
  }
  collab.peek = peek;

  function parse(value, fallback) {
    if (typeof value !== "string") return fallback;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  /* ---------------- attaching ---------------- */

  /*
    attach(options)
      options.sessionId          the document id
      options.getProject()    -> the project to publish
      options.applyProject(p) -> called with a project that arrived from a peer
      options.applySources(s) -> called with the shared source map
      options.onChange(state) -> status, peers, errors
      options.getPlayhead()   -> seconds, shared as presence
  */
  function attach(options) {
    detach();
    var database = db(),
      account = user();
    if (!database || !account) return false;

    session = {
      id: options.sessionId,
      role: "",
      status: "connecting",
      error: "",
      peers: {},
      rev: 0,
      lastPushed: "",
      pushTimer: null,
      pushing: false,
      pushAgain: false,
      heartbeat: null,
      unsubscribeDoc: null,
      unsubscribePeers: null,
      getProject: options.getProject,
      applyProject: options.applyProject,
      applySources: options.applySources,
      getPlayhead: options.getPlayhead,
      onChange: options.onChange
    };

    var ref = database.collection(COLLECTION).doc(session.id);

    session.unsubscribeDoc = ref.onSnapshot(
      function (snapshot) {
        if (!session) return;
        if (!snapshot.exists) {
          setStatus("ended", "This collaboration session was ended by its owner.");
          return;
        }
        var data = snapshot.data() || {};
        session.role = data.ownerId === account.uid ? "owner" : "guest";
        session.rev = Math.max(session.rev, Number(data.rev) || 0);

        var sources = parse(data.sources, null);
        if (sources && session.applySources) session.applySources(sources);

        if (data.updatedBy !== clientId) {
          var project = parse(data.project, null);
          if (project && session.applyProject) {
            session.lastPushed = data.project;
            session.applyProject(project);
          }
        }
        setStatus("live");
      },
      function (error) {
        console.warn("Collaboration stream failed:", error);
        setStatus("error", "Lost the live connection. Your work is still saved to your own account.");
      }
    );

    session.unsubscribePeers = ref.collection("peers").onSnapshot(
      function (snapshot) {
        if (!session) return;
        var next = {};
        snapshot.forEach(function (doc) {
          var data = doc.data() || {};
          next[doc.id] = { id: doc.id, name: data.name || "Someone", at: Number(data.at) || 0, playhead: Number(data.playhead) || 0 };
        });
        session.peers = next;
        announce();
      },
      function (error) {
        console.warn("Presence stream failed:", error);
      }
    );

    beat();
    session.heartbeat = setInterval(beat, HEARTBEAT_MS);
    announce();
    return true;
  }
  collab.attach = attach;

  function beat() {
    if (!session) return;
    var database = db();
    if (!database) return;
    database
      .collection(COLLECTION)
      .doc(session.id)
      .collection("peers")
      .doc(clientId)
      .set({
        name: displayName(),
        at: Date.now(),
        playhead: session.getPlayhead ? session.getPlayhead() : 0
      })
      .catch(function (error) {
        console.warn("Presence update failed:", error);
      });
  }

  function detach() {
    if (!session) return;
    var current = session,
      database = db();
    session = null;
    clearTimeout(current.pushTimer);
    clearInterval(current.heartbeat);
    if (current.unsubscribeDoc) current.unsubscribeDoc();
    if (current.unsubscribePeers) current.unsubscribePeers();
    if (database) {
      database
        .collection(COLLECTION)
        .doc(current.id)
        .collection("peers")
        .doc(clientId)
        .delete()
        .catch(function () {});
    }
    if (current.onChange) {
      try {
        current.onChange(emptyState());
      } catch (e) {}
    }
  }
  collab.detach = detach;

  /* ---------------- pushing local changes ---------------- */

  /* Called after every committed edit. Debounced, and never overlapping — a
     second change while a write is in flight queues one more write rather than
     racing it. */
  function push() {
    if (!session) return;
    clearTimeout(session.pushTimer);
    session.pushTimer = setTimeout(flush, PUSH_DEBOUNCE_MS);
  }
  collab.push = push;

  function flush() {
    if (!session) return;
    if (session.pushing) {
      session.pushAgain = true;
      return;
    }
    var database = db();
    if (!database || !session.getProject) return;

    var json = JSON.stringify(session.getProject());
    if (json === session.lastPushed) return;

    session.pushing = true;
    var active = session,
      rev = session.rev + 1;

    database
      .collection(COLLECTION)
      .doc(session.id)
      .update({ project: json, rev: rev, updatedAt: Date.now(), updatedBy: clientId })
      .then(function () {
        if (session !== active) return;
        session.lastPushed = json;
        session.rev = rev;
        setStatus("live");
      })
      .catch(function (error) {
        console.warn("Could not send the change:", error);
        if (session === active) setStatus("error", "Changes are not reaching the other editors right now.");
      })
      .then(function () {
        if (session !== active) return;
        session.pushing = false;
        if (session.pushAgain) {
          session.pushAgain = false;
          flush();
        }
      });
  }

  /* ---------------- shared footage ---------------- */

  function sourceKey(itemId, fileId) {
    return itemId + "__" + fileId;
  }
  collab.sourceKey = sourceKey;

  /*
    Publishes download URLs for every source in `list` that this device can
    reach, merged into whatever is already in the session. `describe(source)`
    returns the metadata to publish alongside the URL.
  */
  function publishSources(map) {
    if (!session || !map || !Object.keys(map).length) return Promise.resolve(false);
    var database = db();
    if (!database) return Promise.resolve(false);
    var ref = database.collection(COLLECTION).doc(session.id),
      active = session;

    return ref
      .get()
      .then(function (snapshot) {
        if (!snapshot.exists || session !== active) return false;
        var existing = parse((snapshot.data() || {}).sources, {}) || {},
          changed = false;
        Object.keys(map).forEach(function (key) {
          if (existing[key] && existing[key].url === map[key].url) return;
          existing[key] = map[key];
          changed = true;
        });
        if (!changed) return false;
        return ref.update({ sources: JSON.stringify(existing) }).then(function () {
          return true;
        });
      })
      .catch(function (error) {
        console.warn("Could not share the footage links:", error);
        return false;
      });
  }
  collab.publishSources = publishSources;

  /* ---------------- ending ---------------- */

  /* Only the owner can end a session; everyone else just leaves. */
  function end(sessionId) {
    var database = db(),
      account = user();
    if (!database || !account) return Promise.reject(new Error("Sign in first"));
    var ref = database.collection(COLLECTION).doc(sessionId);
    return ref
      .collection("peers")
      .get()
      .then(function (snapshot) {
        return Promise.all(
          snapshot.docs.map(function (doc) {
            return doc.ref.delete().catch(function () {});
          })
        );
      })
      .catch(function () {})
      .then(function () {
        return ref.delete();
      })
      .then(function () {
        if (session && session.id === sessionId) detach();
        return true;
      });
  }
  collab.end = end;

  collab.rename = function (sessionId, title) {
    var database = db();
    if (!database || !sessionId) return;
    database
      .collection(COLLECTION)
      .doc(sessionId)
      .update({ title: title || "Untitled edit" })
      .catch(function () {});
  };

  window.addEventListener("pagehide", function () {
    detach();
  });
})((window.SecondBrainVideo = window.SecondBrainVideo || {}));
