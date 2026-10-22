# Web sessions

A **Web** item is a browser session. It lives in this folder. `index.html`
calls `SecondBrainWeb.install()` once at boot and then uses the item type
registry. Session data stays on the item, so the existing local save and
account sync carry it between a phone and a computer.

## The item

```js
{
  type: "web",
  title: "Cat - Wikipedia",
  web: {
    view: "relay",          // "relay" | "site"
    titleLocked: false,     // true after the session is renamed by hand
    activeId: "tab-id",
    tabs: [{
      id, url, title,
      history: ["https://…"],
      index: 0,
      scrollX: 0,
      scrollY: 0
    }]
  }
}
```

Closing the app writes the item with the rest of the notes. Opening it again
loads `tabs[index].url`. Full immersion is remembered on the device
(`localStorage` key `sbn-web-immersion-v1`); it is not part of the synced
item, so a phone can be immersed while the computer is not. The page itself
syncs.

## Relay and site

**Relay** (the default) asks the signed-in `browse` Cloud Function for the
page and shows it in a sandboxed frame. Link clicks, form submissions, the
title, and scroll are reported back, so the saved address follows the page
the owner was actually on. The frame cannot read the notes app.

**Site** loads the real address in a frame. Logins and web apps work when the
site allows embedding. The saved address is the one opened from the bar,
back, or forward.

If the relay is not deployed or the owner is signed out, the session falls
back to Site and keeps the address locally. Deploy the relay with:

```bash
firebase deploy --project second-brain-4077e --only functions:browse
```

The function refuses private networks, metadata hosts, and non-web ports.
Its URL is `web.baseUrl` in `astral.config.js`.
