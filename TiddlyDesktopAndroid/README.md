# TiddlyDesktopAndroid

An Android port of TiddlyDesktop, built as a lean **Kotlin + WebView + embedded Node.js**
app (no Tauri). It spawns a Node.js TiddlyWiki server on startup to host the **WikiList**
landing page, and opens single-file / folder wikis in their own tasks — mirroring the
desktop app.

> **Status: released (v0.1.0).** Single-file + folder wikis, the classic WikiList UI, **direct
> filesystem access** (All-Files-Access — no SAF mirror), the single-file save server, collab (relay
> **and LAN** transports), external attachments, native media (incl. **inline PDF** via pdf.js), the
> plugin manager, share-to-wiki (with `$:/Import`), a per-device language switcher, and a home-screen
> Quick Note widget all work. A build needs the prebuilt `libnode.so` + the TiddlyWiki asset zips —
> both **generated** by the scripts below (nothing to hand-supply).

Package: `com.tiddlywiki.tiddlydesktop`  ·  minSdk 24 (Android 7.0)  ·  compileSdk/targetSdk 36  ·  ABI: `arm64-v8a`  ·  version `0.1.0`

Release/signing/CI is documented separately in [`RELEASE.md`](RELEASE.md).

## Architecture

- **Node as `libnode.so`** — the only executable location on Android is the native lib dir,
  so the Termux `node` binary ships in `jniLibs/` renamed to `libnode.so`.
  `node/NodeEnvironment.kt` resolves it, creates the versioned-lib symlinks, sets
  `LD_LIBRARY_PATH` + Termux env overrides (HOME/TMPDIR/SSL/CA bundle), and extracts the
  bundled TiddlyWiki resources on first run.
- **`node/NodeServer.kt`** spawns `tiddlywiki <folder> --listen host=127.0.0.1 port=NNNN`
  and waits for loopback to accept — one per open wiki (and one for the WikiList).
- **`MainActivity`** hosts the WikiList WebView (loopback URL); kept alive by
  **`WikiListForegroundService`** (a `specialUse` foreground service, main process) + high renderer
  priority.
- **`WikiActivity`** (separate `:wiki` process, `documentLaunchMode="always"`) hosts each
  opened wiki and injects the collab bridge. Open wikis are kept alive by **`WikiServerService`**
  (`:wiki` process), which posts **one notification per open wiki** (tapping opens that wiki via the
  `OpenWikiActivity` trampoline); swiping a wiki's task from the Overview closes just that wiki.
- **Storage — direct filesystem access.** Wiki files/folders are served straight from their real
  paths in shared storage (e.g. `/storage/emulated/0/…`). The SAF picker's `content://` URI is
  resolved to an absolute path (`host/SafPaths.kt`) and Node serves it directly — **no `content://`
  mirror or copy-back sync**. This needs **All-Files-Access** (`MANAGE_EXTERNAL_STORAGE`), which
  `host/StorageAccess.kt` checks and `MainActivity` prompts for on startup with a link to the
  Settings toggle. On-device volumes only (cloud/USB SAF providers have no filesystem path).
- **Collab plugin bridge** — `collab/CollabBridge.kt` (`@JavascriptInterface TDCollab`) plus
  `assets/bridge/collab-bridge.js` reimplement the `window._nwjs*` contract the
  codemirror-6-collab-nwjs plugin expects: CORS-free HTTP GET, WebSocket with custom
  headers (via OkHttp), open-in-browser for OAuth, asset file I/O to the wiki's on-disk folder
  (`fileCmd`), and —
  since Android ships a real Node runtime — the **LAN peer transport** (`_nwjsLan*`, see below).

### Node.js integration

Android forbids executing binaries from app data dirs (`noexec`); the **only** place an app may
execute one is its **native library dir** — so the Termux-built `node` binary ships in
`jniLibs/arm64-v8a/` renamed to **`libnode.so`** (Gradle only packages `lib*.so`, and unpacks
`jniLibs` to an executable dir at install). `node/NodeEnvironment.kt` then, for every spawn:

- **Versioned-lib symlinks.** `libnode.so` links against `libz.so.1`, `libcrypto.so.3`,
  `libicu*.so.78`, … but Android ships only the *unversioned* `.so`, so a `node-libs/` dir of
  symlinks (`libz.so.1 → …/libz.so`, …) bridges the gap, with `LD_LIBRARY_PATH =
  node-libs:nativeLibraryDir`. (`jniLibs/README.md` lists which names need entries in `LIB_SYMLINKS`.)
- **Termux env overrides.** the Termux binary hardcodes `/data/data/com.termux/…` paths, so each
  spawn sets `OPENSSL_CONF=/dev/null`; `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` → a CA bundle built once
  from `/system/etc/security/cacerts/` (so HTTPS works); `HOME`/`TMPDIR` → writable app dirs;
  `TZDIR=/system/usr/share/zoneinfo`; plus the boot-cache dirs (see *Startup performance* below).
