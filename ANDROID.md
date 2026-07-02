# Building an Android TiddlyDesktop — Findings & Architecture Plan

This document captures how **TiddlyDesktop-RS** (`/home/simon/Code/TiddlyDesktopRust`) builds its
Android app and, crucially, **how it embeds and runs the Node.js binary**, and maps that onto the
goal of adding an Android app to **TiddlyDesktopOverhaul** (the classic NW.js TiddlyDesktop, this
repo).

Target behaviour you asked for:

- On startup, spawn a **Node.js process** that hosts the **WikiList** landing UI.
- The **WikiList activity must stay in the foreground / must not be killed** by Android.
- From the WikiList, open **single-file wikis** and **folder wikis**, each with full abilities
  (Node-enabled server + native/Rust-enabled features), exactly like desktop TiddlyDesktop.

---

## Part 1 — How TiddlyDesktop-RS does it (the reference implementation)

### 1.1 High-level stack

- **Tauri 2 "mobile"** provides the Android shell: a `TauriActivity` subclass hosts a system
  **WebView**, and Rust is compiled into `libtiddlydesktop_rs_lib.so` (a JNI native lib loaded via
  `System.loadLibrary("tiddlydesktop_rs_lib")`).
- The Rust code (`src-tauri/src/lib.rs`, ~8–9k lines) is shared across desktop + Android, gated with
  `#[cfg(target_os = "android")]`.
- Android-specific code lives in `src-tauri/src/android/` (both Rust `.rs` and Kotlin `.kt` files
  live side by side here as the *canonical* sources).

### 1.2 The Android "project" is generated, then hand-patched

- `src-tauri/gen/android/` is the generated Gradle/Android Studio project (created by
  `tauri android init`).
- The canonical Kotlin + XML sources live in `src-tauri/src/android/` and
  `src-tauri/src/android/res/`. **After editing them you must copy them into `gen/android/`**:
  - `src/android/*.kt` → `gen/android/app/src/main/java/com/burningtreec/tiddlydesktop_rs/`
  - `src/android/res/*` → `gen/android/app/src/main/res/`
- `src/android/AndroidManifest.xml` and `build.gradle.kts` are likewise the source of truth that get
  merged/copied into the generated project.

### 1.3 Key config values

- `tauri.conf.json`: `identifier = com.burningtreec.tiddlydesktop-rs`; Android has its own
  `android.versionCode`. CSP explicitly allows `http://127.0.0.1:*` and `ws://127.0.0.1:*` (needed to
  talk to the local Node/HTTP servers) plus custom protocols (`wikifile:`, `tdasset:`, `tdlib:`).
- `build.gradle.kts`: `minSdk = 24`, `compileSdk/targetSdk = 36`, `namespace/applicationId =
  com.burningtreec.tiddlydesktop_rs`.
- **`packaging { jniLibs.useLegacyPackaging = true }`** in the release build — this is REQUIRED so
  that native `.so` files (including `libnode.so`) are **extracted to the filesystem** instead of
  loaded from inside the APK. An executable must exist as a real file on disk to be `exec()`-ed.

---

## Part 2 — Node.js integration (the important part)

Android forbids executing arbitrary binaries from app data dirs (W^X / `noexec` on the data
partition). The **only** directory where an app may execute a binary is its **native library
directory** (`ApplicationInfo.nativeLibraryDir`, e.g.
`/data/app/.../lib/arm64`). TiddlyDesktop-RS exploits this:

### 2.1 Ship Node.js as `libnode.so`

- A prebuilt **Termux `node` binary** (arm64) plus its shared-library deps are placed in
  `src-tauri/resources/node-bin/arm64-v8a/`:
  `node`, `libcrypto.so`, `libssl.so`, `libicu*.so`, `libsqlite3.so`, `libcares.so`, `libz.so`,
  `libc++_shared.so` (and `libpdfium.so` for PDF rendering).
- **`build.rs`** (`copy_node_to_jnilibs()`) copies these into
  `gen/android/app/src/main/jniLibs/arm64-v8a/`, **renaming `node` → `libnode.so`** (Android only
  packages files matching `lib*.so`). This runs whenever the cargo target OS is `android`.
- Because they live in `jniLibs`, Gradle unpacks them to `nativeLibraryDir` at install time, where
  they are executable.

At runtime, the node path is resolved as `nativeLibraryDir/libnode.so`
(`node_bridge::get_node_path()` / `ensure_node_binary()`), verified to exist and be > 1 MB.

### 2.2 Making the Termux binary run outside Termux

