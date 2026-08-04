# Design: serving wikis from a loopback HTTP origin

**Status:** proposal, not scheduled
**Addresses:** security audit finding #3 (`--allow-file-access-from-files`)
**Supersedes nothing.** Related: findings #1 (bridge capabilities, fixed in `71bb3a3`) and #4
(attachments traversal, fixed in `e15108d`).

## Summary

Single-file wikis currently render as `file://` documents. This forces
`--allow-file-access-from-files`, which makes *every* `file://` document same-origin with every
other — so any wiki you open can read any file the user can, and post it anywhere. Folder wikis
are worse still: TiddlyWiki boots directly into the NW.js page, so their JavaScript simply has
Node.

This proposes serving **both** wiki formats from a loopback HTTP origin, rendered in an
`nwdisable nwfaketop` iframe, behind a per-wiki **trusted-path** model: per-file grants by
default, folder grants by explicit choice, minted only through a picker the parent owns. Wikis
keep the ability to reference attachments anywhere on disk; what changes is that the authority
becomes explicit and bounded instead of ambient and total.

Secondary wins: folder wikis gain a sandbox they have never had, the media-embed shim is deleted
outright, `asset-util.js`'s dual Node/bridge split collapses, and CSP becomes available for the
first time — the only route we have to constraining *exfiltration* rather than just file reads.

## Motivation

### What the flag costs

`source/package.json` sets `--allow-file-access-from-files`, `--allow-file-access` and
`--allow-file-cookies`. The first collapses all `file://` documents into one origin. Consequences:

- A wiki can `fetch("file:///home/you/.ssh/id_ed25519")` and read it in full.
- There is no CSP on `file://` documents, so it can post the result to any host.
- All wikis share cookies and storage with each other.

This is a complete read-and-exfiltrate chain that does **not** involve the parent/iframe bridges,
which is why the finding #1 work did not shrink it.

### Why the flag cannot simply be removed

The parent window reaches into the wiki's document in **58 places** (`iframe.contentDocument` /
`iframe.contentWindow` across `source/js/`) — saving, title and favicon observation, the find bar,
embeds, spellcheck, drag-drop, zoom, permalink disabling, and all four collab bridges.

The parent page and the wiki are two *different* `file://` documents. Without the flag, Chromium
gives each `file://` document an opaque origin and all 58 accesses throw. The flag is what makes
the current architecture possible; removing it without replacing the mechanism breaks the app.

## Non-goals

- Changing the Android app, which already implements this architecture.
- Fixing exfiltration in this change. It becomes *possible* (see CSP below) but is separate work.

Folder wikis were originally listed here as out of scope. They are not — see below.

### Folder wikis get the same treatment

Today the sandboxing is backwards: the *more* capable format has *less* protection.

| | sandbox | Node available to wiki JS |
|---|---|---|
| single-file wiki | `nwdisable nwfaketop` iframe | none |
| folder wiki | **none** — `boot.js` runs in the NW page (`wiki-folder-main.js:167`) | **full** |

Any `module-type: startup` tiddler, or any plugin imported into a folder wiki, can call
`require("child_process")`. That follows from booting TiddlyWiki in-page rather than from any
defect, but it means a downloaded folder wiki is straightforward RCE.

This design closes it without new machinery, because **TiddlyWiki's folder mode is already
client/server**: the browser half talks to the server over HTTP through the sync adaptor and never
needs Node. TiddlyDesktop currently collapses both halves into one process for convenience. That
is a choice, not a requirement — Android already declines it, running `tiddlywiki --listen` as a
separate process with the WebView loading `http://127.0.0.1:PORT` (`node/NodeServer.kt`).

So a folder wiki takes the same shape as a single-file one: shell at
`wikiPort/__tiddlydesktop_shell__/`, TiddlyWiki's server serving the UI, wiki in an
`nwdisable nwfaketop` iframe. One architecture, one set of bridges, one trust model.

#### How the folder wiki's server runs (measured)

NW.js ships no `node` binary — only `nw`, `nwjc` and `chromedriver` — so the Android approach of
spawning `tiddlywiki --listen` as a separate process is not available. TiddlyWiki has to boot
inside an NW.js context.

Booting it in the shell naively would defeat the whole exercise: in a renderer both `$tw.browser`
and `$tw.node` are truthy, so TiddlyWiki would render the wiki's UI *and run the wiki's
browser-side JavaScript* in a Node-enabled context — exactly the RCE this phase removes.

The way out is to force node-only mode. `bootprefix.js` assigns the platform only when the key is
absent:

