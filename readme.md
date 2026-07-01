# TiddlyDesktop

TiddlyDesktop is a special purpose web browser for working with locally stored TiddlyWikis. See http://tiddlywiki.com/ for more details of TiddlyWiki.

It works with both single-file wikis and TiddlyWiki folder (server) wikis, and supports both TiddlyWiki 5 and the classic 2.x.x version. This build adds real-time collaboration, per-wiki plugin management, single-file ⇄ folder conversion, serving folder wikis over the LAN, and window conveniences (fullscreen, zoom, find-in-page).

See this video tutorial for an overview of installing and using TiddlyDesktop on Windows and OS X:

https://www.youtube.com/watch?v=i3Bggkm7paA

It is based on nw.js, a project created and developed in the Intel Open Source Technology Center:

https://github.com/nwjs/nw.js

# Download and Install

Download the Windows, linux or Mac binary .zip files from:

https://github.com/TiddlyWiki/TiddlyDesktop/releases

Unzip into a folder and run the `TiddlyDesktop` launcher: `TiddlyDesktop.app` on macOS, `TiddlyDesktop.exe` on Windows, and `TiddlyDesktop` on Linux.

Note that TiddlyDesktop will not work correctly from a Windows UNC network share (eg ``\\MY-SERVER\SHARE\MyFolder``). You should map the network share to a local drive, and run it from there.

## Opening unsigned builds

The released binaries are not signed with a paid developer certificate, so the operating system shows a warning the first time you open them. This is expected; the steps below are a one-time bypass.

**macOS (Gatekeeper).** The app is ad-hoc signed so it launches (this is required on Apple Silicon), but macOS still flags it as coming from an unidentified developer. To open it:

* **Right-click** (or Control-click) `TiddlyDesktop.app` → **Open** → **Open** in the dialog. macOS remembers the choice for next time.
* If macOS says the app "is damaged and can't be opened" (the quarantine flag added by the browser download), clear it once:

  ```
  xattr -dr com.apple.quarantine /path/to/TiddlyDesktop.app
  ```

**Windows (SmartScreen).** When SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.

## Linux AppImage

Linux releases are also available in the AppImage format. The AppImages are compatible with glibc-based Desktop Linux distributions such as Ubuntu, Fedora, and Arch Linux. The AppImages are _not_ compatible with musl-based Linux distributions such as Alpine Linux, nor are they compatible with Linux server distributions; Server distributions don't provide enough of the required dependencies.

To use an AppImage, your Linux distribution must provide `fusermount3`, which is typically provided in a package named `fuse3`.

Before you can execute an AppImage, you must set the executable permission:

```
chmod u+x tiddlydesktop-*-v*.AppImage
```

*Note that AppImages are not currently included in TiddlyDesktop releases.* The suggested workaround is to fork this repo in GitHub, and then push a dummy commit to the master branch. That will trigger the CI and produce an AppImage, which you can then access.

## NixOS

<details>
  <summary>Flakes</summary>

  First add the repository to your inputs.

  Point to main branch:
  
  ```nix
  inputs = {
      ...
      tiddly-desktop.url = "github:TiddlyWiki/TiddlyDesktop";
      ...
  };
  ```

  Point to a rev in main branch:

  ```nix
  inputs = {
      ...
      tiddly-desktop.url = "github:TiddlyWiki/TiddlyDesktop/9715840d450b4febec4c24c6fdbd4f74a80a5a12";
      ...
  };
  ```

  Point to a tag:

  ```nix
  inputs = {
      ...
      tiddly-desktop.url = "github:TiddlyWiki/TiddlyDesktop/refs/tags/v0.0.20";
      ...
  };
  ```
    
  Then your outputs should look something like this:
  
  ```nix
  outputs = {...} @ inputs: { 
    # Don't forget to add nixpkgs to your inputs
    nixosConfigurations."nixos" = inputs.nixpkgs.lib.nixosSystem {
      ...
      specialArgs = {inherit inputs;};
      modules = [
        ./configuration.nix
        ... 
      ];
    };
  };
  ```
  
  And finally, somewhere in your `configuration.nix`:
  
  ```nix
  {inputs, pkgs, ...}: {
    ...
    environment.systemPackages = [
      # Note that if `pkgs.stdenv.hostPlatform.system` is anything
      # other than x86_64-linux (e.g., your system is ARM), this will fail.
      inputs.tiddly-desktop.packages.${pkgs.stdenv.hostPlatform.system}.default
    ];
    ...
  }
  ```
