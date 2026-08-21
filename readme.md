# TiddlyDesktop

TiddlyDesktop is a small desktop app for working with [TiddlyWiki](https://tiddlywiki.com/)s that
live on your own computer. It keeps a list of your wikis, opens each one in its own window, and
takes care of saving — so a single-file wiki behaves like a real application instead of a browser
download.

It handles **single-file** wikis (`.html`) and **TiddlyWiki folder** (server) wikis, and supports
both TiddlyWiki 5 and the classic 2.x line. On top of upstream TiddlyDesktop, this build adds:

* per-wiki **plugin, theme and language management** (no unpacking plugins by hand)
* single-file ⇄ folder **conversion**
* **real-time collaborative editing**, end-to-end encrypted
* serving a folder wiki **over the LAN**
* safe **embedded media** (YouTube, Vimeo, maps, …), **external attachments**, spellcheck,
  fullscreen, zoom, find-in-page, dark mode and a live language switcher

Version **0.0.23** · runtime **NW.js 0.114.0** · bundled **TiddlyWiki 5.4.0**

📖 **[Documentation.md](Documentation.md)** is the full manual — this page is the short version.

📱 An **Android** port (Kotlin + WebView + embedded Node.js) lives in
[`TiddlyDesktopAndroid/`](TiddlyDesktopAndroid/README.md) — the same wiki-list UI and most
features, including collaboration.

## Install

Download from the [releases page](https://github.com/TiddlyWiki/TiddlyDesktop/releases):

| Platform | File |
|---|---|
| Windows | `tiddlydesktop-win64-v*.zip` (or `win32`) |
| macOS | `tiddlydesktop-macapplesilicon-v*.zip` (Apple Silicon) or `mac64` (Intel) |
| Linux | `tiddlydesktop-linux64-v*.zip` / `linuxarm64`, or the matching `.AppImage` |
| Android | `tiddlydesktop-android-v*.apk` |

Unzip and run the launcher: `TiddlyDesktop.exe`, `TiddlyDesktop.app`, or `TiddlyDesktop`.

Files with a **`-dev`** suffix are the same app built against the NW.js SDK — they add the
Chromium developer tools (`F12`). Use the plain builds unless you are debugging.

**Unsigned builds.** The binaries are not signed with a paid developer certificate, so your OS
warns on first launch:

* **macOS** — right-click (or Control-click) `TiddlyDesktop.app` → **Open** → **Open**. If macOS
  says the app "is damaged", clear the download quarantine flag once:
  `xattr -dr com.apple.quarantine /path/to/TiddlyDesktop.app`
* **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

**AppImage.** Needs `fusermount3` (package `fuse3`) and a glibc-based desktop distribution — not
musl (Alpine) or server images. Make it executable first: `chmod u+x tiddlydesktop-*.AppImage`.

**Windows network shares.** TiddlyDesktop does not work correctly when run from a UNC path
(`\\SERVER\SHARE\Folder`). Map the share to a drive letter and run it from there.

<details>
<summary><b>NixOS</b></summary>

**Flakes** — add the repo to your inputs, pointing at a branch, a revision or a tag:

```nix
inputs.tiddly-desktop.url = "github:TiddlyWiki/TiddlyDesktop";                        # master
inputs.tiddly-desktop.url = "github:TiddlyWiki/TiddlyDesktop/9715840d450b4feb";       # a rev
inputs.tiddly-desktop.url = "github:TiddlyWiki/TiddlyDesktop/refs/tags/v0.0.23";      # a tag
```

Then, in `configuration.nix` (with `inputs` passed through `specialArgs`):

```nix
{inputs, pkgs, ...}: {
  environment.systemPackages = [
    # Fails on systems other than x86_64-linux.
    inputs.tiddly-desktop.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}
```

**Without flakes** — pin with npins (or lon / niv / nvfetcher):

```bash
npins add github TiddlyWiki TiddlyDesktop -b master     # branch
npins add github TiddlyWiki TiddlyDesktop --at v0.0.23  # tag
npins add github TiddlyWiki TiddlyDesktop               # latest release
```

```nix
let sources = import ./npins;
in { environment.systemPackages = [ (import sources.TiddlyDesktop) ]; }
```

Or with no pinning tool at all:

```nix
let
  rev = "9715840d450b4febec4c24c6fdbd4f74a80a5a12";
  twdesktop = import (fetchTarball "https://github.com/TiddlyWiki/TiddlyDesktop/archive/${rev}.tar.gz") { };
in { environment.systemPackages = [ twdesktop ]; }
```
</details>

## Using it

### The wiki list

The main window lists your wikis. Add one by dragging a `.html` file or a wiki folder onto the
list, or with the **Create new wiki** / browse buttons. Each row shows the wiki's favicon and
title plus a toolbar:

* **open** · **reveal** (show in your file manager) · **remove**
* **to folder** / **to file** — convert between a single-file wiki and a folder wiki. The original
  is left untouched; title and favicon are carried over.
* **plugins** — enable or disable plugins, themes and languages for that wiki, without opening it.
* **advanced** — backup options for single-file wikis; server options for folder wikis.
* **tags** — tag wikis and filter the list.

(Convert and plugins are hidden for TiddlyWiki Classic wikis, which are single-file only.)

The list is itself an ordinary TiddlyWiki. The **Backstage** toolbar button opens the full wiki
behind it, where you can change the palette, add a stylesheet (elements use `td-…` class names),
pick a language, or set a tag's colour — all persisted across restarts.

### In a wiki window

* **Fullscreen** `F11` · **Zoom** `Ctrl`/`Cmd` `+` `-` `0` or `Ctrl`/`Cmd` + wheel ·
  **Find in page** `Ctrl`/`Cmd` `F` (yields to a focused CodeMirror editor)
* **Spellcheck** — Chromium's local dictionary, on by default; pick the language under
  Settings → Spellcheck (a language change applies the next time you start ~TiddlyDesktop).
  Nothing you type leaves the machine.
* Window position and size are remembered per wiki.

### Your own plugin, theme and language library

The **plugins** button lists everything TiddlyDesktop bundles *plus* anything found on three
environment variables — the standard TiddlyWiki library variables, so an existing `tiddlywiki`
plugin library works unchanged:

| Variable | For | Layout |
|---|---|---|
| `TIDDLYWIKI_PLUGIN_PATH` | plugins | `<author>/<name>/` |
| `TIDDLYWIKI_THEME_PATH` | themes | `<author>/<name>/` |
| `TIDDLYWIKI_LANGUAGE_PATH` | languages | `<name>/` |

Each variable is a list of directories separated by `:` (Linux/macOS) or `;` (Windows), and each
leaf folder is a normal plugin folder (a `plugin.info` next to its tiddlers). Set them before
launching:

```
export TIDDLYWIKI_PLUGIN_PATH="$HOME/tw-library/plugins"
./TiddlyDesktop
```

Why keep a library instead of copying into each wiki: install into any wiki from one place, update
once for every folder wiki (they reference plugins *by name*), and drop files in while the app runs
— the paths are watched, so the chooser and its **Update** badges refresh immediately. Single-file
wikis are self-contained, so installing embeds a copy into the file.
See [Documentation §8](Documentation.md#8-plugin-management).

### Serving a folder wiki over the LAN

A folder wiki runs its own TiddlyWiki server. In its **advanced** options set **Host** to
`0.0.0.0` (instead of `127.0.0.1`) and pick a **Port**; other devices then open
`http://<your-ip>:<port>/`. Path prefix, root tiddler, gzip and the
`credentials`/`readers`/`writers` access settings live in the same panel, and take effect the next
time the wiki is opened. To share a single-file wiki, convert it to a folder wiki first — or use
collaboration. See [Documentation §15](Documentation.md#15-folder-wikis-and-serving-over-the-lan).

### Embedded media

Wikis can embed external media in an `<iframe>` — YouTube, Vimeo, Spotify, OpenStreetMap and
[a dozen more hosts](Documentation.md#13-embedded-media-videos-maps-) are allowlisted by default,
with sub-domains included. Add extra hosts per wiki in a tiddler titled
`$:/config/TiddlyDesktop/EmbedHosts`, one host per line; they are added to the defaults, and take
effect immediately.

The allowlist decides which embeds get routed through a loopback helper that fixes the `Referer`
some players demand (YouTube's error 153). It does **not** decide whether an iframe may load: any
other external iframe is left exactly as the wiki wrote it.

### Several separate setups

Pass `--user-data-dir` to keep independent instances (say, personal and work):

```
./TiddlyDesktop --user-data-dir=/path/to/config
```

This is also the way to test against a clean configuration if something misbehaves.

## Real-time collaboration

TiddlyDesktop bundles an optional collaboration plugin (CodeMirror 6 + Yjs). Peers in the same
*room* co-edit shared tiddlers character-by-character, chat, and exchange attachments. Everything
is end-to-end encrypted; the relay server only ever sees ciphertext.

**You need:** the **CodeMirror 6** editor plugins in each participating wiki — they are not
bundled, so fetch them and point `TIDDLYWIKI_PLUGIN_PATH` at them (see above) to install them from
the **plugins** button. **External Attachments**, for saving received files to disk, *is* bundled.
You also need a **relay server** (self-host the separate `tiddlydesktop-relay` project, or use a
shared one) and an **OAuth sign-in** on it (GitHub, Google, GitLab or OIDC), which is what lets
peers verify each other's identity.

**Quick start:** open the **Collab** sidebar tab → **Settings**, set the relay URL, sign in under
**Account**, then click **Invite** to mint a room and copy an invite code for the others to paste
into **Join**. On a LAN, peers also connect directly (still encrypted) for lower latency.

A **room token** is required. The encryption key is derived from it and it is *never* sent to the
relay — it travels out of band, inside the invite code. Generating an invite mints one for you;
a room configured by hand with only a room code will refuse to connect, because the relay knows
the room code and could therefore read everything.

Other things worth knowing:

* Each tiddler gains a **share** button while you are connected; peers pick shared tiddlers up
  from the **Get** panel. Attachments stream privately to the requester only.
* Chat is either room-wide or an exclusive 1:1 conversation with a pairwise key.
* **System tiddlers** (`$:/…`) are not shared or accepted unless you opt in — and **executable**
  ones (JavaScript, raw markup, plugins) never are, so a peer cannot run code on your machine.
* **Relay only** disables the direct LAN channel if you would rather not open a listening socket.
* Keep everyone on the same plugin build; a version-mismatch warning appears if you do not.

Full details in [Documentation §17](Documentation.md#17-real-time-collaboration).

## Security

Every wiki window is served from its own token-gated `127.0.0.1` origin — its own port, so wikis
cannot reach each other's storage — and renders with no Node.js access. Attachments outside the
wiki's directory get a *second* origin, which is what keeps script from laundering their bytes out
through a canvas. Folder wikis run their TiddlyWiki server as a confined child process rather than
inside the window.

A wiki reads files **inside its own folder** freely; anything else — an attachment stored
elsewhere, say — is served only after you grant that wiki access to that path in a dialog
TiddlyDesktop opened. Grants are listed and revocable under **Settings → Trusted paths**. A folder
wiki that genuinely needs Node can be run **without the sandbox** from its advanced options, which
gives its scripts full access to your machine — only for wikis you trust completely.

* [Documentation §25](Documentation.md#25-security-model) — the user-facing summary
* [`docs/security-model.md`](docs/security-model.md) — how the confinement works, including which
  facts about it were measured rather than assumed
* [`docs/security-audit-2026-08.md`](docs/security-audit-2026-08.md) — the written audit of the
  wiki-reachable surface

## Troubleshooting

**Linux/Wayland — drag & drop, window frames or dialogs misbehaving.** Chromium's Wayland backend
glitches under some compositors: broken drag & drop, missing or doubled title bars, misplaced
dialogs, wrong window sizing. Force X11/XWayland:

```
./TiddlyDesktop --ozone-platform=x11
```

The flag combines with others, and `OZONE_PLATFORM=x11` in the environment does the same — handy
for a wrapper script or shell alias.

**Something else is wrong.** Try a clean profile with `--user-data-dir`, and see
[Documentation §22](Documentation.md#22-troubleshooting).

## Building from source

Needs Node.js (CI builds on Node 24). There are no npm scripts — the build is script-driven:

```
./download-nwjs.sh   # fetch the NW.js binaries (version in nwjs-version.txt)
./bld.sh             # npm install, bundle plugins, stamp versions, build into output/
./package.sh         # zip each build (and produce the Linux AppImages)
```

`bld.sh` builds every platform locally; set `PLATFORM`/`ARCH` (as CI does) to build just one. Run
the result from its output directory — `output/linux64/`, `output/win64/`,
`output/macapplesilicon/`, and so on. `./run.sh` builds and launches the macOS Apple-Silicon build
with `--debug`.

`npm install` pulls in TiddlyWiki5 as a dependency, so there is no separate TiddlyWiki clone to
manage. The collaboration plugin is versioned independently: `major.minor` from its `plugin.info`,
patch = commits touching the plugin since that `major.minor.0`. That needs full git history, which
CI provides with `fetch-depth: 0`.

See [`AGENTS.md`](AGENTS.md) for code style and contribution rules, and
[Documentation §24](Documentation.md#24-architecture-and-internals) for the architecture.

### Cutting a release

1. Bump `version` in `package.json`, run `npm install --save`, commit and push.
2. Tag that commit (`git tag v0.0.23`) and push the tag (`git push origin v0.0.23`).
3. CI builds every platform plus the Android APK and opens a **draft** release.
4. Download the artefacts, test them, add release notes, then publish.

A manual run from the Actions tab instead publishes a rolling `preview` pre-release — builds for
testers without cutting a version tag.

## Credits and licence

TiddlyDesktop was created by Jeremy Ruston and is built on [NW.js](https://github.com/nwjs/nw.js),
from the Intel Open Source Technology Center. Licensed under the BSD licence — see
[`LICENSE`](LICENSE).

There is also an older [video tutorial](https://www.youtube.com/watch?v=i3Bggkm7paA) covering
installation and basic use on Windows and macOS (it predates most of the features above).
