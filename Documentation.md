# TiddlyDesktop — Documentation

TiddlyDesktop is a special-purpose web browser for working with locally stored
[TiddlyWiki](https://tiddlywiki.com/)s. It runs on [NW.js](https://nwjs.io/) (a Chromium +
Node.js runtime) and works with both **single-file** wikis and **TiddlyWiki folder (server)**
wikis, supporting both TiddlyWiki 5 and the classic 2.x line.

This build adds, on top of upstream TiddlyDesktop: **real-time collaborative editing**
(end-to-end encrypted), per-wiki **plugin management**, single-file ⇄ folder **conversion**,
new-wiki-folder creation, full **internationalisation** with a live language switcher, dark
mode, **safe embedded media** (YouTube/Vimeo/maps), native fullscreen, page zoom, find-in-page,
and cross-browser drag-and-drop import.

- App version: **0.0.23**
- Bundled runtime: **NW.js 0.112.0**
- Bundled collaboration plugin: `$:/plugins/tiddlywiki/codemirror-6-collab-nwjs`

---

## Table of contents

1. [Concepts](#1-concepts)
2. [Installation](#2-installation)
3. [Opening unsigned builds](#3-opening-unsigned-builds)
4. [The wiki list](#4-the-wiki-list)
5. [Adding wikis](#5-adding-wikis)
6. [Creating new wikis](#6-creating-new-wikis)
7. [Converting between single-file and folder wikis](#7-converting-between-single-file-and-folder-wikis)
8. [Plugin management](#8-plugin-management)
9. [Tagging and filtering wikis](#9-tagging-and-filtering-wikis)
10. [Language switcher (internationalisation)](#10-language-switcher-internationalisation)
11. [Dark mode and customising the wiki list](#11-dark-mode-and-customising-the-wiki-list)
12. [Wiki window features](#12-wiki-window-features)
13. [Embedded media (videos, maps, …)](#13-embedded-media-videos-maps-)
14. [External attachments](#14-external-attachments)
15. [Folder wikis and serving over the LAN](#15-folder-wikis-and-serving-over-the-lan)
16. [Backups](#16-backups)
17. [Real-time collaboration](#17-real-time-collaboration)
18. [Multiple configurations](#18-multiple-configurations)
19. [Developer tools](#19-developer-tools)
20. [Keyboard shortcuts](#20-keyboard-shortcuts)
21. [Configuration tiddlers reference](#21-configuration-tiddlers-reference)
22. [Troubleshooting](#22-troubleshooting)
23. [Building from source](#23-building-from-source)
24. [Architecture and internals](#24-architecture-and-internals)
25. [Licensing and credits](#25-licensing-and-credits)

---

## 1. Concepts

**Single-file wiki** — one self-contained `.html`/`.htm` file that stores all tiddlers inside
it. Saved in place by TiddlyDesktop's saver. This is the classic, portable TiddlyWiki format.

**Folder (server) wiki** — a directory containing a `tiddlywiki.info` file, a `tiddlers/`
folder (one file per tiddler), and references to plugins/themes/languages by name. It runs
TiddlyWiki's Node.js server and can be served over HTTP.

**The backstage / wiki list** — TiddlyDesktop's own UI (the window that lists your wikis,
Settings, Help) is itself a TiddlyWiki, called the *backstage wiki*. It lives in a user-config
folder under the app's data directory and is driven by the bundled `tiddlydesktop` plugin.

**Wiki windows** — each opened wiki runs in its own native window. A single-file wiki renders
inside a sandboxed `<iframe>` (no Node.js); a folder wiki renders directly in a Node-enabled
window and runs its server.

---

## 2. Installation

Download the Windows, Linux, or macOS binary archive from the
[releases page](https://github.com/TiddlyWiki/TiddlyDesktop/releases).

Unzip into a folder and run the `TiddlyDesktop` launcher:

- **macOS** — `TiddlyDesktop.app`
- **Windows** — `TiddlyDesktop.exe`
- **Linux** — `TiddlyDesktop`

> TiddlyDesktop will **not** work correctly from a Windows UNC network share (e.g.
> `\\MY-SERVER\SHARE\MyFolder`). Map the share to a drive letter and run it from there.

### Linux AppImage

Linux releases may also be provided as AppImages. They are compatible with glibc-based desktop
distributions (Ubuntu, Fedora, Arch); they are **not** compatible with musl-based distributions
(Alpine) or server distributions. Your distribution must provide `fusermount3` (usually in a
`fuse3` package). Make the AppImage executable first:

```
chmod u+x tiddlydesktop-*-v*.AppImage
```

### NixOS

The repository is a flake and also works with non-flake pinning tools (npins/niv/…). Add
`github:TiddlyWiki/TiddlyDesktop` as an input (or pin a rev/tag), then add the package
to `environment.systemPackages`. See the repository README for full snippets.

---

## 3. Opening unsigned builds

The released binaries are **not** signed with a paid developer certificate, so the OS warns the
first time you open them. This is expected — the steps below are a one-time bypass.

- **macOS (Gatekeeper).** The app is *ad-hoc* signed so it launches (required on Apple Silicon),
  but macOS still flags it as from an unidentified developer.
  - **Right-click** (Control-click) `TiddlyDesktop.app` → **Open** → **Open**. macOS remembers
    the choice.
  - If macOS says the app "is damaged and can't be opened" (the download quarantine flag), clear
    it once: `xattr -dr com.apple.quarantine /path/to/TiddlyDesktop.app`
- **Windows (SmartScreen).** Click **More info → Run anyway**.

There is no free way to remove these warnings entirely (notarization requires a paid Apple
Developer ID; clearing Windows SmartScreen requires a CA-issued certificate — for open source,
SignPath Foundation issues free ones). See [Building from source](#23-building-from-source).

---

## 4. The wiki list

The main window lists your wikis. Each entry is a **row** showing the wiki's favicon thumbnail,
its title and path/URL, and a per-row toolbar. Rows have rounded styling with a hover lift, and
the list fills the window height.

Per-row toolbar actions:

- **Open** — open the wiki in its own window (or focus it if already open).
- **Reveal** — show the wiki file/folder in your OS file manager.
- **Remove** — remove the entry from the list (does *not* delete the wiki on disk).
- **To folder / To file** — [convert](#7-converting-between-single-file-and-folder-wikis) the
  wiki between formats.
- **Plugins** — open the [Plugin Chooser](#8-plugin-management) for that wiki; a count badge
  appears when updates are available.
- **Advanced** — backup options (single-file) or server options (folder); see
  [Folder wikis](#15-folder-wikis-and-serving-over-the-lan) and [Backups](#16-backups).
- **Tags** — [tag the wiki and filter the list](#9-tagging-and-filtering-wikis).

Rows can be **reordered by dragging**. (Convert and Plugins are hidden for TiddlyWiki Classic
wikis, which are single-file only.)

The wiki list runs in a hidden controller window with Chromium background-throttling disabled, so
it stays responsive.

---

## 5. Adding wikis

- **Drag and drop** a `.html` file or a wiki folder onto the list.
- Use the toolbar **add** buttons to browse for a wiki file or wiki folder.

Added wikis are tracked by path. Their entry tiddlers carry the `wikilist` tag (plus
`wikifile`/`wikifolder`).

---

## 6. Creating new wikis

The toolbar **Create new wiki** control offers:

- **New single-file wiki** — saved with a `.html`/`.htm` extension. It is created from a
  **template** (any tiddler tagged `template`) or by **cloning** an existing wiki in your list.
- **Create new wiki folder** — choose a directory; TiddlyDesktop scaffolds a standard Node wiki
  folder: a `tiddlywiki.info` with the `tiddlywiki/filesystem` and `tiddlywiki/tiddlyweb`
  (server) plugins plus the vanilla/snowwhite themes, and an empty `tiddlers/` directory. It is
  then opened as a folder wiki. (Refuses if the target path already exists.)

---

## 7. Converting between single-file and folder wikis

From a row's toolbar, **To folder** (on a single-file wiki) or **To file** (on a folder wiki)
converts the wiki non-destructively — **the original is left untouched**, and a new entry is
added pointing at the converted wiki. The title and favicon are carried across.

- **Single-file → folder** uses TiddlyWiki's `--savewikifolder`, run **in-process** (no child
  process, to avoid an NW.js window flash). The `tiddlywiki/filesystem` and
  `tiddlywiki/tiddlyweb` plugins are added so the folder wiki can run its server and save.
  - **Only genuinely custom plugins are copied into the folder.** Any plugin/theme/language the
    folder wiki can resolve by name at boot — bundled, or on `TIDDLYWIKI_PLUGIN_PATH`,
    `TIDDLYWIKI_THEME_PATH`, `TIDDLYWIKI_LANGUAGE_PATH` — is **referenced by name** in
    `tiddlywiki.info` instead of being exploded into the folder, so the copy can't bloat the
    folder or freeze a stale version of a bundled plugin.
- **Folder → single-file** renders the wiki to one HTML file, first stripping the server-only
  plugins (`filesystem`, `tiddlyweb`, `server`) so a single-file copy doesn't try to sync to a
  non-existent server.

A failed conversion reports an error instead of taking down the app.

---

## 8. Plugin management

The **Plugins** button on a wiki row opens the **Plugin Chooser** — a modal dialog that lets you
install/enable and remove plugins for that wiki **without opening it**.

- **Catalogue** — every plugin/theme/language on the bundled library path *plus* any on
  `TIDDLYWIKI_PLUGIN_PATH` is listed (title, description, version, type badge), with a live
  search filter. `$:/core` and the TiddlyDesktop plugin itself are hidden.
- **Apply (single-file wikis)** — makes a timestamped backup first, then rewrites the wiki's
  embedded tiddler store: deselected plugins are removed and newly selected ones injected.
- **Apply (folder wikis)** — edits the `plugins` array in `tiddlywiki.info`.
- **Safety rails** — `$:/core` can never be removed; folder wikis also protect `tiddlyweb` and
  `filesystem`; applying is **refused while the wiki's window is open** (a banner explains this).

### Update detection

A background scan compares a single-file wiki's *embedded* plugin versions with the *bundled*
ones (at startup, when the list changes, and after applying). Outdated plugins show an
**Update** button in the chooser (e.g. `v1.2.3 → v1.2.4`), and the row's **Plugins** button gets
a count **badge**. Folder wikis load bundled plugins by name at boot, so they're always current
(no badge).

The plugin library is also **watched on disk** (`fs.watch`): if a bundled plugin changes there — a
rebuild, an app update, or an external `TIDDLYWIKI_PLUGIN_PATH` edit — the badge and the chooser's
Update buttons refresh live, without restarting (opening the chooser also re-scans). "Newer" is
judged by the plugin's `plugin.info` version.

The bundled **collaboration plugin carries its own version**, independent of the app version, so
wikis can detect and update to a newer bundled copy. That version is derived at build time
(`major.minor` from its `plugin.info`, patch = commits touching the plugin since that
`major.minor.0`).

---

## 9. Tagging and filtering wikis

Each wiki row has a **Tags** picker. A wiki's tags are stored on a companion tiddler
`$:/TiddlyDesktop/Config/wiki-tags/<entry>`. Add tags with the picker (it suggests, in
alphabetical order, only the tags already used across your wiki-list entries — not the
backstage's internal tiddler tags). Tags pop-animate as you add/remove them.

Above the list is a row of **tag-filter chips** (all your wiki tags, alphabetical and unique).
Click a chip to filter the list to wikis with that tag. There is also a **Delete unused tags**
control. The search box does free-text title search (and a filter search when you type a filter
expression).

### Changing the colour of a tag

The tag chips use TiddlyWiki's **standard tag-colour mechanism**: a tag is coloured by a tiddler
whose *title is the tag name* and whose **`color`** field holds a CSS colour. The wiki list reads
it through the usual colour cascade (`$:/tags/TiddlerColourFilter`), and picks a contrasting text
colour automatically. To set one:

1. Open the wiki list's **backstage** with the **Backstage** toolbar button (this is the editable
   TiddlyWiki behind the list itself — see [§11](#11-dark-mode-and-customising-the-wiki-list)).
2. Create a tiddler whose **title is exactly the tag name** (e.g. `work`).
3. Add a field named **`color`** with a CSS colour value — a hex code (`#e91e63`), an `rgb(…)`, or
   a named colour.
4. Save. The chip for that tag — in both the filter row and each wiki's tags — immediately uses the
   colour.

Delete the `color` field (or the whole tiddler) to revert to the palette's default tag colour.

---

## 10. Language switcher (internationalisation)

The wiki-list UI strings live in a `$:/language/TiddlyDesktop/*` dictionary, with **English** as
the bundled fallback. A **language switcher** in the toolbar uses the standard TiddlyWiki5
`$:/language` mechanism.

- **Every language TiddlyWiki ships is bundled**, and the wiki-list strings are translated into
  all of them.
- Switching language is **live — no restart**. The toolbar and rows re-translate immediately
  (the UI is bound to `$:/language`).

---

## 11. Dark mode and customising the wiki list

### Dark mode

TiddlyDesktop sets the CSS `color-scheme` property from the active palette's `color-scheme`
field, so native UI (scrollbars, form controls) follows dark palettes. Choose a dark palette in
the wiki's control panel as usual.

### Modifying the wiki list window

The wiki list is itself an ordinary TiddlyWiki, shown with a slim chrome. Click the **Backstage**
button in the toolbar to open the **full wiki behind the list**, where you can add and edit
tiddlers to customise it. Everything you change is saved into that backstage wiki and persists
across restarts. For example:

- **Palette / dark mode** — pick a different `$:/palette` in the usual control panel; the list and
  toolbar re-colour live.
- **Tag colours** — see [Changing the colour of a tag](#changing-the-colour-of-a-tag) (§9).
- **Custom CSS** — add a tiddler tagged `$:/tags/Stylesheet` with your own rules. The wiki-list
  elements use `td-…` class names (e.g. `.td-wikilist-item`, `.td-wikilist-title`,
  `.td-tags .tc-tag-label`), so you can restyle rows, titles, and tag chips.
- **Empty-list message, language, and backup options** — on the Settings page.

---

## 12. Wiki window features

These apply to both single-file and folder wiki windows.

- **Fullscreen** — `F11` (or TiddlyWiki's fullscreen page-control button) toggles the **native**
  window fullscreen. (HTML5-document fullscreen doesn't give true window fullscreen in NW.js and
  is blocked inside the single-file iframe, so it's rerouted to the native window — the button's
  handler replaces the wiki's own `tm-full-screen` handler.) If the window was **maximized** before
  going fullscreen, leaving fullscreen **re-maximizes** it (NW.js otherwise drops back to normal
  bounds). This is handled inside each wiki window's own process and detected by polling
  `win.isFullscreen`, since NW.js doesn't emit a reliable leave-fullscreen event on Linux — so it
  also covers Esc-to-exit. (The OAuth deep-link return likewise re-focuses the window without
  un-maximizing it.)
- **Page zoom** — `Ctrl`/`Cmd` `+` / `-` / `0`, or `Ctrl`/`Cmd` + mouse wheel. A reset control
  appears (top-left, fixed) only when not at 100%.
- **Find in page** — `Ctrl`/`Cmd` `F` opens a browser-style find bar (match count, next/prev,
  using the CSS Custom Highlight API). It defers to a focused editor that claims the shortcut
  (e.g. CodeMirror 6) and scrolls the match's actual scrolling container.
- **Permalink / permaview** are shown disabled — they build an address-bar URL fragment, which
  is meaningless in a chromeless desktop window. (A runtime stylesheet does this; your tiddlers
  are untouched.)
- **Window position, size, and maximized state** are remembered per wiki and restored on open.
- **Cross-browser drag-and-drop import** — tiddlers dragged in from another browser (e.g.
  Firefox) keep their fields, working around Chromium's cross-application drag-data sanitiser.

---

## 13. Embedded media (videos, maps, …)

Wikis can embed external media with an `<iframe>` (a YouTube video, a Vimeo clip, an
OpenStreetMap map, …). TiddlyDesktop makes these play reliably and safely.

### How it works

- An **allowlist** decides which embeds are routed through the loopback shim below (the `file://`
  referer fix). Any other external iframe is left **exactly as the wiki wrote it** and loads as a
  normal iframe — for example a plugin-library iframe pointing at `tiddlywiki.com`. The allowlist
  governs only the shim routing, not whether an iframe may load.
- Single-file wikis are `file://` pages, so an embedded player has an empty/`file://` Referer,
  which YouTube rejects (error 153). To fix this, allowlisted media is routed through a tiny
  **loopback HTTP shim**: a server bound to `127.0.0.1` on a random port serves a one-iframe
  page, and the embed's `src` is rewritten to
  `http://127.0.0.1:<port>/<token>/embed?src=<provider-url>`. Served from a real http origin, the
  shim embeds the provider, which now plays. The wiki file itself stays `file://`, so saving,
  collaboration, and external attachments are unaffected.
- The shim is **loopback-only**, requires an unguessable per-process token in the path, embeds
  **only allowlisted hosts**, serves no filesystem content, and proxies nothing.
- The player's own **fullscreen** button works (fullscreen permission is delegated through the
  frame chain). The direct provider load is cancelled the instant an embed appears, so the 153
  error never flickers.
- Embedded media works in **single-file wikis, folder wikis, and the backstage windows** (wiki
  list, Settings, Help).

### Hosts allowed by default

Sub-domains are included automatically (e.g. `youtube.com` also allows `www.youtube.com`):

YouTube (`youtube.com`, `youtube-nocookie.com`, `youtu.be`), Vimeo (`vimeo.com`,
`player.vimeo.com`), Dailymotion, Spotify (`open.spotify.com`), SoundCloud (`soundcloud.com`,
`w.soundcloud.com`), Bandcamp, Twitch (`player.twitch.tv`, `clips.twitch.tv`), Apple Music
(`embed.music.apple.com`), OpenStreetMap, Google Maps (`google.com`), CodePen, CodeSandbox,
JSFiddle, Internet Archive (`archive.org`).

### Adding your own domains

The allowlist (which media hosts get the `127.0.0.1` referer fix — other iframes load regardless)
is configured **per wiki**. In the wiki, create a tiddler titled
**`$:/config/TiddlyDesktop/EmbedHosts`** and list extra hosts in its text, one per line (spaces
or commas also work). They are *added* to the defaults:

```
vimeo.com
my.cdn.example
videos.example.org
```

Give just the host name (any `http(s)://` prefix or path is ignored; sub-domains are included).
The change takes effect immediately; removing a host or deleting the tiddler reverts to the
defaults.

---

## 14. External attachments

External attachments let a wiki reference a media file **on disk** (via a tiddler's
`_canonical_uri` field) instead of embedding the bytes inline — keeping the wiki small.

- Enabled by the **External Attachments** plugin (`$:/plugins/tiddlywiki/external-attachments`)
  and the config tiddler **`$:/config/ExternalAttachments/Enable`** (`yes`).
- **Single-file wikis** — when you drop a binary file in, it is referenced relative to the wiki
  for files under the wiki's directory, or by absolute path otherwise. Controlled by
  `$:/config/ExternalAttachments/UseAbsoluteForDescendents` and
  `…/UseAbsoluteForNonDescendents`.
- **Folder wikis** — TiddlyDesktop adds a hook so dropped binaries are referenced by an absolute
  `file://` `_canonical_uri` (the stock plugin only handles single-file `file://` wikis).
- Because the chromium file-access flags are enabled, these `file://` resources load in the wiki
  window.

---

## 15. Folder wikis and serving over the LAN

A folder wiki runs its own TiddlyWiki server. Folder wikis also show their **title and favicon**
in the wiki list (pushed live from the folder process), and can be re-opened/removed like
single-file wikis.

Open a folder wiki's **Advanced** options and set:

- **Host** — `127.0.0.1` for this machine only, or `0.0.0.0` to allow access from other devices
  on your LAN.
- **Port** — e.g. `8080` (use a different port per open wiki).

Other devices can then open `http://<this-machine's-ip>:<port>/`. Further `--listen` options are
available in the same panel: **path-prefix, root-tiddler, anonymous username, gzip**, and the
**credentials / readers / writers** access settings. Changes take effect the next time the wiki
folder is opened.

To serve a *single-file* wiki on the LAN, convert it to a folder wiki first, or use
[collaboration](#17-real-time-collaboration) for multi-device editing.

---

## 16. Backups

For single-file wikis, the **Advanced** panel exposes backup options. Before each save (and
before applying plugin changes), TiddlyDesktop writes a timestamped backup. The backup location
is templated by **`$:/TiddlyDesktop/BackupPath`**, where `$filename$` and `$filepath$` expand to
the wiki's filename and full path; the path is resolved relative to the wiki's directory.
Backups can be disabled per wiki in the Advanced panel.

---

## 17. Real-time collaboration

TiddlyDesktop bundles a real-time collaboration plugin
(`$:/plugins/tiddlywiki/codemirror-6-collab-nwjs`, CodeMirror 6 + Yjs). Peers in the same *room*
edit shared tiddlers together, chat, and exchange attachments. **All content is end-to-end
encrypted; the relay server only ever sees ciphertext.**

### 17.1 Requirements

- **CodeMirror 6 editor** and **CodeMirror 6 edit-text (Simple Engine)** plugins — the
  collaboration plugin integrates with CM6 for character-level live editing. (Available e.g. at
  https://xyvir.github.io/CM6_Demosite/.)
- **External Attachments** plugin — to save received file attachments to disk.
- **A relay server** — peers discover each other through a small WebSocket relay. Self-host it
  (the relay is a separate Rust/axum project), or use the one available **for testing** at
  `wss://relay.tiddlydesktop-rs.com:8443`.
- **An OAuth sign-in** — GitHub, Google, GitLab, or any OIDC provider (discovered from the
  relay). The relay only admits authenticated users.

### 17.2 Quick start

1. Open the **Collab** tab in the sidebar and expand **Settings**.
2. Set the **Relay server URL** (e.g. `wss://relay.example.com:8443/`).
3. **Sign in** under Account with one of the offered providers — the system browser opens, and
   after you authorise, its page returns you to the app via the `tiddlydesktop://` deep link
   (focusing the window you started from). Sign-in is finalised by the relay result-poll either
   way, so it still works if the OS handler isn't registered (the page also offers a manual link).
4. Set a **Room code** (a shared name) and, for true privacy, a **Room token** (a shared secret
   that is *never* sent to the relay).
5. Click **Connect**. The status bar (bottom-right) shows the connection state, a `🔒 end-to-end
   encrypted` badge when a room token is set, and `LAN ⚡` when a direct LAN link is active.

Connection is never automatic — it requires an explicit Connect (or applying an invite).

### 17.3 Rooms, tokens, and encryption

Every peer-to-peer message routed through the relay is encrypted client-side with **AES-256-GCM
(WebCrypto)** before it leaves the process. The key is derived with **HKDF-SHA256**:

- **Room token set → strong E2E.** The token is never transmitted to the relay, so the relay
  cannot derive the key. Content is confidential even against a malicious relay operator. Shown
  as `🔒 end-to-end encrypted`.
- **No token → still always encrypted**, with the key derived from the room code. This protects
  against eavesdroppers and other peers, but the relay (which knows the room code) could derive
  this key. Shown honestly as `🔓 encrypted (room code)`.

Hardening: anti-downgrade (cleartext peer messages are dropped once connected); the client
refuses to connect if WebCrypto is unavailable (never falls back to plaintext). Pairwise ECDH
(P-256) keys protect 1:1 messages. The relay signs a per-connection **membership certificate
(ES256)** that peers verify, so in token mode you only exchange traffic with verified users.

### 17.4 Invites

Click **Invite** to copy a `collab1:`-prefixed code bundling the relay URL + room code + room
token. Recipients paste it into **Join** (or paste a bare room code) to configure everything and
connect. **Secure by default**: if no room token is set when an invite is generated, a 256-bit
random one is minted automatically and carried *in the invite* (out of band, never via the
relay) — so invitees get true E2E with no extra steps.

### 17.5 Transport and reliability

Two delivery channels run simultaneously with message-id de-duplication:

- **Relay channel** — `wss://` to the configured relay; auto-reconnects with backoff and on
  config change.
- **LAN channel** — direct, encrypted `ws://` between peers on the same network
  (ChaCha20-Poly1305, key via X25519 ECDH → HKDF-SHA256, with the room key folded in so a
  malicious relay can't MITM). Shown as **LAN ⚡**; the relay is the fallback.

Reliability features: a liveness watchdog (catches half-open sockets), sleep/resume recovery, an
`online` handler, a ghost-member reaper, connect/reconnect catch-up, an expired-token-401 that
re-verifies over HTTP instead of looping, and a periodic LAN heal re-announce.

### 17.6 Sharing and getting tiddlers

- Each tiddler gains a **share** button (the plugin icon) in its toolbar while connected. Click
  to share that tiddler with the room — you become its **owner**. (Drafts are never shared.)
- Other peers see shared tiddlers in the **Get** panel (top of the collaboration dock,
  bottom-right) and in the **Collab** sidebar. Click **Get** to fetch the current content and
  subscribe to live updates. A tiddler you've Got shows its share button in **blue** ("Got").
- Editing a shared tiddler in the CM6 editor syncs **character-by-character** with anyone else
  editing it; a banner shows who else is in the tiddler. Field and tag changes sync too.
- **Renames** by the owner propagate: subscribers' copies are renamed and keep syncing, with a
  notification of who renamed it.

### 17.7 Conflicts and resolution

Coarse (whole-tiddler) sync uses a **3-way base** (a content checksum persisted per room), so it
never silently clobbers edits: the side that actually changed is adopted; a genuine
both-sides-changed conflict is flagged **diverged**. (Persistence is arranged so it does not
re-dirty the wiki after every save.)

This is **clock-independent** — it never compares the two machines' wall-clock `modified`
timestamps. Those are stamped by each machine's own clock (TiddlyWiki stores them in UTC, so this
is *not* a timezone issue), and if the clocks disagree, timestamp-based "last write wins" silently
discards a genuinely-newer edit. The base instead tracks *which side changed* relative to the last
agreed content, and when it can't tell (no base + differing content) it flags a conflict rather
than guessing. A subscriber's edit to a peer-owned tiddler is therefore never reset by the owner's
periodic manifest.

When a tiddler diverges, a red **conflict badge** appears on the Collab sidebar tab and a
conflict button on the dock. A **Resolve** button (sidebar / dock / tiddler toolbars) opens a
dialog with a text diff and a table of any differing non-text fields, offering **Use mine / Use
theirs / Merge** (hand-edit the merged text); the choice is pushed so the whole room converges.
There is also an on-demand **Re-sync** button. A coarse change for a tiddler you have open in an
editor never silently overwrites your live edits.

### 17.8 Attachment transfer

Fetch a tiddler backed by a file (`_canonical_uri`) or an embedded binary as an attachment. It
is streamed **privately, chunked, and rate-paced**, with a configurable size cap
(**`$:/config/codemirror-6-collab/max-asset-mb`**) and a live progress bar — shown both in the Get
list **and** in the Collab sidebar's shared-tiddlers list. With the External Attachments plugin
enabled, **Get** offers a *save-as* dialog and stores the file on disk; otherwise it embeds the
file inline. Received attachments stay marked **Got/Saved** across restarts. A consent prompt
precedes any attachment leaving your machine, and an inspection prompt lets you review a received
attachment before it is written. Attachment paths are treated as URIs (URL-decoded for filesystem
access, encoded when recorded), so filenames containing spaces (`%20`) transfer and display
correctly across platforms.

### 17.9 Chat

The collaboration dock has a **Chat** panel:

- **Everyone** — a room-wide message (encrypted with the room key).
- **A single peer** — an exclusive 1:1 conversation, pairwise-encrypted so no other room member
  can read it.

An unread-count badge clears when the panel opens; an opt-in incoming-message **sound** is
available (`$:/config/codemirror-6-collab/chat-sound`). A separate opt-in **sound for a new tiddler
becoming available to get** (`$:/config/codemirror-6-collab/share-sound`) is deliberately distinct
from the chat sound, so you can tell the two apart.

### 17.10 Security model

Folder wikis run with Node.js, so sharing is treated as a remote-code-execution boundary:

- A safety guard refuses **executable content** (JavaScript, raw-markup tags, plugins),
  protected titles, the collaboration/External-Attachments config, and disabled-plugin payloads
  on **every** write path (coarse sync and live field sync).
- `_canonical_uri` is **stripped in every direction** (never sent, accepted, or in the shared
  doc), closing a local-file-read / SSRF vector.
- Deletions never propagate as deletions.
- Sharing `$:/` **system tiddlers** is **off by default** (opt in with "Allow system tiddlers");
  executable ones are *always* refused.

### 17.11 Settings reference

All in the **Collab** sidebar tab (and the Settings page):

| Setting | Tiddler |
|---|---|
| Relay server URL | `$:/config/codemirror-6-collab/relay-url` |
| Room code | `$:/config/codemirror-6-collab/room-code` |
| Room token | `$:/config/codemirror-6-collab/room-token` |
| Display name | `$:/config/codemirror-6-collab/user-name` |
| Colour | `$:/config/codemirror-6-collab/user-color` |
| Max attachment size (MB) | `$:/config/codemirror-6-collab/max-asset-mb` |
| Relay only (disable LAN) | `$:/config/codemirror-6-collab/relay-only` |
| Allow system tiddlers | `$:/config/codemirror-6-collab/allow-system-tiddlers` |
| Chat sound | `$:/config/codemirror-6-collab/chat-sound` |
| New-shared-tiddler sound | `$:/config/codemirror-6-collab/share-sound` |
| OAuth provider / token / username / id | `$:/config/codemirror-6-collab/auth-provider`, `auth-token`, `auth-username`, `auth-user-id` |
| Device id / name | `$:/config/codemirror-6-collab/device-id`, `device-name` |

If peers run different plugin builds, a **version mismatch** warning appears — keep everyone on
the same build, as the wire protocol can change between versions.

---

## 18. Multiple configurations

To run separate instances (e.g. Personal vs Professional), pass `--user-data-dir` pointing at a
directory to hold that instance's configuration:

```
TiddlyDesktop --user-data-dir=/path/to/config
```

This is also the way to start against a clean configuration if TiddlyDesktop is misbehaving.

---

## 19. Developer tools

Press **F12** to open the Chromium developer tools for the current window. (The released builds
use the NW.js SDK runtime, which includes DevTools.)

---

## 20. Keyboard shortcuts

| Shortcut | Action | Where |
|---|---|---|
| `F11` | Toggle native fullscreen | Any wiki window |
| `F12` | Open developer tools | Any window |
| `Ctrl`/`Cmd` `F` | Find in page | Any wiki window (defers to focused editor) |
| `Ctrl`/`Cmd` `+` / `-` / `0` | Zoom in / out / reset | Any wiki window |
| `Ctrl`/`Cmd` + mouse wheel | Zoom | Any wiki window |

Standard TiddlyWiki shortcuts apply inside wikis as usual.

---

## 21. Configuration tiddlers reference

Tiddlers you can create/edit to configure behaviour. Collaboration settings are listed in
[§17.11](#1711-settings-reference).

| Tiddler | Purpose | Lives in |
|---|---|---|
| `$:/config/TiddlyDesktop/EmbedHosts` | Extra hosts routed through the media shim (one per line) | each wiki |
| `$:/config/ExternalAttachments/Enable` | Enable external attachments (`yes`) | each wiki |
| `$:/config/ExternalAttachments/UseAbsoluteForDescendents` | Use absolute path for files under the wiki dir | each wiki |
| `$:/config/ExternalAttachments/UseAbsoluteForNonDescendents` | Use absolute path for files elsewhere | each wiki |
| `$:/TiddlyDesktop/BackupPath` | Backup path template (`$filename$`, `$filepath$`) | backstage / per wiki |
| `$:/language` | Active language (wiki-list UI) | backstage |
| `$:/config/AnimationDuration` | TiddlyWiki animation duration (ms) | each wiki |

Per-wiki TiddlyDesktop state also lives under `$:/TiddlyDesktop/Config/*` (title, favicon,
wiki-tags, host/port, disable-backups, classic flag) in the backstage wiki.

---

## 22. Troubleshooting

### Linux / Wayland (drag-and-drop, window frames, dialogs)

Under some Wayland compositors NW.js (Chromium) glitches: broken drag-and-drop, odd/missing
window frames, misplaced dialogs, wrong sizing/focus. Force the X11 (XWayland) backend:

```
./TiddlyDesktop --ozone-platform=x11
```

or set the environment variable: `OZONE_PLATFORM=x11 ./TiddlyDesktop`. Combine with other flags
as needed.

### Windows UNC network shares

TiddlyDesktop will not work correctly from a UNC share (`\\SERVER\SHARE\…`). Map it to a drive
letter and run from there.

### Resetting / isolating configuration

Start against a clean config directory with `--user-data-dir` (see
[§18](#18-multiple-configurations)).

### "Unidentified developer" / SmartScreen warnings

Expected for unsigned builds — see [§3](#3-opening-unsigned-builds).

### Embedded video shows an error / won't play

Confirm the host is allowlisted (see [§13](#13-embedded-media-videos-maps-)); add it to
`$:/config/TiddlyDesktop/EmbedHosts` if needed. A "Video unavailable" message (as opposed to
error 153) usually means the provider itself restricts that specific video (embedding disabled,
region/age restriction) — not a TiddlyDesktop problem.

---

## 23. Building from source

Building uses Node.js (CI builds with Node.js 24).

1. **`download-nwjs.sh`** — downloads the NW.js SDK binaries. The CI passes `PLATFORM`, `ARCH`,
   `EXT`, and `NWJS_VERSION` in the environment to fetch a single target; set them to build just
   one platform.
2. **`bld.sh`** — runs `npm install` (which pulls in TiddlyWiki5 as a dependency, so there is no
   separate TiddlyWiki5 clone to manage), copies the TiddlyWiki core and the TiddlyDesktop +
   collaboration plugins into `source/`, then builds into `output/`. Notably it:
   - **Prunes the demo/documentation editions** from the bundled TiddlyWiki (`tw5.com`,
     `geospatialdemo`, `tour`, language demo editions, …, ~37 MB), keeping only the tiny `empty`
     and `server` starter editions. Extend the keep-list in `bld.sh` to ship more editions.
   - **Derives the collaboration plugin version** (`bin/stamp-collab-version.js`): `major.minor`
     from its `plugin.info`, patch = number of commits touching the plugin since that
     `major.minor.0` was set. This needs full git history, so the CI checkout uses
     `fetch-depth: 0`; a shallow clone keeps the existing version rather than regressing it.
   - **Names the launcher `TiddlyDesktop`** on every platform (`.exe` on Windows with embedded
     icon/version, renamed bundle binary + `CFBundleExecutable` on macOS, renamed binary +
     `.desktop` `Exec` on Linux).
   - **Ad-hoc code-signs** the macOS bundles so they launch on Apple Silicon (free; not
     Gatekeeper/notarization). Skipped where `codesign` is unavailable.
3. Run the build for your platform from `output/` (e.g. `output/linux64/`, `output/win64/`,
   `output/macapplesilicon/`, …).

### Code signing for distribution

- **macOS** — removing the Gatekeeper warning requires the paid Apple Developer Program
  (Developer ID Application certificate + notarization with `notarytool` + stapling). There is
  no free path.
- **Windows** — a CA-issued Authenticode certificate; for open-source projects, **SignPath
  Foundation** issues free certificates and signs CI artifacts. A self-signed certificate is
  free but not trusted by SmartScreen.

The signing/notarization steps would slot into `bld.sh` / the CI workflow, gated on secrets.

---

## 24. Architecture and internals

- **Backstage wiki** — the wiki list / Settings / Help UI is a TiddlyWiki folder wiki created
  under the app data dir (`user-config-tiddlywiki`), driven by the `tiddlydesktop` plugin. The
  heavy boot is deferred behind a loading splash so a window appears immediately.
- **Single-file wikis** render inside an `nwdisable` iframe (no Node.js). TiddlyDesktop injects
  parent-owned **bridges** so plugins inside that sandbox can still do Node-backed work, each
  draining a command queue from the parent's event loop:
  - **HTTP** bridge (Node `http`/`https`), **WebSocket** bridge (the `ws` module), **file** read/
    write bridge (collab asset transfer), **LAN** bridge (UDP discovery + encrypted peer links),
    and `_nwjsOpenExternal` (open URLs in the system browser, used for OAuth).
- **Folder wikis** render in a Node-enabled window and use Node directly (no bridge needed).
- **Embed shim** — a per-process loopback HTTP server (`127.0.0.1`, random port, unguessable
  token) serves the one-iframe media page (see [§13](#13-embedded-media-videos-maps-)).
- **Conversion** runs an isolated, in-process TiddlyWiki boot (not a child process).

---

## 25. Licensing and credits

TiddlyDesktop is licensed under the **BSD 3-Clause** license (see `LICENSE`), which also
reproduces the third-party notices for TiddlyWiki5 (BSD), NW.js (MIT, with its bundled
Chromium/Node notices), the `ws` module (MIT), and the bundled Yjs libraries (MIT).

TiddlyDesktop is based on [NW.js](https://github.com/nwjs/nw.js) and bundles
[TiddlyWiki5](https://tiddlywiki.com/).