The Termux `node` was compiled with hardcoded paths under
`/data/data/com.termux/files/usr/...`. Two problems are solved:

1. **Versioned library names.** Node's `libnode.so` links against `libz.so.1`,
   `libcrypto.so.3`, `libssl.so.3`, `libicu*.so.78`, but Android only ships the *unversioned*
   `.so` files. `prepare_library_symlinks()` creates a `node-libs/` dir in app data with symlinks
   `libz.so.1 → nativeLibraryDir/libz.so`, etc. Then `LD_LIBRARY_PATH` is set to
   `"{node-libs}:{nativeLibraryDir}"` for every spawn.

2. **Termux env overrides** (`apply_termux_env_overrides()`), set on every `Command`:
   - `OPENSSL_CONF=/dev/null` — don't load Termux's `openssl.cnf`.
   - `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` → a CA bundle built once by concatenating all PEMs
     from `/system/etc/security/cacerts/` into `{app_data}/cacert.pem` (so HTTPS works).
   - `HOME` → `{app_data}/node_home` (Termux's home is inaccessible).
   - `TMPDIR` → `{app_data}/tmp` (`/tmp` isn't writable on Android).
   - `TZDIR=/system/usr/share/zoneinfo`.

### 2.3 Spawning Node

Node is spawned with `std::process::Command`:

```rust
let mut cmd = Command::new(node_path);            // nativeLibraryDir/libnode.so
cmd.env("LD_LIBRARY_PATH", ld_library_path);      // node-libs + nativeLibraryDir
apply_termux_env_overrides(&mut cmd);
cmd.env("TIDDLYWIKI_PLUGIN_PATH", ...);           // optional
cmd.env("TIDDLYWIKI_EDITION_PATH", ...);          // optional
cmd.arg(tiddlywiki_js).args(args);                // e.g. <folder> --listen port=NNNN host=127.0.0.1
cmd.current_dir(tw_dir);
```

Two spawn styles:

- **One-shot commands** (`run_tiddlywiki_command`) — `cmd.output()` and wait. Used for building a
  wiki file, converting file↔folder, rendering a folder wiki to HTML, etc.
- **Long-running server** (`start_wiki_server`) — `cmd.spawn()` running
  `tiddlywiki <folder> --listen port=NNNN host=127.0.0.1`; stderr is piped to a thread that forwards
  to logcat; then it polls `127.0.0.1:port` until the server accepts connections. Node servers use
  ports **38000–38999**.

### 2.4 TiddlyWiki resources are shipped as a ZIP, extracted on first run

- `build.rs` (`create_tiddlywiki_zip()`) zips `resources/tiddlywiki/` (the bundled TiddlyWiki5 +
  editions + plugins + `tiddlywiki.js`) into `$OUT_DIR/tiddlywiki.zip`.
- `lib.rs` embeds it: `static TIDDLYWIKI_ZIP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"),
  "/tiddlywiki.zip"))`.
- On first launch (`extract_tiddlywiki_resources`), the ZIP is unpacked to
  `{app_data}/tiddlywiki/`, guarded by a `.extracted` marker file that also encodes the version so
  an app update re-extracts (`needs_resource_extraction`).
- The Node binary is **not** in the ZIP (it must be in `jniLibs` to be executable) — only JS
  resources go through the ZIP.

---

## Part 3 — Process & Activity architecture

This is the part most relevant to your "WikiList always in foreground, spawn wikis from it" goal.

### 3.1 Two OS processes

- **Main process** — `MainActivity` (extends `TauriActivity`). Hosts the Tauri WebView showing the
  **landing page / wiki list**. Runs the Rust `setup()` (resource extraction, node-binary check,
  LAN sync manager, IPC server).
- **`:wiki` process** — a separate process (`android:process=":wiki"` in the manifest) hosting each
  **`WikiActivity`** and the **`WikiServerService`**. Because it's a distinct process, open wikis
  **survive the landing page being closed**.

Manifest highlights:

```xml
<activity android:name=".MainActivity" android:launchMode="singleTask" .../>  <!-- LAUNCHER -->
<activity android:name=".WikiActivity"
          android:documentLaunchMode="always"   <!-- each wiki = its own task in Recents -->
          android:process=":wiki"
          android:taskAffinity="" .../>
<service  android:name=".WikiServerService" android:process=":wiki"
          android:foregroundServiceType="specialUse"/>
<service  android:name=".LanSyncService"    android:foregroundServiceType="specialUse"/>
```

### 3.2 Launching a wiki from the list

The landing WebView calls a Tauri command `open_wiki_window(path, …)` (Rust). On Android this:

1. Reads display name + favicon from the wiki (via SAF for `content://` URIs).
2. Calls `wiki_activity::launch_wiki_activity(...)` which, **purely over JNI**, builds an
   `Intent(context, WikiActivity.class)`, stuffs extras (`wiki_path`, `wiki_title`, `is_folder`,
   `wiki_url`, `folder_local_path`, backup settings, `tiddler_title`) and calls
   `activity.startActivity(intent)`.
3. Before launching it first tries `WikiActivity.bringWikiToFront(...)` (scans `ActivityManager`
   AppTasks) so re-opening an already-open wiki just brings its task forward instead of duplicating.

The "current activity" is obtained reflectively from `ActivityThread.currentActivityThread()` — see
`wiki_activity::get_current_activity()`. The `JavaVM` is captured in **`JNI_OnLoad`** (`lib.rs`) and
stashed in a `OnceLock`; a cached app `ClassLoader` is used so app classes (`WikiActivity`,
`WikiServerService`) can be found from native threads (`find_app_class`).

### 3.3 Single-file vs folder wikis — how each is served

- **Single-file wiki**: `WikiActivity` (in `:wiki`) starts its own **Kotlin HTTP server**
  (`WikiHttpServer`, ports **39000–39999**) that serves the wiki HTML and handles `PUT`/TiddlyWeb
  saving via **SAF**. No Node needed for viewing/saving a single-file wiki. Media controls CSS,
  favicon conversion, range requests for media, etc. are injected/served here.
- **Folder wiki**: needs a real **Node TiddlyWiki server**.
  - Main process copies the SAF folder to a **local path** (`copy_saf_wiki_to_local`) — Node can't
    read `content://` — starts a sync watcher, and passes `folder_local_path` to `WikiActivity`.
  - `:wiki` process starts Node from that local path via a JNI call
    (`startFolderWikiServerFromLocal` → `node_bridge::start_wiki_server`), and the WebView loads
    `http://127.0.0.1:{port}`.
  - A watchdog restarts Node if it dies. (SAF wikis can't be restarted directly from `:wiki` since
    SAF needs the main Tauri process — hence the local-path indirection.)

### 3.4 Keeping things alive in the foreground (your hard requirement)

Android **cannot** truly guarantee an Activity is never killed, but TiddlyDesktop-RS gets as close as
possible with a combination:

1. **Foreground services with ongoing notifications** — `WikiServerService` (`:wiki`) and
   `LanSyncService` (main). A `foregroundServiceType="specialUse"` FGS with a persistent
   notification massively lowers the OOM-kill priority of the process and keeps it running while the
   UI is backgrounded. `WikiServerService` tracks an in-memory `AtomicInteger` of open wikis and
   stops itself when it hits zero (`START_NOT_STICKY` to avoid orphan notifications after a process
   death).
2. **WebView renderer priority** — `MainActivity.installRenderProcessCrashProtection()` calls
   `webView.setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, waivedWhenNotVisible=false)` so
   the renderer keeps high priority even in the background.
3. **Renderer-crash recovery** — overriding `onRenderProcessGone()` to return `true` (prevents the
   whole app being killed) and cleanly relaunching the process so Tauri's one-time `setup()` re-runs.
4. **Permissions**: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`,
   `WAKE_LOCK`.

Relevant knowledge notes: FGS uses in-memory counters (not `SharedPreferences`) because the process
can be killed and restarted; `START_NOT_STICKY` avoids spurious restarts; the main process must stay
alive with its WebView renderer for LAN sync connections.

### 3.5 File access — Storage Access Framework (SAF)

- Users can't grant blanket FS access; instead they pick a file/dir via SAF and the app persists the
  `content://` permission (`takePersistableUriPermission`). `fs_abstraction.rs` routes `content://`
  URIs to the Android `saf.rs` module and plain paths to `std::fs`.
- Gotchas already learned (worth carrying over): `InputStream.skip()` is O(n) for content streams
  (use `openFileDescriptor` + channel `position()`); `shouldInterceptRequest` does **not** support
  206 Partial Content, so media range requests must fall through to the real HTTP server;
  `shouldOverrideUrlLoading` must return `true` for external `http(s)` links (open in system
  browser), `false` only for the local wiki-server URLs.

### 3.6 Networking config

`res/xml/network_security_config.xml` permits cleartext to `127.0.0.1` / `localhost` (the Node and
Kotlin servers are plain HTTP). The Tauri CSP mirrors this.

---

## Part 4 — Mapping the NW.js TiddlyDesktop (this repo) onto Android

TiddlyDesktopOverhaul today (NW.js):

- `source/html/main.html` + the `plugins/tiddlydesktop` TW plugin render the **WikiList** (see
  `WikiList.tid`, `WikiListRow.tid`, `WikiListWindow.tid`, `window-list.js`).
- `node-main.js` is the Node context; `main.js` boots the app window.
- Single-file wikis open in NW.js windows (`wiki-file-window.js`); folder wikis run a TiddlyWiki Node
  server (`wiki-folder-main.js`) shown in a window (`wiki-folder-window.js`).
- Ships its own copy of `source/tiddlywiki` (TiddlyWiki 5.4.0) + `ws`.

NW.js gives you "browser + Node in one context". Android has no NW.js, so the equivalent is exactly
the TiddlyDesktop-RS split: **system WebView for UI + a spawned Node process for the server + a
native (JNI/Rust or pure-Kotlin) bridge for OS integration**. Conceptual mapping:

| NW.js concept                       | Android equivalent (TiddlyDesktop-RS model)                        |
|-------------------------------------|--------------------------------------------------------------------|
| `main.html` WikiList window         | `MainActivity` WebView showing the WikiList TW                     |
| `node-main.js` Node context         | Spawned `libnode.so` process(es)                                    |
| Single-file wiki NW window          | `WikiActivity` + Kotlin `WikiHttpServer` (or a Node `--listen`)     |
| Folder wiki + `tiddlywiki --listen` | `WikiActivity` + Node `--listen` on `127.0.0.1:PORT`               |
| `nw.Window.open`                    | `startActivity(Intent(WikiActivity))` over JNI                     |
| Node `fs` on real paths             | SAF (`content://`) + copy-to-local for Node; `fs_abstraction`       |
| Always-on desktop process           | Foreground service(s) + renderer priority                          |

---

## Part 5 — Recommended architecture for the Overhaul Android app

You explicitly want a **single Node process spawned at startup that hosts the WikiList**, with the
WikiList activity pinned foreground. Here is the concrete shape:

### 5.1 Startup: Node hosts the WikiList

- Ship `node` as `libnode.so` in `jniLibs/arm64-v8a` (+ its `.so` deps + symlink shim), exactly per
  Part 2. Ship `source/tiddlywiki` + `plugins/tiddlydesktop` as a `tiddlywiki.zip`, extracted to
  app data on first run.
- On app start (in a foreground service so it can't be killed), spawn:
  `libnode.so tiddlywiki.js <wikilist-folder> --listen host=127.0.0.1 port=PORT` where the
  wikilist-folder is a TiddlyWiki *folder wiki* built from `plugins/tiddlydesktop` (the WikiList
  UI). Point `MainActivity`'s WebView at `http://127.0.0.1:PORT`.
- The WikiList TW server persists the list of wikis (recent files / folder wikis) in its own store,
  just like the desktop `WikiList.tid` does.

> Note on the trade-off: TiddlyDesktop-RS deliberately does **not** run Node for the landing page
> (it uses Tauri's `wikifile://` protocol for the landing WebView and only spawns Node for folder
> wikis). Running Node for the WikiList too is closer to the NW.js model you're porting and is fine —
> just budget for ~1–2 s Node cold-start on first paint (show a splash) and keep the process under a
> foreground service.

### 5.2 Keeping the WikiList foreground / unkillable

- Start a **`foregroundServiceType="specialUse"`** service in `MainActivity.onCreate()` that owns the
  Node process lifecycle and shows a persistent notification. This is the single most effective
  lever against being killed.
- Set `webView.setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)`.
- Handle `onRenderProcessGone()` → return `true` and relaunch cleanly.
- `WAKE_LOCK` + optionally ask the user to exempt the app from battery optimization
  (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) for the strongest guarantee.
- Realistic expectation: Android can still kill a backgrounded process under extreme memory
  pressure; design for **clean restart** (re-extract check is idempotent, Node re-spawns, WikiList
  reloads) rather than assuming immortality.

### 5.3 Opening single-file & folder wikis "with all abilities"

- **Folder wiki**: same as RS — copy SAF → local, spawn a *second* Node `--listen` on another port,
  open a `WikiActivity` (own task, `documentLaunchMode="always"`) pointing at it, run a sync watcher
  back to SAF, watchdog-restart Node.
- **Single-file wiki**: either (a) the RS approach — a lightweight Kotlin/Rust HTTP server that
  serves the HTML and saves via SAF (no Node), or (b) if you want uniformity, a Node `--listen` on a
  temp folder built from the file. (a) is lighter and battery-friendlier; (b) is simpler to reason
  about if everything goes through Node. RS chose (a).
- "Rust/Tauri-enabled abilities" (native poster extraction, PDF rendering, clipboard, drag-drop,
  system bar colors, LAN sync) are exposed to the wiki JS via **`@JavascriptInterface`** bridges in
  `WikiActivity` and/or JNI calls into the Rust `.so`. Reuse the RS init-script injection model:
  scripts injected in `onPageFinished()` via `evaluateJavascript()`.

### 5.4 Do you even need Tauri?

Two viable paths:

1. **Tauri 2 mobile** (what RS uses): gives you the `TauriActivity`/WebView plumbing, a Rust command
   bridge, protocol handlers, and a shared desktop/Android Rust codebase. Heaviest but most capable;
   matches RS 1:1.
2. **Plain Android app (no Tauri)**: a normal `Activity` + `WebView` + a small Kotlin layer that
   spawns `libnode.so` and does SAF. Since the Overhaul app's logic already lives in JS/TiddlyWiki
   and Node, you may not need Rust at all — Kotlin can spawn Node and bridge SAF. This is
   significantly less machinery than Tauri and is a legitimate choice if you don't need the RS Rust
   features (native DnD, PDFium, etc.). The **Node-as-`libnode.so`** trick (Part 2) is independent of
   Tauri and works either way.

Given Overhaul is JS/Node-centric, **option 2 (Kotlin + WebView + libnode.so)** is likely the
leanest route to your stated goal; borrow RS's Node-embedding, SAF, foreground-service and
multi-activity patterns without dragging in the whole Rust/Tauri desktop codebase.

---

## Part 6 — Build & packaging checklist (from RS, reusable)

- **Native libs**: put `node`→`libnode.so` + deps in `app/src/main/jniLibs/arm64-v8a/`. Keep
  `jniLibs.useLegacyPackaging = true` in the release `packaging {}` block so they extract to disk.
  `pickFirsts`/`keepDebugSymbols` as needed for versioned/duplicated `.so`s.
- **Resources**: zip the TiddlyWiki + plugins, embed & extract on first run with a version marker.
- **Manifest**: `INTERNET`, `FOREGROUND_SERVICE(_SPECIAL_USE)`, `POST_NOTIFICATIONS`, `WAKE_LOCK`;
  cleartext to `127.0.0.1` via `network_security_config.xml`; landing activity `singleTask`; wiki
  activities `documentLaunchMode="always"` + `process=":wiki"`; FGS declarations.
- **Signing/build**: `zipalign` (build-tools 36.1.0) then `apksigner` with the debug keystore for
  test installs; `--aab` for Play. `JAVA_HOME` must be an **absolute** path.
- **arch**: RS ships **arm64-v8a only**. Add other ABIs only if you also provide matching Node
  binaries.

---

## Part 7 — Key files to study in TiddlyDesktop-RS

| File | What to learn from it |
|------|-----------------------|
| `src-tauri/build.rs` | Copy `node`→`libnode.so` into jniLibs; build `tiddlywiki.zip` |
| `src-tauri/src/android/node_bridge.rs` | Node path resolution, symlinks, Termux env, spawn (one-shot + `--listen`), SAF→local copy |
| `src-tauri/src/android/wiki_activity.rs` | JNI: capture JavaVM, find app classes, `launch_wiki_activity`, bring-to-front, system bar colors |
| `src-tauri/src/lib.rs` (`JNI_OnLoad`, `setup`, `open_wiki_window`, `extract_tiddlywiki_resources`) | Startup wiring, resource extraction, wiki launch commands |
| `src-tauri/src/android/MainActivity.kt` | Landing activity, renderer priority, crash recovery, FGS lifecycle hooks |
| `src-tauri/src/android/WikiActivity.kt` | Wiki WebView, injected savers/init scripts, JS↔native bridges (large, ~480 KB) |
| `src-tauri/src/android/WikiHttpServer.kt` | Kotlin HTTP server for single-file/folder wikis, SAF save, media, ranges |
| `src-tauri/src/android/WikiServerService.kt` | Foreground service keeping `:wiki` alive; per-wiki notifications |
| `src-tauri/src/android/AndroidManifest.xml`, `build.gradle.kts` | Manifest wiring, jniLibs packaging, SDK levels |
| `src-tauri/src/android/saf.rs`, `fs_abstraction.rs` | SAF read/write and the path/`content://` routing |

---

## Part 8 — Bridging the collab plugin (`plugins/codemirror-6-collab-nwjs/`)

The real-time collaboration plugin (Yjs + WebSocket relay + OAuth + LAN peers + asset sharing) is
written for **NW.js**, where the browser window also has Node.js (`require`) and an `nw.Shell` GUI
API. It runs as TiddlyWiki `module-type: startup` modules with `exports.platforms = ["browser"]`, so
**it always runs in the WebView/browser context, never in the Node server** — even for folder wikis.

On Android, the WebView is plain Chromium: **no `require`, no `nw.Shell`**, and the browser
`WebSocket`/`fetch` APIs are too limited for what the plugin needs. So the plugin's NW.js host
(`source/js/wiki-file-window.js`) injects a set of `window._nwjs*` bridge functions into the wiki
window; the plugin uses those when present and falls back to `require(...)` otherwise. **On Android
you reimplement exactly that same `window._nwjs*` contract**, backed by native code — then the
existing plugin runs unmodified.

### 8.1 Why native bridges are unavoidable (per API)

| Plugin need | Browser API limitation | Native bridge required |
|-------------|------------------------|------------------------|
| Relay REST calls (`/api/auth/*`) | `fetch` is **CORS-blocked** unless the relay sends CORS headers | native HTTP GET client that ignores CORS (+ follows redirects) |
| Relay WebSocket (`/room/...`) | Browser `WebSocket` **cannot set request headers** — plugin sends `Authorization: Bearer` + `X-Auth-Provider` at the WS upgrade | native WebSocket client with custom headers |
| OAuth login | must open the **system browser** | `Intent.ACTION_VIEW` |
| Asset (external-attachment) file read/write | no arbitrary filesystem under scoped storage | SAF-backed read/write |
| LAN direct peers | needs raw **TCP** listen/connect on ports 45700–45710 | native TCP transport (optional) |
| WebCrypto (`window.crypto.subtle`), random, base64, Yjs | already work in WebView | none (see §8.6) |

Note the OAuth flow uses the relay's **server-side callback + polling** design (fetch
`/api/auth/result?state=…` every 2 s), so **no `tiddlydesktop://` deep link is needed** — the app
never has to receive the OAuth redirect. That simplifies Android: just open the browser and poll.

### 8.2 The exact `window._nwjs*` contracts to implement

These are what the plugin calls/expects (from `oauth.js`, `transport.js`, `asset-util.js`). "Host"
= the thing you implement on Android; "plugin" = the collab code that stays unchanged.

**A. HTTP + open-browser** (`oauth.js`)
- Host sets `window._nwjsHttpQueue = []` and `window._nwjsHttpResults = {}`.
- Plugin pushes request objects `{id, url, headers}` onto `_nwjsHttpQueue`.
- Host performs the GET and writes the result as `_nwjsHttpResults[id] = {err, data}` where **`data`
  is the parsed JSON object** (not a string). Plugin polls/drains `_nwjsHttpResults` every 200 ms.
- Host defines `window._nwjsOpenExternal(url)` → open system browser.
- After wiring up, host **calls** `window._nwjsHttpQueueReady()` (defined by the plugin) once.

**B. Relay WebSocket** (`transport.js`) — text/JSON frames
- Host defines `window._nwjsWsCreate(url, headers)` → returns a numeric `bridgeId`.
- Host defines `window._nwjsWsSend(id, data)` (`data` is a JSON **string** for the relay).
- Host defines `window._nwjsWsTerminate(id)`.
- Host emits events by calling `window._nwjsWsOnEvent(id, type, data)` (defined by plugin), with
  `type ∈ {"open","message","ping","close","error"}`; for `message`, `data` = the text frame; for
  `error`, `data` = message string. (NW.js also adds a `User-Agent` header — harmless to mirror.)
- After wiring up, host **calls** `window._nwjsWsBridgeReady()` once so the transport connects.

**C. Asset file I/O** (`asset-util.js`)
- Host sets `window._nwjsWikiDir = <wiki base dir/identity>` (used for relative-path resolution).
- Host sets `window._nwjsFileCmdQueue = []` and `window._nwjsFileResults = {}`.
- Plugin pushes `{id, op:"read", path}` or `{id, op:"write", path, base64}`.
- Host writes `_nwjsFileResults[id] = {err, data}`: for `read`, `data` = **base64** of the file
  bytes; for `write`, `data` = the absolute path actually written. Plugin polls every 100 ms
  (timeout ~120 s).

**D. LAN direct peers** (`transport.js`) — *optional, advanced*
- Host defines `window._nwjsLanInit(...)`, `_nwjsLanAddPeer(deviceId, pubkey, endpoints)`,
  `_nwjsLanBroadcast(jsonString)`, `_nwjsLanClose()`.
- Host emits `window._nwjsLanOnReady(endpoints)`, `_nwjsLanOnMessage(jsonString)`,
  `_nwjsLanOnPeers(count)`; then calls `window._nwjsLanBridgeReady()`.
- The plugin hands the host **plaintext JSON**; the host owns the TCP sockets and the encrypted LAN
  wire framing (ports 45700–45710). This is the biggest native chunk — see §8.5.

### 8.3 Android implementation shape

Do it the same way RS injects its savers/init scripts: a **`@JavascriptInterface` object** added to
the wiki `WebView` plus a small **JS shim injected in `onPageFinished()`** that adapts the
`window._nwjs*` contract to the interface.

```kotlin
webView.addJavascriptInterface(CollabBridge(this, webView), "TDCollab")
// …in onPageFinished():
webView.evaluateJavascript(COLLAB_BRIDGE_SHIM_JS, null)
```

Injected shim (mirrors NW.js host, but calls native + uses real arrays so `Array.isArray` checks in
the plugin still pass):

```js
(function () {
  if (window.__tdCollabBridge) return; window.__tdCollabBridge = true;

  // A) HTTP + openExternal
  window._nwjsHttpResults = {};
  window._nwjsHttpQueue = [];
  window._nwjsHttpQueue.push = function (req) {           // override push, stays a real Array
    TDCollab.httpGet(req.id, req.url, JSON.stringify(req.headers || {}));
    return 0;
  };
  window._nwjsOpenExternal = function (url) { TDCollab.openExternal(url); };
  // native calls back: window._nwjsHttpResults[id] = {data: <obj>} | {err: "..."}

  // B) Relay WebSocket
  var wsSeq = 0;
  window._nwjsWsCreate = function (url, headers) {
    var id = ++wsSeq; TDCollab.wsCreate(id, url, JSON.stringify(headers || {})); return id;
  };
  window._nwjsWsSend      = function (id, data) { TDCollab.wsSend(id, data); };   // data = string
  window._nwjsWsTerminate = function (id) { TDCollab.wsClose(id); };
  // native calls back: window._nwjsWsOnEvent(id, type, data)

  // C) Asset file I/O (SAF)
  window._nwjsWikiDir = TDCollab.wikiDir();
  window._nwjsFileResults = {};
  window._nwjsFileCmdQueue = [];
  window._nwjsFileCmdQueue.push = function (cmd) {
    TDCollab.fileCmd(cmd.id, cmd.op, cmd.path, cmd.base64 || "");
    return 0;
  };

  // Signal readiness (order per plugin expectations)
  if (window._nwjsHttpQueueReady) window._nwjsHttpQueueReady();
  if (window._nwjsWsBridgeReady)  window._nwjsWsBridgeReady();
})();
```

Native side (Kotlin is simplest; Rust-via-JNI also fine):
- `httpGet(id, url, headersJson)`: **OkHttp** (or `HttpURLConnection`) GET on a background thread,
  follow redirects, parse body; then
  `webView.post { evaluateJavascript("window._nwjsHttpResults[$id]={data:$json}", null) }`
  (or `{err:'…'}`). JSON-encode carefully (the plugin does `JSON.parse`-equivalent by reading
  `.data` as an object — pass the raw JSON text as the object literal value).
- `wsCreate/wsSend/wsClose`: **OkHttp `WebSocket`** with a `Request.Builder().header(...)`.
  `WebSocketListener.onOpen/onMessage(text)/onClosed/onFailure` → `evaluateJavascript(
  "window._nwjsWsOnEvent($id,'message'," + JSON.stringify(text) + ")")`. OkHttp answers ping/pong
  automatically; the `"ping"` event is only a liveness hint and can be omitted or synthesized.
- `openExternal(url)`: `startActivity(Intent(ACTION_VIEW, Uri.parse(url)))`.
- `fileCmd(...)`: resolve against the wiki's **SAF tree** (DocumentFile) and read/write; return
  base64 / written path via `_nwjsFileResults`.

All `evaluateJavascript` calls must be marshalled onto the UI thread (`webView.post { }`).

### 8.4 Injection targets & timing

- Inject into the **WikiActivity WebView** for every opened wiki (the collab plugin lives in user
  wikis, not the WikiList). Injecting unconditionally is safe — the `_nwjs*` globals are inert
  unless the collab plugin is present and active.
- Inject **after** the page's TiddlyWiki has booted (RS uses `onPageFinished`). The plugin tolerates
  a late bridge: `transport._connect()` no-ops until `_nwjsWsBridgeReady()` fires, and OAuth waits
  for `_nwjsHttpQueueReady()`. If you also support `tm-open-window` iframe overlays (as RS does),
  **inject into the iframe document too** — it has its own `window`.

### 8.5 Phasing recommendation

1. **Phase 1 (relay collaboration works):** bridges **A (HTTP+openExternal)** and **B (WebSocket)**.
   This gives full OAuth sign-in and real-time relay sync — the core feature. Set the room to
   `relay-only` and you never touch LAN. Everything is text/JSON, no binary marshaling headaches.
2. **Phase 2 (asset sharing):** bridge **C**, scoped to files inside the wiki's granted SAF tree.
   Absolute / `file://` `_canonical_uri`s outside the tree can't be honoured under scoped storage —
   document that limitation or fall back to inline-embedding (the plugin already embeds when
   External Attachments is disabled, see `asset-util.storeExternally()`).
3. **Phase 3 (LAN peers, optional):** bridge **D** with a native TCP transport. Highest effort
   (sockets + the encrypted LAN framing the NW.js host owns) and least essential, since the relay
   already provides connectivity. Defer unless offline-LAN sync is a hard requirement.

### 8.6 Gotchas specific to the collab bridges

- **WebCrypto needs a secure context.** The plugin relies on `window.crypto.subtle` (X25519/ECDH,
  HKDF, AES-GCM) for E2E encryption. Chromium (and thus Android WebView) treats `http://127.0.0.1`
  and `http://localhost` as *potentially-trustworthy* secure origins, so `subtle` **is** available —
  **but only if you serve the wiki from `127.0.0.1`/`localhost`, not from a `file://` or a custom
  scheme.** Keep the local server on loopback.
- **Relay frames are text (JSON).** E2E is applied at the app layer (`{type:"enc", ct:<base64>}`
  inside JSON), so the relay WebSocket bridge only needs to carry **strings** — no binary marshaling.
  Only the LAN transport (Phase 3) uses binary frames (base64 across the JS↔native line if you get
  there).
- **CORS is the whole reason for bridge A.** Don't "simplify" it to `fetch` — the relay's
  `/api/auth/*` endpoints are not guaranteed to send CORS headers, and the plugin's `fetch` fallback
  is explicitly last-resort.
- **Custom headers are the whole reason for bridge B.** Browser `WebSocket` can't send
  `Authorization`, so you must use a native client (OkHttp). (Alternative only if you also control
  the relay: accept the token via `Sec-WebSocket-Protocol` — out of scope here.)
- **Device ID is per-session/random** and deliberately not persisted; nothing to store natively.
- Config the plugin reads/writes lives in ordinary tiddlers
  (`$:/config/codemirror-6-collab/relay-url`, `room-code`, `room-token`, `auth-token`, …) — no
  native storage needed; it rides along in the wiki's normal save path.

---

### TL;DR

The whole trick is: **Node ships as `libnode.so` in `jniLibs`** (the one executable location on
Android), **run via `Command` with `LD_LIBRARY_PATH` + symlinks + Termux env overrides**, serving
TiddlyWiki over `http://127.0.0.1:PORT` to a system **WebView**. The **WikiList is just a
TiddlyWiki** shown in the main Activity; **wikis open as separate Activities** in a `:wiki` process;
and **foreground services + renderer priority** are what keep it all alive in the background. All of
this is achievable with or without Tauri/Rust — for a JS/Node-centric port of this repo, a lean
Kotlin + WebView + `libnode.so` app is the most direct path.

For the **collab plugin**, the WebView lacks NW.js's `require`/`nw.Shell`, so you reimplement the
same `window._nwjs*` bridge contract the NW.js host provides — backed by a `@JavascriptInterface` +
an injected shim: a native **HTTP GET** client (CORS-free), a native **WebSocket** with custom
`Authorization` headers, **open-in-browser** for OAuth, and (optionally) **SAF file I/O** and a
**LAN TCP** transport. Bridges A+B alone (HTTP + WebSocket) unlock full OAuth + relay collaboration;
assets and LAN can follow in later phases.
