# Security model

How TiddlyDesktop confines the wikis it opens, and which facts about that confinement were
**measured** rather than assumed. Re-deriving the measured parts is expensive, and getting several
of them wrong is an RCE, so they are recorded here with their results.

This consolidates the design document that accompanied the move off `file://`
(`DESIGN-http-wiki-origin.md`, removed once the work landed — it is still in the git history if you
want the full narrative, the rejected alternatives and the phase breakdown).

## The problem this replaces

Wikis used to load from `file://` with `--allow-file-access-from-files`, which let any wiki's script
read any file on disk. Folder wikis were worse: they booted TiddlyWiki into the window itself, so a
downloaded folder wiki was arbitrary code execution by design.

## Origins

Every wiki window takes two OS-assigned ports (`listen(0)`) when it opens:

| origin | serves |
|---|---|
| wiki port | the parent shell at `/__tiddlydesktop_shell__/...`, and the wiki document plus its own directory at `/wiki/...` |
| attachment port | granted external attachments that live outside the wiki directory |

Attachments get a **different port, and therefore a different origin**, deliberately: that is what
makes a canvas drawn from an attachment *tainted*, so `getImageData()` / `toDataURL()` throw and
script cannot launder media bytes out through a canvas.

Both servers require a per-session token, because on a shared machine any local process can reach a
loopback port. `TiddlyDesktopAndroid/.../server/SingleFileWikiServer.kt` does the same thing and is
the reference implementation.

Ports are not stable and nothing is keyed to them. Per-window ports are what give each wiki its own
origin, so wikis can no longer reach each other's cookies and storage — something the `file://`
architecture never offered.

## Node is scoped by path, not by port

```json
"node-remote": "http://127.0.0.1:*/__tiddlydesktop_shell__/*"
```

The shell path gets Node; `/wiki/...` on the *same origin* does not. Verified against NW.js 0.114.0:
with an OS-assigned port, `/__tiddlydesktop_shell__/index.html` got full Node while `/wiki/notes.html`
on the same origin got none. The port wildcard is safe because the path does the scoping.

Do not "fix" this to an exact port. Dynamic ports are what removed the collision and
stale-instance failure modes, and per-window ports are what provide origin isolation.

`node-remote` forms that do **not** work, measured so nobody re-derives them:

| form | result |
|---|---|
| single string, port or path wildcard | reliable |
| array of patterns | **crashes** when granting Node to a second matching window |
| host wildcard (`http://*.localhost:45721/*`) | **crashes** |
| space-separated patterns in one string | **silently matches nothing** — fails closed, but silently |

The space-separated case is the dangerous one: a typo leaves you believing Node is scoped when
nothing matches at all. Per-wiki hostnames (`a.localhost`) were rejected for the same reason — they
need a host wildcard or an array, and both crash.

## `nwdisable` and `nwfaketop` are both required

Neither is sufficient alone. Measured with a same-origin child iframe trying to climb to the shell's
Node:

| iframe attributes | own Node | `window.parent` | outcome |
|---|---|---|---|
| `nwdisable nwfaketop` | none | is self | **blocked** |
| `nwdisable` only | none | real parent | `parent.require("child_process")` → **executed** |
| `nwfaketop` only | present | is self | **executed** |
| neither | present | real parent | executed |

`nwdisable` strips the frame's own Node but leaves `window.parent` reachable, so a same-origin child
simply borrows the shell's `require`. `nwfaketop` closes that by making `window.parent` and
`window.top` resolve to the frame itself.

`nwfaketop` is therefore a **security control, not a compatibility shim**, despite a name that
suggests it only adjusts `window.top` for TiddlyWiki's benefit. Removing either attribute — or
adding a same-origin frame without both — is an immediate RCE.

## Trust is the boundary, not the byte type

A wiki may read anything at a path it has been granted, media included. The wiki writes the
tiddler's `type` field, which the server cannot see, so a wiki wanting an image's bytes just
declares it `text/plain` and lets `loadRemoteTiddler` XHR it. No-CORS responses and content-type
rules are hardening, not boundaries.

Granularity is the control: per-file grants are the default and folder grants are explicit. Grants
live outside the wiki (`source/js/utils/trust.js`) so they survive wiki tampering — a wiki that could
write its own grants would grant itself everything.

## Folder wikis run TiddlyWiki as a confined child process

`source/js/wiki-folder-server.js` spawns it under Node's permission model rather than booting it
in-window, which is what makes confinement possible at all — the model cannot be applied to an
already-running process. Our own binary is the interpreter: with `NWJS_START_AS_NODE=1` it runs as
plain Node (v26.1.0 on our build).

```
--permission --allow-net --allow-fs-read=* --allow-fs-write=<wiki folder> --allow-fs-write=<tmp>
```

**Reads are deliberately not scoped**, and this must not be "tightened" without re-measuring:

- Node's module resolution stats every ancestor directory of the script and the wiki, walking up
  looking for `node_modules`.
- `--allow-fs-read=<dir>` grants that directory *recursively*, with no "this directory only" form.
  Satisfying a stat on `/home/<user>` would therefore grant the entire home directory.
- An incomplete list does not fail soft. On this NW.js build a denied access aborts the process on
  an internal assertion (`NodePlatform::UnregisterIsolate`) instead of raising a catchable
  `ERR_ACCESS_DENIED`, so the wiki's server simply dies.

Writes are what actually contain a hostile wiki, and those are scoped. Android ships the same shape.

The child does not die with its window, so both teardown paths must stop it: the window's close
handler and `quitApp()`, which force-closes windows and skips close handlers entirely.

## Android

The same principles, different mechanisms:

- Folder wikis run `tiddlywiki --listen` under the same `--permission` flags, behind an `AuthProxy`
  that holds the credential so the WebView never sees it. Loopback is not private on Android — any
  app holding the ordinary `INTERNET` permission can reach another app's port.
- Bridges exposed to a wiki's own WebView (`TDCollab`, `TDShare`, `TDAttach`, `TDWindow`, `TDWikiUX`)
  are the main attack surface, because wiki JavaScript can call them directly. Any path they accept
  MUST be confined — see `WikiActivity.stagedShareFile` and `CollabBridge.confinedFile`, which both
  resolve canonically and walk parents to prove containment.
- `TDHost` and `TDPlugins` are attached only to the WikiList's WebView, not to wikis.

## Known residual risks

Accepted, not overlooked:

- **Folder trust is broad.** Trusting `~/Documents` for one attachment exposes everything readable
  underneath it. The UI should say so at the moment of the choice.
- **Existence oracle.** A wiki can probe which paths exist inside a trusted folder.
- **Trust is per wiki, not per tiddler.** Any script in a wiki inherits every grant that wiki holds,
  including grants earned by an attachment added long ago.
- **The unsandboxed escape hatch is total.** A folder wiki with that flag set gets full Node and
  ignores the trust model entirely. That is its purpose — which is why the flag lives in the
  backstage config, never in the wiki, and why its state must stay visible in the wiki list.
- **The shell path is Node-eligible on any port.** Another localhost service serving exactly
  `/__tiddlydesktop_shell__/*` would get Node if it were ever opened top-level. Contained by the
  top-level-navigation invariant and a deliberately distinctive path name; the price of dynamic
  ports.
- **Local processes can reach the ports.** Mitigated, not eliminated, by session tokens.
- **Reads are unscoped in the folder-wiki child.** See above for why; writes are the boundary there.