```js
if(!("browser" in $tw)) { $tw.browser = typeof(window) !== "undefined" && … ; }
```

so passing `{browser: null}` in is supported rather than a hack, and it must be pre-set rather
than overwritten afterwards. Boot then has to use the documented `suppressBoot` + `boot(callback)`
pattern; reading state straight after `TiddlyWiki($tw)` sees an unfinished boot.

Verified against the bundled TiddlyWiki inside a real NW.js renderer:

| | result |
|---|---|
| `$tw.browser` after bootprefix | `null` |
| wiki folder loaded | yes (`$tw.boot.wikiPath` set) |
| **wiki UI rendered into the shell page** | **no** — the security property this rests on |
| unauthenticated request | 401 |
| authenticated request | 200, real wiki content |
| server URL | `http://127.0.0.1:<port>/wiki/<token>` — `path-prefix` honoured |
| filesystem syncer | running |

So the server takes `username`/`password` (no CSV needed) and `path-prefix=/wiki/<token>`, and our
per-window server forwards to it verbatim with the credential attached.

The code collapse is real. `asset-util.js` branches on `nodeFs` throughout purely because folder
wikis have Node and single-file wikis do not; unifying them removes that split entirely, and
`wiki-folder-main.js` becomes a shell like `wiki-file-window.js` rather than a parallel
implementation.

Costs to accept, none of them small:

1. **Scope.** `wiki-folder-main.js` is ~20 KB of in-page host logic that has to move into a shell.
2. **Saving semantics change — smaller than it first appears.** Folder wikis sync today via the
   in-page `filesystem` plugin; over HTTP the browser uses the standard `tiddlyweb` adaptor and
   the *server* runs `filesystem`, so the on-disk layout and file naming are unchanged. An earlier
   draft claimed TiddlyDesktop's backup logic would need rework: that was wrong. `hasBackups` is
   defined only on `WikiFileWindow` (`wiki-file-window.js:54`) and `window-list.js:442` treats its
   absence as false, so **folder wikis have no TiddlyDesktop backup logic at all** — there is
   nothing to break.