- **Spawn styles.** one-shot (`runNodeBlocking` — build/convert/clone/render) and long-running
  `tiddlywiki <folder> --listen host=127.0.0.1 port=NNNN` (ports **38000–38999**), polled until
  loopback accepts.
- **Resources as a ZIP.** the engine + WikiList are zipped into `assets/` by Gradle and extracted to
  app data on first run, guarded by a version marker so an app update re-extracts. Only JS goes
  through the ZIP — the Node binary must live in `jniLibs` to stay executable.

### Collab: relay + LAN

The collab plugin supports two transports: a **relay** (WSS over the internet, end-to-end
encrypted) and a **LAN P2P** transport (direct device-to-device on the local network). **Both work
on Android.** The relay runs in the WebView over OkHttp; the LAN transport runs in Node.

The desktop LAN node runs a WebSocket **server + client** (the `ws` module) and performs the
**X25519 + ChaCha20-Poly1305** handshake with Node's `crypto` — none of which a WebView has. Rather
than reimplement all of that natively in Kotlin, Android reuses the exact same code: a dedicated
Node **helper process** runs `app/lan/lan-helper.js`, which drives the shared
`source/js/utils/lan-node.js` (bundled with the `ws` module into `lan.zip`). `node/LanNodeHelper.kt`
spawns it and exchanges line-delimited JSON over stdin/stdout; `CollabBridge.kt` (bridge D) maps the
plugin's `_nwjsLan*` calls to it and forwards its events back. So LAN discovery/handshake/transport
are byte-for-byte wire-compatible with the desktop, and Android↔desktop and Android↔Android peers
connect directly on the same network.

It is **fully guarded and best-effort**: if the helper can't start, dies, or the pipe breaks,
`LanNodeHelper` logs and stops, and collab silently continues over the **relay** — nothing there can
reach the wiki WebView or crash the `:wiki` process. A missing `lan.zip` simply means relay-only.

#### The `window._nwjs*` bridge contract

The plugin (`codemirror-6-collab-nwjs`) runs **unmodified**: its NW.js host injects a set of
`window._nwjs*` functions that the plugin uses when present (falling back to `require`). Android
reimplements the *same* contract natively — the `TDCollab` `@JavascriptInterface` (`CollabBridge.kt`)
plus a JS shim (`assets/bridge/collab-bridge.js`) injected into each wiki WebView on `onPageFinished`.
The four bridges:

