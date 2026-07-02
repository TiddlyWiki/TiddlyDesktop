# TiddlyDesktopAndroid

An Android port of TiddlyDesktop, built as a lean **Kotlin + WebView + embedded Node.js**
app (no Tauri). It spawns a Node.js TiddlyWiki server on startup to host the **WikiList**
landing page, and opens single-file / folder wikis in their own tasks — mirroring the
desktop app. See the design writeup in [`../ANDROID.md`](../ANDROID.md).

> **Status: skeleton.** The structure, Node embedding, process/activity model, foreground
> service, and the collab plugin bridge are in place. Items marked `TODO` below still need
> filling in (single-file server, SAF mirroring, asset packaging). It won't produce a
> working APK until you supply `libnode.so` + the TiddlyWiki asset zips (see below).

Package: `com.tiddlywiki.tiddlydesktop`  ·  minSdk 24  ·  ABI: `arm64-v8a`

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
  headers (via OkHttp), open-in-browser for OAuth, and SAF-backed asset file I/O (`fileCmd`).
  **The LAN peer transport is deliberately not implemented — see below.**

### Collab: relay only, no LAN transport

The collab plugin supports two transports: a **relay** (WSS over the internet, end-to-end
encrypted) and an optional **LAN P2P** transport (direct device-to-device on the local network).
**On Android only the relay works.** The plugin's LAN transport is a set of `_nwjsLan*` functions
(`_nwjsLanInit`/`_nwjsLanBroadcast`/`_nwjsLanAddPeer`/…) that on desktop are provided by NW.js via
`source/js/utils/lan-node.js`; the Android bridge (`assets/bridge/collab-bridge.js`) leaves them
**absent by design**, so an Android device never advertises or accepts LAN peers and every
connection — including Android↔desktop on the same network — falls back to the relay.

**Why not:** the desktop LAN node gets it almost for free from Node — it runs a WebSocket
**server + client** via the `ws` module and performs the **X25519 + ChaCha20-Poly1305** handshake
with Node's `crypto`. Android's WebView has neither, so LAN support would need a native (Kotlin)
reimplementation: a WebSocket *server* (Android only ships a WS *client* via OkHttp), the
X25519/ChaCha20-Poly1305 handshake byte-for-byte wire-compatible with `lan-node.js`, and the
`_nwjsLan*` bridge + relay-bootstrapped peer discovery. That's a sizable, security-sensitive,
device-testing-heavy feature, so the app ships **relay-only**. Relay collab (Android↔desktop and
Android↔Android) works with a configured relay URL + room + OAuth sign-in.

## Layout

```
TiddlyDesktopAndroid/
├── settings.gradle.kts, build.gradle.kts, gradle.properties
├── gradle/wrapper/gradle-wrapper.properties      # wrapper jar/scripts: see "Building"
└── app/
    ├── build.gradle.kts, proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/
        │   ├── bridge/collab-bridge.js            # collab window._nwjs* shim
        │   └── README.md                          # tiddlywiki.zip / wikilist.zip go here
        ├── jniLibs/README.md                      # libnode.so + deps go in arm64-v8a/
        ├── java/com/tiddlywiki/tiddlydesktop/
        │   ├── MainActivity.kt                     # WikiList host
        │   ├── WikiActivity.kt                     # per-wiki host (:wiki process)
        │   ├── WikiServerService.kt                # foreground service
        │   ├── node/NodeEnvironment.kt             # node paths, symlinks, env, extraction
        │   ├── node/NodeServer.kt                  # spawn + supervise tiddlywiki --listen
        │   └── collab/CollabBridge.kt              # TDCollab @JavascriptInterface
        └── res/ ...                                # manifest theme, net-security, icons
```

## Building

Prerequisites (not checked in — see the two READMEs):
1. `app/src/main/jniLibs/arm64-v8a/libnode.so` + its `.so` deps — see
   [`app/src/main/jniLibs/README.md`](app/src/main/jniLibs/README.md). Reuse the binaries
   from `tiddlydesktop-rs/src-tauri/resources/node-bin/arm64-v8a/`.
2. **Assemble the WikiList** (classic plugin + Android bridge):
   ```sh
   sh packaging/build-wikilist.sh      # -> packaging/wikilist/ (git-ignored)
   ```
3. An engine at `../source/tiddlywiki` (or pass `-PtdEngineDir=/abs/path`). Gradle zips the
   engine + WikiList into `assets/` automatically before the build.
4. Android SDK (compileSdk 35), JDK 17.

The Gradle **wrapper jar + `gradlew` scripts are not included** (binary). Generate them
once with a local Gradle (`gradle wrapper --gradle-version 8.11.1`) or just open the
project in Android Studio, then:

```sh
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

## TODO (in rough priority order)

- **Custom WikiList PageTemplate** — the classic WikiList currently renders inside the story
  river with chrome hidden via CSS (`packaging/wikilist-android/tiddlers/android-styles.tid`).
  A dedicated full-screen page template would be cleaner.
- **SAF folder sync robustness** — `node/SafMirror.kt` does a full copy-in / copy-back. Make
  it incremental (changed tiddler files only) and handle conflicts; currently copy-back runs
  on close.
- **Single-file server extras** — external-attachment relative files (`/_relative/...`),
  HTTP Range for large media, and SAF-tree backups (currently filesystem-path wikis only).
- **Collab LAN transport (`_nwjsLan*`)** — **not planned.** Relay-only by design; see
  "Collab: relay only, no LAN transport" above for the rationale. (SAF-backed `fileCmd` asset
  sharing is implemented.)
- **Notification permission** request on Android 13+, edge-to-edge insets, status-bar
  theming, and renderer-crash recovery (port from RS `MainActivity.kt`).
- **Classic features not yet ported** — convert file↔folder, clone, create wiki folder,
  reveal-in-shell, plugin manager (all surface an "unsupported on Android" alert for now).

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

## The WikiList

Currently a **minimal placeholder** at `packaging/wikilist/` — a small folder wiki whose
one startup module (`android-wikilist.js`) renders a full-screen list overlay and calls
`window.TDHost` to add/open/remove wikis. It's a stand-in so the app is usable end-to-end;
the classic `plugins/tiddlydesktop` UI can replace it later (see TODO).
```