3. **Interaction with the LAN `--listen` feature** (audit finding #5). Sharing a wiki on the LAN
   must be a *separate* binding: the shell path must never be served on a LAN-facing interface.
   Remote clients could not obtain Node anyway — the `node-remote` pattern is `127.0.0.1`-scoped —
   but serving the app shell to the network is needless exposure.
4. **Compatibility break — with an opt-in escape hatch.** Folder wiki JS has unrestricted
   filesystem access today and someone may depend on it (a wiki that shells out, or uses a node
   module). Constraining it to the wiki folder plus trusted paths is the right default, but the
   capability should remain reachable deliberately.

   **Decided:** a per-wiki *"run this wiki unsandboxed"* flag, default off, which boots the folder
   wiki the old way — in-page, full Node. It is stored in backstage config beside the trust
   records (`$:/TiddlyDesktop/Config/unsandboxed/<wiki-id>`), **never inside the wiki**, for the
   same reason trust records are not: a wiki that could set its own flag would grant itself Node.
   It belongs in the wiki list's Advanced panel, worded as what it is — this wiki's code can do
   anything you can — and it should be visible at a glance which wikis have it set.

## Architecture

### Origin layout

Two loopback origins, not one:

| Origin | Serves |
|---|---|
| `http://127.0.0.1:<PORT_W>` | the wiki document and its own directory |
| `http://127.0.0.1:<PORT_A>` | external attachments outside the wiki directory |

The parent shell is served from `PORT_W` as well, so parent and wiki are genuinely same-origin
and all 58 cross-document accesses keep working unchanged.

Attachments deliberately get a **different port, and therefore a different origin**. That is what
makes a canvas drawn from an attachment *tainted*: `getImageData()` and `toDataURL()` throw, so
script cannot launder media bytes out through a canvas.

Both servers require a per-session token (path segment or `HttpOnly` cookie), because on a
multi-user or multi-app machine any local process can reach a loopback port.
`server/SingleFileWikiServer.kt` on Android already does exactly this and is the reference.

### Port and origin allocation (decided)

**Every wiki window takes two OS-assigned ports at open time (`listen(0)`), and `node-remote`
scopes Node by PATH, not by port:**

```json
"node-remote": "http://127.0.0.1:*/__tiddlydesktop_shell__/*"
```

| port (per window) | serves | Node |
|---|---|---|
| wiki port | `/__tiddlydesktop_shell__/…` (the parent shell) | **yes** — matches the pattern |
| | `/wiki/…` (the wiki document + its directory) | no — same origin, different path |
| attachment port | granted attachment files | no — path never matches |

Verified against NW.js 0.114.0: with an OS-assigned port (40465 in the run),
`/__tiddlydesktop_shell__/index.html` got full Node (`EXEC=1000`) while `/wiki/notes.html` on the
**same origin** got none. The port wildcard is safe because the path does the scoping.

This is what makes dynamic ports work, and it is better than the fixed-port scheme it replaces:

- **No collision handling.** `listen(0)` always succeeds. There is no fixed port to contest, no
  startup failure mode, and no need for the stale-instance recovery a fixed port would have
  required.
- **Per-wiki origin isolation comes back.** Distinct ports mean distinct origins, so wikis can no
  longer reach each other's cookies and storage — something the `file://` architecture has never
  offered.
- **Tighter than exact-port matching.** Another localhost service would have to serve exactly
  `/__tiddlydesktop_shell__/*` to be Node-eligible, and even then only if opened top-level (see
  the invariant below). An exact-port pattern would have granted Node to *anything* on that port.
- **One static pattern.** No arrays — which matters, because arrays are unreliable (below).

Shell and wiki deliberately share an origin (same port), which is safe only because
`nwdisable nwfaketop` blocks the climb to the shell's Node — see the measured table below. The
attachment port is separate because the media policy needs a *different origin* for canvas
tainting, not merely a different path.

#### `node-remote` forms that do not work

Measured, so nobody re-derives them:

| form | result |
|---|---|
| single string, port or path wildcard | **reliable** |
| array of patterns | **crashes** when granting Node to a second matching window |
| host wildcard (`"http://*.localhost:45721/*"`) | **crashes** |
| space-separated patterns in one string | **silently matches nothing** — fails closed, but silently |

The space-separated case is the dangerous one: a typo there leaves you believing Node is scoped
when nothing matches at all. All three are worth reporting upstream.

Also rejected: **per-wiki hostnames** (`a.localhost`, `b.localhost`) on one shared port. Chromium
does resolve `*.localhost` to loopback and the pages load, so it would have given per-wiki origins
too — but matching them needs a host wildcard or an array, and both crash. Path scoping achieves
the same isolation without either.

#### Port stability

**Not required, and deliberately not relied on.** Nothing is keyed to the origin: there is no
`localStorage`/`indexedDB` use anywhere in the app or plugins, trust records are keyed by wiki
identity rather than origin, and CSP is applied per response. A wiki may take a different port on
every launch with no user-visible consequence.

If stable ports are wanted anyway (consistent devtools targets, say), record the last port per
wiki in backstage config and try to rebind it at open time, falling back to a fresh OS-assigned
port when it is taken. Because `node-remote` matches any port, that fallback costs nothing —
stability stays a best-effort nicety with no failure mode, which is exactly what it should be.

### Node access model (measured)

Moving the parent shell off `file://` changes how NW.js grants Node, so this was measured against
NW.js 0.114.0 (SDK, linux-x64) rather than assumed. Results:

App pages are served from a **`chrome-extension://`** origin, not `file://` — measured. That
matters twice over: it is why the backstage window can reach into a wiki window cross-origin at
all (NW.js app pages carry extension privileges, which is what survives removing
`--allow-file-access-from-files`), and it is why folder wikis hit the same media-embed rejection
as `file://` pages did.

| context | Node? |
|---|---|
| app page (app-**relative** URL, e.g. `Window.open("html/x.html")`) | yes |
| absolute `file://` URL — *including a file inside the app package* | no |
| `node-remote` origin, top-level window | **yes** |
| `node-remote` origin, **plain** iframe | **yes** |
| `node-remote` origin, `nwdisable` iframe | no |
| plain iframe **nested inside** an `nwdisable` iframe | no — inherited |

**`nwdisable` and `nwfaketop` are BOTH required — neither is sufficient alone.** Measured with a
same-origin child iframe trying to climb to the shell's Node:

| iframe attributes | own Node | `window.parent` | outcome |
|---|---|---|---|
| `nwdisable nwfaketop` | none | is self | **blocked** |
| `nwdisable` only | none | real parent | `parent.require("child_process")` → **executed** |
| `nwfaketop` only | **function** | is self | **executed** |
| neither | function | real parent | executed |

`nwdisable` strips the frame's own Node but leaves `window.parent` reachable, so a same-origin
child simply borrows the shell's `require`. `nwfaketop` makes `window.parent` and `window.top`
both resolve to the frame itself, which is what closes that door.

`source/html/wiki-file-window.html` carries both today, so the current app is not exposed. But
this makes `nwfaketop` a **security control, not a compatibility shim** — its name suggests it
only adjusts `window.top` for TiddlyWiki's benefit, and removing it "because TW handles framing
now" would silently open full RCE. It deserves a comment saying so at the iframe, and it is a
hard prerequisite for this design, which puts shell and wiki on the same origin by choice.

Node access follows *app-page identity*, not filesystem location: the same file loaded by an
app-relative URL has Node and by an absolute `file://` URL does not. Presence or absence of
`--mixed-context` changed nothing.

Three consequences for this design:

1. **The parent shell needs `node-remote`.** Served over HTTP it is no longer an app page, so
   without an entry it loses Node and the entire host layer stops working. The manifest currently
   has no `node-remote` at all.
2. **`nwdisable` still works, and is inherited.** It strips Node even on a Node-enabled origin, and
   the whole frame subtree below it is covered — so wiki content writing `<iframe src="…">` cannot
   climb out. This is what makes a shared origin acceptable.
3. **Invariant: nothing on the `node-remote` origin may be opened outside the `nwdisable` subtree.**
   Top-level windows and sibling frames on that origin get full Node (verified by executing
   `id -u` from a served page). `new-win-policy` must enforce this; it is a correctness
   requirement, not a hardening nicety.

Note also what these results *disprove*: `new-win-policy` handing a wiki-supplied absolute
`file://` URL to `gui.Window.open` (`wiki-file-window.js:108`) does **not** yield a Node-enabled
window, so it is not the escalation path it appears to be. It becomes one only if the app ever
starts opening such URLs app-relatively, or from the `node-remote` origin — see the invariant.

### Permission model: trusted paths

A path is either **trusted** for this wiki or it is not. Untrusted paths are refused by the
server; trusted ones are served under the request-based rules in "Serving policy" below. The wiki's own directory is
trusted implicitly (the wiki can already write there through the saver, so this grants nothing
new). Everything else has to be granted, and there are exactly two ways that happens.

**1. Grant on add.** When the user adds a file through External Attachments — the drag-drop or
import picker — the path they chose becomes trusted immediately. No prompt: the user picking that
file *is* the consenting gesture, and it is witnessed by the parent, which owns the picker. This
is the same principle as `_nwjsChooseSavePath` in finding #1's fix.

Scope it to exactly what the user picked: the **file**, not its folder. Widening a
"I chose this image" gesture into "this wiki may read `~/Pictures`" claims authority the user
never granted. Folder-level trust is available, but the user has to ask for it (below).

**2. Grant in place, from the view template.** A tiddler whose `_canonical_uri` points at an
untrusted path renders through a view template that explains the blocked state and offers:

> This attachment's location isn't trusted yet.
> `~/Pictures/holiday.png`
> \[Trust this file\] \[Trust this folder\]

Both buttons open a picker the **parent** owns, seeded at that path — see "Who mints trust". The
template never grants anything itself.

This replaces upfront modal prompting. Consent is asked in context, at the moment it matters,
showing the exact path — and a wiki with twenty scattered attachments degrades into twenty
*visible, ignorable* panels rather than twenty modal dialogs. TiddlyWiki already ships
`$:/language/LazyLoadingWarning` for external content that will not load, so this reads as an
extension of familiar behaviour rather than a new concept.

Offering both granularities matters: per-file is precisely scoped, per-folder is what stops a
media-heavy wiki becoming a clicking exercise. Default the UI to the narrower one.

#### Where trust is stored

**Outside the wiki.** In backstage config, keyed by wiki identifier, following the existing
convention in `WikiListRow.tid` (`$:/TiddlyDesktop/Config/host/$(currentTiddler)$`):

```
$:/TiddlyDesktop/Config/trusted-paths/wikifile:///home/you/notes.html
```

This is not a filing decision, it is the security boundary. A wiki can write its own tiddlers, so
trust records kept *inside* the wiki would let a malicious wiki grant itself access to anything.
Storing them in the backstage wiki — which the parent owns and the wiki cannot write — is what
makes the model hold. It also gives Settings-based listing and revocation for free.

Trust must persist across reloads and restarts, or the view-template button reappears constantly.
Note this corrects finding #1 as currently implemented: `_approvedPaths` in `wiki-file-window.js`
is in-memory and cleared per iframe load, which is right for a one-shot save dialog and useless
for rendering. That map should move onto this store, giving one policy engine with two consumers
(the attachment server and the file bridge) rather than two separate policies.

#### Who mints trust

The parent, always, **through a file picker it owns**.

The view template is wikitext running *inside* the wiki, so if its button dispatched a message that
the wiki's own JS turned into a grant, wiki script could dispatch that same message with no click
and no user — the button would be decoration. The click has to reach the parent, and the parent
has to establish user intent by a means the wiki cannot simulate.

*Trust this file* therefore opens an `<input type="file">` that the **parent** creates, holds and
reads, with `nwworkingdir` seeded to the attachment's own directory so the user lands on it.
*Trust this folder* does the same with `nwdirectory`. The user confirms by selecting the item, and
the parent records what the input actually returned.

This is the same mechanism finding #1's fix already relies on — **script cannot set a file input's
value**, so the returned path is necessarily the user's choice. Consequences:

- trust minting has exactly **one** code path, shared with grant-on-add, rather than a second
  privileged verb to review;
- no new bridge function that could be called without a user;
- no dependence on cross-realm `event.isTrusted` semantics. Gating a parent-side click listener on
  `isTrusted` would probably work — `dispatchEvent` always yields `false` — but a permission
  decision should not rest on a subtlety we would have to take on faith.

The cost is that the user selects an item rather than clicking *OK*. Acceptable for an action that
is rare, deliberate, and grants standing filesystem access.

#### The template is UX, the server is the boundary

A wiki can delete, override or lie to its own view template — including the
`$:/temp/TiddlyDesktop/trusted-paths` mirror the parent writes so the template knows what is
trusted. None of that moves the boundary: the attachment still will not load, because the
**server** refuses untrusted paths. The template's job is to explain a blocked state and offer the
remedy, never to enforce it. Any design where the template's cooperation is required for safety is
wrong.

### Serving policy: by request, not by content type

TiddlyWiki loads external content two different ways, and the server responds differently to each
— but the discriminator is the **request**, not the file.

**How TiddlyWiki loads it.** Media parsers (`imageparser.js`, `audioparser.js`, `videoparser.js`,
`pdfparser.js`, `binaryparser.js`) emit elements whose `src` is the `_canonical_uri`; Chromium
fetches those and script never touches the bytes. Text is different — `wikiparser.js` handles a
tiddler with an empty `text` field and a `_canonical_uri`:

```js
if($tw.browser && (text || "") === "" && options._canonical_uri) {
    this.loadRemoteTiddler(options._canonical_uri);
}
```

which calls `$tw.utils.httpRequest` (XHR), then `deserializeTiddlers(".tid", data)` and
`addTiddlers(...)`. So `.txt` and `.tid` attachments **must** be script-readable:

> Once loaded, the text is in `$tw.wiki` and in the DOM, readable via `getTiddlerText`.
> Withholding CORS would buy **no** security; it would only break the feature.

**The rule.** Classify each request by `Sec-Fetch-Dest`:

| `Sec-Fetch-Dest` | means | response |
|---|---|---|
| `empty` | `fetch`/XHR — i.e. `loadRemoteTiddler` | **with** `Access-Control-Allow-Origin`, trusted paths only |
| `image`, `audio`, `video`, `document`, `object` | a renderer load | **without** CORS |

Untrusted paths are refused either way.

**Why not classify by content type.** An earlier draft split media from text server-side by
extension, so media could never be script-read. That cannot be made correct. TiddlyWiki dispatches
on the tiddler's `type` field — parsers register as `exports["image/png"]`, `exports["audio/ogg"]`
— and the server only sees a URL, so the two can disagree in both directions: a mis-classified
text attachment returns an opaque response and fails silently, and a mis-classified media file
becomes readable.

More fundamentally, **the wiki writes the type field**. A wiki wanting to read a trusted image
declares it `text/plain` and lets `loadRemoteTiddler` XHR it. The asymmetry was therefore never
enforceable against a hostile wiki — only against accidental leakage — so it is kept as hardening
and not claimed as a boundary. Withholding CORS on renderer loads still costs nothing and still
blocks casual canvas laundering (the attachment origin is separate, so canvases drawn from it are
tainted), but it is not what keeps a hostile wiki out.

**What actually is the boundary: trust.** At a path the user consciously trusted, script can read
the bytes — the same bargain the browser File System Access API makes. That is why granularity is
the real control: per-file trust is the default, and a folder grant is an explicit choice that
hands script everything readable underneath it.

### Content Security Policy

Serving the wiki means controlling response headers, so a CSP can finally be applied to wiki
documents. This is unavailable on `file://` and is the only mechanism on any of our lists that
addresses *outbound* traffic. It needs care — TiddlyWiki requires `unsafe-eval` — but
`connect-src` / `img-src` restrictions are viable and would close the exfiltration half of
finding #3.

Scoped as follow-up work, not part of the initial migration.

## Consequences

### Deleted

- ~~The embed shim~~ — **not deleted; see work item 10.** Both wiki kinds are on http now, so
  neither routes through it, but `utils/local-server.js` stays: the backstage window and the
  unsandboxed escape hatch both render on `chrome-extension://`, which providers reject exactly
  as they rejected `file://`. What goes is the shim being used on served wikis, not the shim.
- All three `--allow-file-*` chromium-args.

### Changed

- **Relative resource loading generally**, not just attachments — every relative URL now resolves
  against the wiki origin, so `PORT_W` must serve the wiki's directory, not only `/attachments/`.
- **TiddlyWiki Classic.** `utils/classic-inject.js`'s `injectedLoadFile` compared
  `getLocalPath(document.location)` against a filesystem path, which stopped meaning anything on
  an HTTP URL. Fixed by ignoring the argument entirely: the window owns one file and its contents
  are already injected, so the path carries no information — the same reasoning that made the
  saver stop trusting the path the page supplies.
- ~~**Saver selection.**~~ **No change needed — checked.** The concern was that TiddlyWiki would
  prefer the HTTP `put` saver (priority 2000) over TiddlyFox (1500) once the wiki was on an http
  origin, since `put.canSave` tests `/^https?:/` and flips from false to true. It does get
  selected first, but `PutSaver.save()` returns false unless `serverAcceptsPuts`, which requires
  a `dav` header on an OPTIONS response. Our server answers 405 with no such header, so the saver
  handler falls straight through to TiddlyFox. Confirmed live: the wiki file is still rewritten
  after the origin move.
- **New local exposure** — any local process can reach the ports; mitigated by session tokens.

### Unaffected

- **The collab bridges.** They are properties on `contentWindow`; once parent and wiki are
  same-origin the mechanism is origin-agnostic.
- **Saving.** DOM-event based, and `6f79f41` already made the destination parent-authoritative, so
  it no longer depends on the document URL.
- **Storage.** There is no `localStorage` or `indexedDB` use in `source/js/` or either plugin, so
  nothing is keyed to the old origin and no storage migration is needed. (Verify again before
  implementing; a plugin could introduce one.)
- ~~Folder wikis~~ — **now in scope**, see "Folder wikis get the same treatment".
- **Deep links / protocol registration.**

## Migration

Existing wikis store absolute `file:///…` URIs for attachments outside the wiki tree —
`asset-util.js` defaults `UseAbsoluteForNonDescendents` to `"yes"`, so this is the *expected*
shape, not an edge case. An `http://` page cannot load a `file://` subresource (Chromium blocks
http→file; `--allow-file-access-from-files` does not relax this), so these break unless handled.

**The trust lifecycle is the migration.** No separate mechanism is needed: an existing wiki opens,
its out-of-tree attachments are untrusted, and each one renders the view-template panel offering
*Trust this file* / *Trust this folder*. The user grants what they still care about, ignores what
they do not, and nothing is prompted upfront or rewritten on disk.

That gives the migration properties worth stating explicitly:

- **Nothing breaks silently.** A blocked attachment shows a panel naming the exact path, rather
  than a broken image icon.
- **No data is mutated.** `_canonical_uri` values are left exactly as they are, so the wiki stays
  portable to other TiddlyWiki hosts.
- **It is incremental and reversible.** Trust accrues as the user actually browses; revocation
  lives in Settings.
- **Cost is proportional to use.** A wiki whose attachments all sit in `./attachments/` migrates
  with zero interaction, since the wiki's own directory is trusted implicitly.

Two optional conveniences, neither required:

1. **Folder roll-up.** If several untrusted attachments share a parent directory, the panel can
   offer to trust that directory once instead of file-by-file. Same decision, fewer clicks.
2. **Copy into the wiki folder**, offered as an explicit tool for users who would rather make the
   wiki self-contained. Cleanest end state, most invasive — opt-in, never automatic.

Deliberately rejected: rewriting `_canonical_uri` values to `PORT_A` URLs on save. It would avoid
re-prompting, but it mutates user data and breaks the wiki everywhere except TiddlyDesktop.

## Security analysis

### Closed

| | today (`file://` + flag) | proposed |
|---|---|---|
| Attachment anywhere on disk | yes | yes, once the path is trusted |
| Script reads arbitrary file bytes | **yes, any file** | no — untrusted paths refused |
| Script reads bytes at a *trusted* path | yes | yes — trust is the boundary, not the byte type |
| Cross-wiki cookie/storage access | yes | no — one origin per wiki window |
| Folder-wiki JS gets Node | **yes, unconditionally** | no — sandboxed like single-file wikis |
| Trust survives wiki tampering | n/a | yes — stored outside the wiki |
| Exfiltration constrainable | no (no CSP possible) | yes (CSP available) |

The row that is *not* in this table is "script reads media bytes". An earlier draft claimed media
could never be script-read; that claim did not survive review — see "Serving policy" and the first
residual risk below.

### Residual risk

- **Anything at a trusted path is readable by wiki script, including media.** The no-CORS response
  on renderer loads is hardening, not a boundary: the wiki writes the tiddler's `type` field, so a
  wiki wanting an image's bytes declares it `text/plain` and lets `loadRemoteTiddler` XHR it. Text
  is unavoidably readable anyway (it lands in `$tw.wiki` by design). Trust is the boundary;
  granularity is the control, which is why per-file is the default and folder grants are explicit.
- **Folder trust is broader than it looks.** Trusting `~/Documents` because one attachment lives
  there exposes everything readable underneath it. The UI should say so at the moment of the
  choice, not bury it in Settings.
- **Existence oracle.** A wiki can probe which paths exist inside a trusted folder.
- **Local processes** reaching the ports; mitigated but not eliminated by session tokens.
- **Trust is per wiki, not per tiddler.** Any script in a wiki inherits every grant that wiki
  holds — including grants earned by an attachment the user added long ago.
- **The unsandboxed escape hatch is total.** A folder wiki with the flag set gets full Node and
  ignores the trust model entirely. That is the point of it, but it means the flag's UI has to be
  unambiguous and its state visible in the wiki list.
- **The shell path is Node-eligible on any port.** `node-remote` matches
  `http://127.0.0.1:*/__tiddlydesktop_shell__/*`, so another localhost service serving that exact
  path would get Node if it were ever opened top-level. Contained by the top-level-navigation
  invariant plus a deliberately distinctive path name, but it is the price of dynamic ports.
- **`nwfaketop` is load-bearing.** Shell and wiki share an origin by design, so removing that
  attribute — or adding a same-origin frame without it — is an immediate RCE. See the measured
  table under "Node access model".

## Prior art

The Android app already runs this architecture:
`server/SingleFileWikiServer.kt` serves single-file wikis over loopback with an `HttpOnly`
session-cookie token gating writes, and `node/NodeServer.kt` runs folder wikis the same way. It
constrains attachments to the wiki's own `attachments/` folder — a restriction this design
deliberately lifts via grants, since arbitrary-path reference is the point of External Attachments.

The honest framing is therefore not "risky rewrite" but "port a design we already ship, and add
the permission model Android didn't need."

## Decisions and open questions

1. ~~Port stability and `node-remote` scoping.~~ **Decided** — per-wiki OS-assigned ports with
   path-scoped `node-remote`. See "Port and origin allocation (decided)".
2. ~~Does `nwdisable` behave identically on an HTTP-origin iframe?~~ **Answered** — yes, and it is
   inherited by nested frames. `nwfaketop` is required alongside it. See "Node access model".
3. **Text-class detection — dissolved, not solved.** The original plan was to classify media vs
   text server-side from the extension. That cannot be made to agree with TiddlyWiki, which
   dispatches on the tiddler's `type` field: parsers register as `exports["image/png"]`,
   `exports["audio/ogg"]` and so on, and the server only sees a URL. Worse, the wiki *writes* the
   type field — so a hostile wiki wanting to read a trusted media file simply declares it
   `text/plain` and lets `loadRemoteTiddler` XHR it.

   That means the media/text asymmetry was never enforceable against a hostile wiki, only against
   accidental leakage. Rather than pretend otherwise:

   **Decided:** classify per request by `Sec-Fetch-Dest`, not by content type.
   - `Sec-Fetch-Dest: empty` (a `fetch`/XHR — i.e. `loadRemoteTiddler`) → serve **with** CORS, at
     trusted paths only.
   - anything else (`image`, `audio`, `video`, `document`, `object`) → serve **without** CORS.

   This removes extension sniffing, removes any parser/server disagreement, and removes the silent
   failure mode where a mis-classified text attachment returns an opaque response. The no-CORS
   default on renderer loads is kept because it costs nothing and still blocks casual canvas
   laundering — but it is **hardening, not a boundary**, and the security table says so. The
   boundary is trust, and its control is granularity: prefer per-file grants, make folder grants
   an explicit choice.
4. **Can `--allow-file-access` and `--allow-file-cookies` be dropped independently, now?** Still
   open, still worth doing regardless of this design (no `document.cookie` use in the app or the
   bundled core). Work item 1.
5. **How does the view template reach the parent to mint trust? — Decided: a parent-owned picker.**
   Not a confirmation dialog, and not `event.isTrusted`.

   *Trust this file* opens an `<input type="file">` that the **parent** creates, holds and reads,
   with `nwworkingdir` seeded to the attachment's own directory; *Trust this folder* does the same
   with `nwdirectory`. The user confirms by selecting the item, and the parent records what the
   file input actually returned.

   This reuses the one mechanism already proven unforgeable in finding #1's fix — script cannot
   set a file input's value — so trust minting has exactly one code path, shared with grant-on-add.
   It needs no new bridge verb, and it avoids resting a permission decision on cross-realm
   `isTrusted` semantics we would have to take on faith. The cost is that the user selects rather
   than clicking *OK*; acceptable for a rare, deliberate action.
6. **What identifies a wiki for the trust store? — Decided: the absolute pathname**, reusing the
   identifiers `WindowList.decodeUrl` already produces (`wikifile:///path`, `wikifolder:///path`).

   Every other per-wiki setting is already keyed this way (`$:/TiddlyDesktop/Config/host/…` in
   `WikiListRow.tid`), so trust records inherit behaviour users already understand: move or rename
   a wiki and its settings do not follow it.

   Explicitly rejected: **a UUID stored inside the wiki.** It would survive moves, but the wiki
   writes its own tiddlers — so a hostile wiki could adopt another wiki's identifier and inherit
   its grants. Same reasoning that keeps the trust records themselves outside the wiki.

   Consequence to accept: a moved wiki re-prompts, and a *copied* wiki does not inherit trust —
   which is the correct outcome anyway.

## Work breakdown

1. Drop the two separable flags; confirm nothing breaks. *(independent, do first)*
2. **Trust store**: persistent per-wiki records under
   `$:/TiddlyDesktop/Config/trusted-paths/…`, the parent-owned mint path, the
   `$:/temp/TiddlyDesktop/trusted-paths` mirror, and Settings listing/revocation. Move finding
   #1's in-memory `_approvedPaths` onto it. *(independent, useful on its own)*
3. Grant-on-add: trust the picked path in the External Attachments drag-drop/import flow.
4. `PORT_W` server: wiki document + wiki directory; move the parent shell onto it; add the
   `node-remote` entry it now needs to keep Node.
5. **Enforce the top-level-navigation invariant** in `new-win-policy`: never open a page from the
   `node-remote` origin outside the `nwdisable` subtree. Must land with step 4, not after it —
   step 4 is what creates the exposure.
6. `PORT_A` server: trust-checked attachment serving with the media/text policy split.
7. View template for untrusted `_canonical_uri` tiddlers, with file/folder trust actions.
8. TiddlyWiki Classic and saver-selection fixes.
9. **Folder wikis onto the same shell**: TiddlyWiki's server serving the UI, wiki in an
    `nwdisable nwfaketop` iframe, `wiki-folder-main.js` reduced to a shell, `asset-util.js`'s
    `nodeFs`/bridge split collapsed, LAN `--listen` split onto its own binding. Largest single
    phase, and the one that removes the last unsandboxed surface. *(can follow the single-file
    work; does not block it)*
10. **Bypass** the embed shim where the origin is already http — do not delete it. An earlier
    draft said "delete", which is wrong: `utils/embeds.js` is installed on four kinds of
    document, and only two of them moved to http.

    | install site | origin | still needs the shim |
    |---|---|---|
    | `wiki-file-window.js` (wiki iframe) | http | no |
    | `wiki-folder-window.js` (wiki iframe) | http | no |
    | `backstage-window.js` | `chrome-extension://` | **yes** |
    | `wiki-folder-main.js` (unsandboxed escape hatch) | `chrome-extension://` | **yes** |

    The backstage is an app page and a real TiddlyWiki, so a tiddler there can carry a media
    embed; and the escape hatch deliberately restores the pre-sandbox in-page path on that same
    origin. Both would lose media playback if the shim went away.

    So the work is for `embeds.js` to route through the shim only when
    `document.location.protocol` is not http(s), and to leave media on a served wiki pointing
    straight at the provider. The shim server then starts only for the documents that need it.
11. CSP. *(follow-up)*

Steps 1–3 stand on their own even if the origin move is never scheduled: the trust store makes
finding #1's grants persistent and revocable, and grant-on-add is the mechanism that keeps the
later view-template flow from prompting for files the user has already chosen.