- **A — HTTP + open-browser** (`oauth.js`). The plugin pushes `{id,url,headers}` onto
  `_nwjsHttpQueue`; the host does a **CORS-free** native GET (the relay's `/api/auth/*` needn't send
  CORS headers, and browser `fetch` is only the plugin's last resort) and writes
  `_nwjsHttpResults[id] = {data:<parsed JSON object>}`. `_nwjsOpenExternal(url)` → `ACTION_VIEW`.
  OAuth uses the relay's server-side callback + 2 s polling, so **no `tiddlydesktop://` deep link** is
  needed.
- **B — relay WebSocket** (`transport.js`). `_nwjsWsCreate(url,headers)` → a native **OkHttp**
  WebSocket **with custom headers** — browser `WebSocket` can't set `Authorization`, which is the
  whole reason B must be native. Text/JSON frames only (E2E is applied at the app layer); events via
  `_nwjsWsOnEvent(id,type,data)`.
- **C — asset file I/O** (`asset-util.js`). `{id,op:"read"/"write",path,base64}` → read/write inside
  the wiki's on-disk folder; result is base64 (read) or the written path (write).
- **D — LAN peers** (`_nwjsLan*`). The plugin hands over plaintext JSON; the Node LAN helper owns the
  sockets + encrypted framing (see above).

**The gotcha that pins the whole design:** the plugin's end-to-end crypto uses
`window.crypto.subtle`, which Chromium only exposes in a *secure context*. `http://127.0.0.1` /
`localhost` qualify; `file://` does **not**. That's why wikis are always served from **loopback**,
never `file://`.

### Startup performance & language loading

TiddlyWiki boots **twice** per wiki — once in Node to *serve* it, once in the WebView to *render*
it — so startup is dominated by TiddlyWiki, not by process spawn (linking `libnode.so` is ~20 ms).
Two levers cut it roughly in half:

- **Node boot caches.** `bld.sh` patches the bundled `boot.js` (`bin/patch-boot-compile-cache.js`
  + `bin/patch-boot-store-cache.js`) to add a persistent V8 **compile cache** and a `v8.serialize`
  **store cache** of `loadPluginFolder` — so packed plugins (above all the ~2 MB `$:/core`) aren't
  re-read/re-parsed every launch. Both are gated by env vars `NodeEnvironment` sets
  (`TW_COMPILE_CACHE_DIR` / `TW_STORE_CACHE_DIR`) and fail safe to plain loading. Warm boot ≈ 1 s.
- **Active-language-only WikiList.** The 32 bundled language plugins are ~80 % of the served page,
  but only one is active. `NodeEnvironment.applyWikiListLanguage` trims **both** language sources —
  the `tiddlywiki.info` `languages` list and the wiki-folder `languages/` subdir (the full set is
  kept in `languages-all/`) — to the one active language before boot, and writes `$:/language`. The
  switcher lists lightweight `$:/TiddlyDesktop/AvailableLanguage/*` stubs (built by
  `build-wikilist.sh`) and hands the choice to native, which reboots the WikiList server (fixed
  port) with the new language. The default at first launch is **British English** (`en-GB`, in the
  core — no plugin) regardless of device locale; the user's choice is saved (`NodeEnvironment`)
  and must be a *stable* value, or the switcher's "already active?" guard would refuse to reload.
- **`node/WarmNodeServers.kt`** keeps a small pool of pre-booted folder-wiki servers so opening a
  wiki can skip the cold boot.

## Layout

```
TiddlyDesktopAndroid/
├── settings.gradle.kts, build.gradle.kts, gradle.properties
├── gradle/wrapper/gradle-wrapper.properties      # wrapper jar/scripts: see "Building"
└── app/
    ├── build.gradle.kts, proguard-rules.pro       # incl. packageLanHelper -> lan.zip
    ├── lan/lan-helper.js                           # LAN collab helper (drives ../../source/js/utils/lan-node.js)
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/
        │   ├── bridge/*.js                         # injected per wiki: collab _nwjs* shim, meta-push, savers, …
        │   └── README.md                           # tiddlywiki.zip / wikilist.zip / lan.zip go here
        ├── jniLibs/README.md                       # libnode.so + deps go in arm64-v8a/
        ├── java/com/tiddlywiki/tiddlydesktop/
        │   ├── MainActivity.kt                      # WikiList host (active-language boot, switcher reboot, storage gate)
        │   ├── WikiActivity.kt                      # per-wiki host (:wiki process); unsaved-changes back prompt
        │   ├── ForegroundNotification.kt            # shared per-wiki / WikiList keep-alive notification builder
        │   ├── WikiServerService.kt, WikiListForegroundService.kt  # foreground services (:wiki + main)
        │   ├── OpenWikiActivity.kt                  # invisible trampoline: a wiki notification taps to that wiki
        │   ├── QuickNoteActivity.kt, QuickNoteWidget.kt  # home-screen Quick Note
        │   ├── host/  (TDHost, MetaBridge, WikiUrl, WikiLauncher, WikiListStore, SafPaths, StorageAccess, SystemBars…)
        │   ├── node/NodeEnvironment.kt              # node paths, symlinks, env, extraction, caches, language trim
        │   ├── node/NodeServer.kt                   # spawn + supervise tiddlywiki --listen
        │   ├── node/WarmNodeServers.kt              # pool of pre-booted folder-wiki servers
        │   ├── node/LanNodeHelper.kt                # spawns/supervises the LAN collab helper process
        │   ├── node/WikiMeta.kt                     # extract SiteTitle/subtitle/favicon (5.2 JSON + ≤5.1.22 div store)
        │   ├── node/WikiOps.kt, PluginBridge.kt, Backups.kt, Share*.kt   # convert/clone, plugins, backups, share queue
        │   └── collab/CollabBridge.kt               # TDCollab @JavascriptInterface (HTTP/WS/OAuth/file + LAN bridge D)
        └── res/ ...                                 # manifest theme, net-security, icons
```

## Building

Prerequisites (both git-ignored, both generated):
1. **Node.js runtime** — `app/src/main/jniLibs/arm64-v8a/libnode.so` + its `.so` deps. Fetch the
   pinned Termux build (Node 26.3.1) with:
   ```sh
   packaging/fetch-node-libs.sh        # downloads + assembles jniLibs/arm64-v8a/
   ```
   See [`app/src/main/jniLibs/README.md`](app/src/main/jniLibs/README.md) to bump the version.
2. **The engine** — build it from the repo root so `../source/tiddlywiki` exists (or pass
   `-PtdEngineDir=/abs/path`):
   ```sh
   ../bld.sh                            # repacks source/tiddlywiki (engine + plugins + translations)
   ```
3. **Assemble the WikiList** (classic plugin + Android overrides):
   ```sh
   sh packaging/build-wikilist.sh      # -> packaging/wikilist/ (git-ignored)
   ```
   Gradle zips the engine + WikiList (and the LAN collab helper → `lan.zip`) into `assets/`
   automatically before each build.
4. Android SDK (compileSdk 36), JDK 17.

```sh
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease bundleRelease   # signed APK + AAB (see RELEASE.md)
```

## TODO / nice-to-have

- **Custom WikiList PageTemplate** — the classic WikiList currently renders inside the story
  river with chrome hidden via CSS (`packaging/wikilist-android/tiddlers/android-styles.tid`).
  A dedicated full-screen page template would be cleaner.
- **Native video thumbnails** — WebView won't render a first-frame poster for embedded video and is
  unreliable for attachments; generating one with `MediaMetadataRetriever` at import time would.
- **Auto-save-on-background for single-file wikis** — the back button already prompts on unsaved
  changes, but swiping a wiki from the Overview can't prompt (the OS gives no UI moment); saving on
  `onStop` would close that data-loss gap (folder wikis already sync continuously).
- **Reveal-in-file-manager** for wikis/backups is best-effort (no universal "open folder here").
- **On-device verification** of the newer bits (classic-TW saving, Quick Note delivery, the
  Node 26 runtime) as they change.

## Done

- **Asset packaging (M1)** — `packageTiddlyWikiAssets` + `packageWikiListAsset` Gradle tasks
  (run before build) zip the engine + WikiList into `assets/`; extracted on first run by
  `node/NodeEnvironment.kt`.
- **WikiList launch flow (M2)** — `host/TDHost.kt` (`window.TDHost`) + `host/WikiLauncher.kt`
  (launch / bring-to-front) + `host/WikiUrl.kt` (path⇄url) + SAF file/folder pickers in
  `MainActivity` (persisted, writable permissions; favicon extraction).
- **Classic WikiList port** — the real `plugins/tiddlydesktop` UI, served by Node.js, with an
  Android `$tw.desktop` implementation (`packaging/wikilist-android/`) mapping its messages to
  `TDHost`. Backstage opens as a second synced client of the WikiList Node server.
- **Direct filesystem access** — folder + single-file wikis are served straight from their real
  `/storage/…` paths (`host/SafPaths.kt` resolves the SAF picker's URI to a path; `host/StorageAccess.kt`
  gates on All-Files-Access). Replaced the earlier SAF `content://` mirror/copy-back (`SafMirror.kt`,
  now removed). On-device volumes only.
- **Notification lifecycle + sharing** — one keep-alive notification per open wiki (tap → that wiki
  via `OpenWikiActivity`), task-swipe closes just that wiki; streaming share-in (video-safe) that
  attaches media or routes tiddler-container files (`.tid`/`.json`/`.html`/`.csv`/…) through the
  native `$:/Import`; share a tiddler out as text/`.tid`/HTML/JSON/CSV; unsaved-changes back prompt.
- **Collab LAN fast path** — a bundled Node helper (`app/lan/lan-helper.js` + `lan-node.js` + `ws`,
  zipped as `lan.zip`) driven by `node/LanNodeHelper.kt`, bridged via `CollabBridge` (`_nwjsLan*`),
  so LAN peers connect directly and wire-compatibly with the desktop; relay is the fallback.
- **Fast startup + active-language WikiList** — V8 compile/store caches patched into `boot.js`
  (`bin/patch-boot-*.js`), single-active-language loading (`applyWikiListLanguage` + switcher stubs),
  and a warm folder-wiki server pool (`WarmNodeServers`). Warm launch ~halved.

## Licenses

TiddlyDesktopAndroid is licensed under [`LICENSE`](LICENSE) (BSD-3-Clause). It **redistributes
third-party components** — the Node.js runtime + its native deps (from a Termux build), TiddlyWiki,
pdf.js (Apache-2.0), the `ws` module, and the Android/Kotlin/OkHttp libraries. Full attribution and
per-component licenses are in **[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)**; the same
summary is available in-app under **Settings → Licenses**. Bundled files keep their upstream license
headers (e.g. pdf.js).

## The WikiList

The WikiList is the **real classic `plugins/tiddlydesktop` UI**, served as a Node.js folder wiki
(`packaging/wikilist/`, assembled by `build-wikilist.sh` from the plugin + the Android overrides in
`packaging/wikilist-android/`). An Android `$tw.desktop` implementation (`android-desktop.js`) maps
its messages to `window.TDHost`, and Android-specific tiddlers override the desktop chrome (share
templates, settings tabs, plugin manager, EmptyMessage, etc.). Backstage/settings/help open as a
second synced client of the same Node server.

Extra native bridges are injected into each wiki window (`assets/bridge/*.js`): wiki UX
(print/fullscreen), external-attachment import, media-embed hardening, tm-open-window child
windows, share-a-tiddler + share-import, the collab `_nwjs*` shim (relay + LAN), classic-TiddlyWiki
saving, live SiteTitle/subtitle/favicon push to the WikiList (`meta-push.js`), and the Quick Note
delivery path.
```