</details>

<details>
  <summary>Non-Flakes</summary>
  
  #### Pinning Tool
  
  First add the pin using your pinning tool.

  We assume you are using npins for this example but this can also be done
  with other similar tools (lon, niv, nvfetcher).

  Point to a branch:
  
  ```bash
  npins add github TiddlyWiki TiddlyDesktop -b master
  ```

  Point to a rev in main branch:

  ```bash
  npins add github TiddlyWiki TiddlyDesktop -b master --at 9715840d450b4febec4c24c6fdbd4f74a80a5a12
  ```

  Point to a tag:

  ```bash
  npins add github TiddlyWiki TiddlyDesktop --at v0.0.20
  ```

  Or point to latest release:

  ```bash
  npins add github TiddlyWiki TiddlyDesktop
  ```
  
  Then add the package to your `systemPackages`:
  
  ```nix
  let
    sources = import ./npins;
  in {
    environment.systemPackages = [
      (import sources.TiddlyDesktop)
    ];
  }
  ```
  
  #### No Pinning Tool
  
  ```nix
  let
    rev = "9715840d450b4febec4c24c6fdbd4f74a80a5a12"; # Or whatever rev you prefer
    twdesktop = import (fetchTarball "https://github.com/TiddlyWiki/TiddlyDesktop/archive/${rev}.tar.gz") { };
  in {
    environment.systemPackages = [
      twdesktop
    ];
  }
  ```
</details>

# Usage

## The wiki list

The main window lists your wikis. Add one by dragging a `.html` file or a wiki folder onto
the list, or with the **Create new wiki** / browse buttons. Each entry shows the wiki's
favicon and title, and a toolbar:

* **open** / **reveal** (show the file in your file manager) / **remove**.
* **to folder** / **to file** — convert a single-file wiki into a TiddlyWiki folder wiki, or
  vice versa. The original is left untouched; the title and favicon are carried over.
* **plugins** — browse and enable/disable TiddlyWiki plugins for that wiki.
* **advanced** — backup options for single-file wikis; for folder wikis, the server options
  below.
* **tags** — tag wikis and filter the list by tag.

(Convert and plugins are hidden for TiddlyWiki Classic wikis, which are single-file only.)

## Modifying your wiki list window

The wiki list is itself an ordinary TiddlyWiki running with a slim chrome. Click the **Backstage**
button in the toolbar to open the **full wiki behind the list**, where you can add and edit
tiddlers to customise it. Changes are saved into that backstage wiki and persist across restarts.

A few useful things you can do there:

* **Palette / dark mode** — pick a different `$:/palette` in the usual control panel; the list and
  toolbar re-colour live.
* **Custom CSS** — add a tiddler tagged `$:/tags/Stylesheet` with your own rules. Wiki-list
  elements use `td-…` class names (e.g. `.td-wikilist-item`, `.td-tags .tc-tag-label`).
* **Settings** — the empty-list message, language, and backup options live on the Settings page.

### Changing the colour of a tag in the wiki list

Tag chips use TiddlyWiki's standard tag-colour mechanism: a tag is coloured by a tiddler whose
**title is the tag name** and whose **`color`** field holds a CSS colour. To set one:

1. Open the **Backstage** (toolbar button).
2. Create a new tiddler whose **title is exactly the tag name** (for example `work`).
3. Add a field named **`color`** with a CSS colour value — a hex code such as `#e91e63`, an
   `rgb(…)`, or a named colour.
