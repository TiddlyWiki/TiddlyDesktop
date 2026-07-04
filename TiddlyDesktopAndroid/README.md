# TiddlyDesktopAndroid

An Android port of TiddlyDesktop, built as a lean **Kotlin + WebView + embedded Node.js**
app (no Tauri). It spawns a Node.js TiddlyWiki server on startup to host the **WikiList**
landing page, and opens single-file / folder wikis in their own tasks — mirroring the
desktop app. See the design writeup in [`../ANDROID.md`](../ANDROID.md).

> **Status: released (v0.1.0).** Single-file + folder wikis, the classic WikiList UI, SAF folder
> mirroring, the single-file save server, collab (relay **and LAN** transports), external
> attachments, native media, the plugin manager, share-to-wiki, a per-device language switcher, and
> a home-screen Quick Note widget all work. A build needs the prebuilt `libnode.so` + the TiddlyWiki
> asset zips — both **generated** by the scripts below (nothing to hand-supply).

Package: `com.tiddlywiki.tiddlydesktop`  ·  minSdk 24 (Android 7.0)  ·  compileSdk/targetSdk 36  ·  ABI: `arm64-v8a`  ·  version `0.1.0`

Release/signing/CI is documented separately in [`RELEASE.md`](RELEASE.md).

## Architecture (see ANDROID.md for the full rationale)

- **Node as `libnode.so`** — the only executable location on Android is the native lib dir,
  so the Termux `node` binary ships in `jniLibs/` renamed to `libnode.so`.
  `node/NodeEnvironment.kt` resolves it, creates the versioned-lib symlinks, sets
  `LD_LIBRARY_PATH` + Termux env overrides (HOME/TMPDIR/SSL/CA bundle), and extracts the
  bundled TiddlyWiki resources on first run.
- **`node/NodeServer.kt`** spawns `tiddlywiki <folder> --listen host=127.0.0.1 port=NNNN`
  and waits for loopback to accept — one per open wiki (and one for the WikiList).
- **`MainActivity`** hosts the WikiList WebView (loopback URL); kept alive by
  **`WikiServerService`** (a `specialUse` foreground service) + high renderer priority.
- **`WikiActivity`** (separate `:wiki` process, `documentLaunchMode="always"`) hosts each
  opened wiki and injects the collab bridge.
- **Collab plugin bridge** — `collab/CollabBridge.kt` (`@JavascriptInterface TDCollab`) plus
  `assets/bridge/collab-bridge.js` reimplement the `window._nwjs*` contract the
  codemirror-6-collab-nwjs plugin expects: CORS-free HTTP GET, WebSocket with custom
  headers (via OkHttp), open-in-browser for OAuth, SAF-backed asset file I/O (`fileCmd`), and —
  since Android ships a real Node runtime — the **LAN peer transport** (`_nwjsLan*`, see below).

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
  port) with the new language.
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
        │   ├── MainActivity.kt                      # WikiList host (active-language boot, switcher reboot)
        │   ├── WikiActivity.kt                      # per-wiki host (:wiki process)
        │   ├── WikiServerService.kt                 # foreground service
        │   ├── QuickNoteActivity.kt, QuickNoteWidget.kt  # home-screen Quick Note
        │   ├── host/  (TDHost, MetaBridge, WikiUrl, WikiLauncher, WikiListStore, SystemBars…)
        │   ├── node/NodeEnvironment.kt              # node paths, symlinks, env, extraction, caches, language trim
        │   ├── node/NodeServer.kt                   # spawn + supervise tiddlywiki --listen
        │   ├── node/WarmNodeServers.kt              # pool of pre-booted folder-wiki servers
        │   ├── node/LanNodeHelper.kt                # spawns/supervises the LAN collab helper process
        │   ├── node/WikiMeta.kt                     # extract SiteTitle/subtitle/favicon (5.2 JSON + ≤5.1.22 div store)
        │   ├── node/SafMirror.kt, WikiOps.kt, PluginBridge.kt, Backups.kt, Share*.kt
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
- **Incremental SAF folder sync** — `node/SafMirror.kt` does a full copy-in / copy-back on
  open/close; make it incremental (changed tiddler files only) and handle conflicts.
- **Reveal-in-file-manager** for wikis/backups is best-effort (SAF has no universal "reveal").
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
- **SAF folder mirroring (M3)** — `node/SafMirror.kt` copies a `content://` folder wiki to a
  local dir for Node and syncs it back on close.
- **Collab LAN fast path** — a bundled Node helper (`app/lan/lan-helper.js` + `lan-node.js` + `ws`,
  zipped as `lan.zip`) driven by `node/LanNodeHelper.kt`, bridged via `CollabBridge` (`_nwjsLan*`),
  so LAN peers connect directly and wire-compatibly with the desktop; relay is the fallback.
- **Fast startup + active-language WikiList** — V8 compile/store caches patched into `boot.js`
  (`bin/patch-boot-*.js`), single-active-language loading (`applyWikiListLanguage` + switcher stubs),
  and a warm folder-wiki server pool (`WarmNodeServers`). Warm launch ~halved.

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
