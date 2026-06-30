# CLAUDE.md

@./AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Building and Running

**Prerequisites:** Download nw.js binaries first (only needed once, or when the version in `nwjs-version.txt` changes):
```bash
./download-nwjs.sh
```

**Build:**
```bash
./bld.sh
```
This runs `npm install`, copies TiddlyWiki and the `ws` library into `source/`, injects translations, copies plugins and themes, stamps the collab plugin version, and assembles platform-specific builds in `output/`.

**Run (macOS only, from `run.sh` — update path for your platform):**
```bash
./run.sh
```
For Linux, run the built binary directly:
```bash
./output/linux64/TiddlyDesktop-linux64-v$(./bin/get-version-number)/TiddlyDesktop
```

There are no automated tests. The build CI triggers on `git push --tags`.

## Releasing

1. Bump `version` in `package.json`
2. Run `npm install --save` && commit & push
3. Tag: `git tag v0.0.XX && git push origin v0.0.XX`
4. CI builds all platforms and creates a draft GitHub release

## Architecture

TiddlyDesktop is an **NW.js** desktop app (Chromium + Node.js in the same process). There is no bundler or transpiler — the source is loaded directly by NW.js from `source/`.

### Entry points

- `source/package.json` — NW.js manifest. `main` → `html/main.html`, `node-main` → `js/node-main.js`
- `source/js/node-main.js` — earliest hook; clears stale Chromium locks/caches before the first window opens
- `source/js/main.js` — primary bootstrap; boots TiddlyWiki into the backstage wiki, creates the tray icon, and handles command-line arguments

### Window types

All windows inherit shared geometry persistence/restore from `window-base.js`. Three window classes:

| Class | File | Identity | Process |
|---|---|---|---|
| `BackstageWindow` | `backstage-window.js` | `backstage://<tiddler>` | Same as main |
| `WikiFileWindow` | `wiki-file-window.js` | `wikifile://<path>` | Same as main |
| `WikiFolderWindow` | `wiki-folder-window.js` | `wikifolder://<path>` | **New NW.js instance** (`new_instance: true`) |

`WindowList` (`window-list.js`) manages all open windows and URL dispatch (`file://`, `wikifile://`, `wikifolder://`, `backstage://`).

### The backstage wiki

TiddlyDesktop's own UI (wiki list, Settings, Help) **is itself a TiddlyWiki** running inside the main window. It boots the TiddlyWiki 5 core from `source/tiddlywiki/` (copied from `node_modules/tiddlywiki` during build) using the `source/js/utils/wiki.js`-determined backstage wiki folder in the user's app data directory.

The `tiddlydesktop` plugin (`plugins/tiddlydesktop/`) provides the UI tiddlers (WikiList, WikiListRow, WikiListWindow, etc.) bundled into the backstage wiki. Per-wiki config is stored as tiddlers titled `$:/TiddlyDesktop/Config/<type>/<identifier>`.

### Single-file wiki windows

`WikiFileWindow` opens a **nwdisable iframe** (no Node.js access) displaying the `.html` wiki file. The backstage-side JS (running with full Node access) bridges capabilities into the iframe via shared `window` properties and `setInterval` drain loops:

- **HTTP bridge** — `_nwjsHttpQueue` / `_nwjsHttpResults`: for OAuth polling
- **File bridge** — `_nwjsFileCmdQueue` / `_nwjsFileResults`: file read/write for collab attachments
- **WebSocket bridge** — `_nwjsWsCmdQueue` / `_nwjsWsEventQueue` + `_nwjsWsOnEvent`: for the collab relay connection
- **LAN bridge** — `_nwjsLanCmdQueue` / `_nwjsLanEventQueue`: for direct peer-to-peer collab (via `utils/lan-node.js`)

All bridges are torn down and rebuilt on every iframe (re)load via the `_iframeTeardowns` array.

### Folder wiki windows

`WikiFolderWindow` opens in a **separate NW.js process** (`new_instance: true`). The folder wiki runs its own TiddlyWiki Node.js server (`--listen`). Live title/favicon state is communicated back to the backstage via a JSON file written by the folder process and watched with `fs.watch` by the backstage.

### Key utilities (`source/js/utils/`)

- `embeds.js` / `embed-hosts.js` — routes allowlisted media iframes (YouTube, Vimeo, etc.) through a localhost HTTP shim so they play from `file://` pages
- `saving.js` — handles single-file wiki save-in-place with backup rotation
- `findbar.js` — browser-style find-in-page bar
- `zoom.js` — page zoom with Ctrl+/- and mouse wheel
- `fullscreen.js` — F11 fullscreen
- `startup-guard.js` — kills stale/hung NW.js instances, clears stale Chromium profile locks
- `deeplink.js` + `protocol.js` — `tiddlydesktop://` custom protocol for OAuth return

### Plugins

- `plugins/tiddlydesktop/` — the UI plugin (wiki list tiddlers, settings, etc.)
- `plugins/codemirror-6-collab-nwjs/` — NW.js transport shim for the CodeMirror 6 + Yjs collab plugin; its version is auto-derived at build time by `bin/stamp-collab-version.js` (major.minor from `plugin.info`, patch = git commit count)

### Translations

`translations/<lang>/` contain `.multids` and `.tid` files. `translations/build-translations.js` pre-processes them, then `bld.sh` injects them into the bundled TiddlyWiki language plugins and sets all language plugins to priority 100 so they win over the tiddlydesktop plugin's English defaults.

### Themes

`themes/` contains extra colour themes (elegant, noir, workbench, lucid, quietude, opaline, modern) copied into the TiddlyWiki theme library at build time, alongside TW's bundled vanilla and snowwhite.