4. Save. The chip for that tag — in both the filter row and each wiki's tags — immediately uses
   the colour, with the text colour chosen automatically for contrast.

Delete the `color` field (or the whole tiddler) to revert to the palette's default tag colour.

## Installing extra plugins, themes, and languages

The **plugins** button on a wiki row lists everything TiddlyDesktop bundles **plus** anything you
place on three environment variables. This is how you make your own (or third-party) plugins,
themes, and languages installable into any wiki — without unpacking them into each wiki by hand.

| Variable | For | Layout under each directory |
|---|---|---|
| `TIDDLYWIKI_PLUGIN_PATH` | plugins | `<author>/<name>/` (nested), e.g. `TiddlyTools/Favicon/` |
| `TIDDLYWIKI_THEME_PATH` | themes | `<author>/<name>/` (nested), e.g. `nico/notebook/` |
| `TIDDLYWIKI_LANGUAGE_PATH` | languages | `<name>/` (flat), e.g. `fr-FR/` |

Each leaf folder is an ordinary TiddlyWiki **plugin folder** (a `plugin.info` manifest next to the
plugin's tiddler files). Each variable is a **list of directories** separated by the OS path
delimiter — `:` on Linux/macOS, `;` on Windows. These are the standard TiddlyWiki library
variables, so an existing `tiddlywiki` Node.js plugin library works unchanged.

Set them before launching. On Linux/macOS:

```
export TIDDLYWIKI_PLUGIN_PATH="$HOME/tw-library/plugins"
export TIDDLYWIKI_THEME_PATH="$HOME/tw-library/themes"
export TIDDLYWIKI_LANGUAGE_PATH="$HOME/tw-library/languages"
./TiddlyDesktop
```

On Windows (`setx` persists them for future sessions):

```
setx TIDDLYWIKI_PLUGIN_PATH "C:\tw-library\plugins"
```

**Why put them here rather than into each wiki:**

* **Install into any wiki from one place** — everything on these paths appears in the Plugin
  Chooser, so you can add it to any single-file or folder wiki (and remove it) from the wiki list,
  without opening the wiki.
* **Update once, everywhere** — folder wikis reference plugins/themes/languages **by name** and
  resolve them from these paths at boot, with no per-wiki copy to update; refresh the library and
  every folder wiki picks up the new version on its next start.
* **Live re-scan, no restart** — the paths are watched on disk, so dropping in or updating a plugin
  refreshes the chooser and its **Update** badges immediately.
* **Shared and versioned by you** — one library folder (git-managed, synced, backed up) instead of
  frozen copies scattered inside each wiki.
* **Feeds the wiki-list UI too** — extra languages appear in the language switcher.

Single-file wikis are self-contained, so installing embeds a **copy** into the file (it keeps
working if you move the file); folder wikis keep the by-name reference and stay in sync with the
library. See [Documentation.md §8](Documentation.md#8-plugin-management) for full details.

## Serving a folder wiki over the local network

A wiki folder runs its own TiddlyWiki server. Open a folder wiki's **advanced** options and
set:

* **Host** — `127.0.0.1` for this machine only, or `0.0.0.0` to allow access from other
  devices on your LAN.
* **Port** — e.g. `8080` (use a different port per open wiki).

Other devices can then open `http://<this-machine's-ip>:<port>/`. Further options
(path prefix, root tiddler, anonymous username, gzip, and the `credentials`/`readers`/
`writers` access settings) are available in the same panel. Changes take effect the next
time the wiki folder is opened.

To serve a *single-file* wiki on the LAN, convert it to a folder wiki first (or use the
real-time collaboration feature below for multi-device editing).

## Wiki window shortcuts

In a wiki window (single-file or folder):

* **Fullscreen** — `F11` (or TiddlyWiki's fullscreen button).
* **Zoom** — `Ctrl`/`Cmd` `+` / `-` / `0`, or `Ctrl`/`Cmd` + mouse wheel. A reset control
  appears top-left while the zoom isn't 100%.
* **Find in page** — `Ctrl`/`Cmd` `F` opens a browser-style find bar (it leaves the shortcut
  to a focused editor such as CodeMirror 6).

Window position and size are remembered per wiki.

## Embedded media (videos, maps, …)

Wikis can embed external media with an `<iframe>` (a YouTube video, a Vimeo clip, an
OpenStreetMap map, and so on). TiddlyDesktop makes these play reliably and safely:

* Embeds whose host is on an **allowlist** are routed through a tiny local `http://127.0.0.1`
  helper so the provider sees a real web origin and plays — single-file wikis are `file://`
  pages, which players like YouTube otherwise reject (error 153). The wiki file itself stays
  `file://`; the helper is bound to localhost only, only ever loads allowlisted hosts, and
  serves no files.
* Any other external iframe is left **exactly as the wiki wrote it** and loads normally — for
  example a plugin-library iframe pointing at `tiddlywiki.com`. The allowlist only decides what
  gets the `127.0.0.1` referer fix, not whether an iframe may load.

### Hosts allowed by default

Sub-domains are included automatically (e.g. `youtube.com` also allows `www.youtube.com`):

* **YouTube** — `youtube.com`, `youtube-nocookie.com`, `youtu.be`
* **Vimeo** — `vimeo.com`, `player.vimeo.com`
* **Dailymotion** — `dailymotion.com`
* **Spotify** — `open.spotify.com`
* **SoundCloud** — `soundcloud.com`, `w.soundcloud.com`
* **Bandcamp** — `bandcamp.com`
* **Twitch** — `player.twitch.tv`, `clips.twitch.tv`
* **Apple Music** — `embed.music.apple.com`
* **OpenStreetMap** — `openstreetmap.org`
* **Google Maps** — `google.com`
* **CodePen** — `codepen.io`
* **CodeSandbox** — `codesandbox.io`
* **JSFiddle** — `jsfiddle.net`
* **Internet Archive** — `archive.org`

### Adding your own domains

The allowlist is configured **per wiki**. If a media provider needs the `127.0.0.1` referer fix
to play and isn't in the defaults, create a tiddler titled
`$:/config/TiddlyDesktop/EmbedHosts` in that wiki and list the additional hosts in its text, one
per line (spaces or commas also work). They are *added* to the defaults above. (Other embeds load
fine without this — the list only controls the referer fix.)

```
vimeo.com
my.cdn.example
videos.example.org
```

Give just the host name — any `http(s)://` prefix or path is ignored, and sub-domains of what
you list are included. The change takes effect immediately (no restart needed). Removing a
host from the list (or deleting the tiddler) reverts to the built-in defaults.

## Multiple Configurations

To have separate mutliple instances of TiddlyDesktop (for example, separate Personal and Professional instances), you can pass the `--user-data-dir` argument.  e.g. `/opt/TiddlyDesktop/TiddlyDesktop --user-data-dir=/mnt/data/TiddlyWiki/config`.  The property should be a directory to use for holding configuration data.

## Developer Tools

The F12 key opens the Chromium developer tools for the current window.

## Debugging With VSCode

Instructions for Windows 10 64-bit (updates for other OSs welcome).

* Required software: VScode, Debugger for NWjs plugin installed in vscode
* Download the latest version of TiddlyDesktop-win64-v0.0.15 and unzip it to keep only four folders: html, images, js, tiddlywiki and package.json file
* Download nwjs-sdk-v0.69.1-win-x64, put it in C:\Users\your username\.nwjs folder and unzip it. After unzipping you can see the nw.exe program in the .nwjs\nwjs-sdk-v0.69.1-win-x64 folder to indicate that it is correct. (Again, you can use Ctrl + shift + p in vscode to bring up the command to execute the NWjs Install command and select the version to install)
* Use vscode to open the TiddlyDesktop-win64 folder
* Modify the "main" field in the package.json file to "html/main.html"
* Click 'Debug' and select nwjs to automatically create the configuration file laugh.json (no need to modify it). Then click Start to debug.

# Real-time collaboration

TiddlyDesktop includes an optional real-time collaboration plugin (CodeMirror 6 + Yjs). Peers in the same *room* edit shared tiddlers together, chat, and exchange attachments. All content is end-to-end encrypted; the relay server only ever sees ciphertext.

## What you need

* **Plugins.** For full collaboration functionality, install these TiddlyWiki plugins in each participating wiki:
  * **CodeMirror 6 editor** — the collaboration plugin integrates with it for real-time character-level sync.
  * **CodeMirror 6 edit-text** (`$:/plugins/tiddlywiki/codemirror-6-edit-text`) — routes the standard text editor through CodeMirror 6 so shared tiddlers co-edit live.
  * **External Attachments** (`$:/plugins/tiddlywiki/external-attachments`) — lets received attachments be saved to disk (via a *save-as* dialog) and recorded as `_canonical_uri` instead of being embedded inline.
* **The CodeMirror 6 editor** must be the active text editor (the collaboration plugin integrates with it).
* **A relay server.** Peers discover each other through a small relay (a TiddlyDesktop-to-TiddlyDesktop WebSocket server). You can use a shared one or self-host (see the separate `tiddlydesktop-relay` project). On the same LAN, peers also connect **directly** (encrypted) for lower latency; the relay is the fallback.
* **An OAuth sign-in** (GitHub / Google / GitLab / OIDC, depending on the relay). The relay only admits authenticated users, and peers cryptographically verify each other's identity.

## Quick start

1. Open the **Collab** tab in the sidebar and expand **Settings**.
2. Set the **Relay server URL** (e.g. `wss://relay.example.com:8443/`).
3. Sign in under **Account** with one of the offered providers.
4. Set a **Room code** (a shared name) and, for true end-to-end privacy, a **Room token** (a shared secret that is *never* sent to the relay).
5. Click **Connect**. The status bar (bottom-right) shows the connection state, a `🔒 end-to-end encrypted` badge when a room token is set, and `LAN ⚡` when a direct connection is active.

To bring others in, click **Invite** to copy an invite code (it carries the room token out-of-band) and have them paste it into **Join**.

## Sharing tiddlers

* Each tiddler gains a **share** button (the plugin icon) in its toolbar while you're connected. Click it to share that tiddler with the room — you become its *owner*.
* Other peers see shared tiddlers in the **Get** panel (top of the collaboration dock, bottom-right). Click **Get** to fetch a copy and subscribe to live updates. A tiddler you've Got shows its share button in **blue**.
* Editing a shared tiddler in the CodeMirror 6 editor syncs character-by-character with anyone else editing it; the edit banner shows who else is in the tiddler.
* **Attachments**: a tiddler backed by a file (`_canonical_uri`) or an embedded image/binary can be fetched as an attachment. If you have the **External Attachments** plugin enabled, **Get** offers a *save-as* dialog and stores the file on disk (recording the path per your External Attachments relative/absolute settings); otherwise it's embedded inline. Attachments stream privately to the requester only.

## Chat

The collaboration dock has a **Chat** panel:

* **Everyone** — a room-wide message (encrypted with the room key).
* **A single peer** — pick them from the selector for an *exclusive* 1:1 conversation, encrypted with a pairwise key so no other room member can read it.

## Security notes

* **End-to-end**: set a **Room token** for true privacy — the key is derived from it and never reaches the relay. Without a token, traffic is still encrypted, but with a key the relay knows (room-code mode).
* **Peer authentication**: the relay signs a certificate for each connection; peers verify it, so in token mode you only ever exchange traffic with verified, OAuth-authenticated users.
* **System tiddlers** (`$:/…`) are *not* shared or accepted by default. You can opt in ("Allow system tiddlers") to share things like palettes or macros, but **executable** tiddlers (JavaScript, raw markup, plugins) and your own collaboration/plugin configuration are *always* refused — a peer can never run code on your machine.
* **Relay only**: tick this to disable the direct LAN channel (avoids opening a listening socket / firewall prompt); collaboration still works through the relay.

## Settings reference

All settings live in the **Collab** sidebar tab (and the Settings page):

* Relay server URL, Room code, Room token, Display name, Colour
* **Maximum attachment size (MB)** — attachments larger than this are refused
* **Relay only** — disable direct LAN
* **Allow system tiddlers** — opt in to sharing/getting `$:/…` tiddlers (never executable ones)

If peers run different plugin builds, a **version mismatch** warning appears in the sidebar — keep everyone on the same build, as the wire protocol can change between versions.

# Troubleshooting

## Linux: Wayland display issues (drag & drop, window frames, dialogs)

On Linux, nw.js (Chromium) defaults to its Wayland backend on Wayland sessions. Under some compositors this causes glitches such as:

* drag & drop not working correctly (for example, dragging tiddlers between windows, or dropping files onto the wiki list)
* missing, doubled, or oddly-decorated window frames and title bars
* native dialogs and prompts appearing in the wrong place or behaving strangely
* incorrect window sizing, positioning, or focus

If you hit any of these, force the X11 (XWayland) backend by launching `TiddlyDesktop` with the `--ozone-platform=x11` flag:

```
./TiddlyDesktop --ozone-platform=x11
```

This can be combined with other arguments, e.g.:

```
./TiddlyDesktop --ozone-platform=x11 --user-data-dir=/path/to/config
```

To make it permanent you can wrap the launcher in a small script or shell alias, or set the environment variable instead of passing the flag:

```
OZONE_PLATFORM=x11 ./TiddlyDesktop
```

Most desktop-drag-and-drop and window-decoration problems on Wayland are resolved by running under X11 this way.

## Windows: UNC network shares

TiddlyDesktop will not work correctly when run from a Windows UNC network share (e.g. ``\\MY-SERVER\SHARE\MyFolder``). Map the network share to a local drive letter and run it from there.

## Resetting / isolating configuration

If TiddlyDesktop is behaving unexpectedly, you can start it against a clean configuration directory with `--user-data-dir` (see [Multiple Configurations](#multiple-configurations)). This is also useful for keeping separate instances from interfering with each other.

# Releasing with Continuous Integration

1. Update the version number in package.json, plus any other changes that should be included
2. Run `npm install --save`
2. Make a commit and push it
3. Check the build output in the GitHub Actions tab
3. Tag that commit with `git tag v0.0.22`, the version number you just updated in package.json
4. Push that tag with `git push origin v0.0.22` and a draft release will be created
5. Edit the draft release: add release notes, edit whatever else might need to be changed. Download its build files and test them
6. Switch the draft release to be a public release once it's tested and ready

# Building

Building uses Node.js (the CI builds with Node.js 24).

1. Run `download-nwjs.sh` to download the nw.js binaries. (The CI passes `PLATFORM`, `ARCH`, `EXT` and `NWJS_VERSION` in the environment to fetch a single target; set them to build just the platform you need.)
2. Run `bld.sh`. It runs `npm install` — which pulls in TiddlyWiki5 as a dependency, so there is **no** separate TiddlyWiki5 clone to manage — then bundles the TiddlyDesktop plugins, propagates the version, and builds into `output/`. The collaboration plugin's own (decoupled) version is derived here (`bin/stamp-collab-version.js`): `major.minor` come from its `plugin.info`, and the patch is the number of commits touching the plugin since that `major.minor.0` was set. So it auto-bumps (0.2.0 → 0.2.1 → 0.2.2 …) whenever its source changes, and you start a fresh line by committing a new `major.minor.0` in `plugin.info`. This needs full git history, which the CI provides via `fetch-depth: 0`.
3. Run the build for your platform from `output/`, e.g. `output/linux64/`, `output/linuxarm64/`, `output/win64/`, `output/win32/`, `output/mac64/` or `output/macapplesilicon/`.
