# Security audit — August 2026

Scope: what a **hostile wiki** can reach. That is the threat that matters most — a wiki is
executable content the user downloaded, and the whole confinement design exists to bound it.

This audit replaces an earlier one whose findings #7–#9 were never written down and are now
unrecoverable. Findings are recorded here rather than in conversation for that reason.

Method: enumerate every interface reachable from a wiki's own JavaScript on both platforms, then
compare the two — the desktop and Android implementations of the same bridges diverged, and the
divergence is where the findings are.

## Summary

The desktop side is in good shape: its bridges validate schemes, its file bridge is trust-gated, and
its served wikis carry a CSP. **Android's equivalents are missing those constraints.** The findings
below are not one-off bugs so much as a systematic parity gap.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Android serves wikis with no Content-Security-Policy | open |
| 2 | High | `CollabBridge.httpGet` / `wsCreate` are unconstrained outbound channels | open |
| 3 | Medium | `openExternal` and `shouldOverrideUrlLoading` launch arbitrary intents | open |
| 4 | Info | `sanitizeAttachmentName` permits `..` as a leaf name | open, not exploitable |
| — | Critical | `CollabBridge.fileCmd` allowed arbitrary file read/write | **fixed**, `4c61586` |

## 1. Android serves wikis with no CSP (High)

Desktop applies a Content-Security-Policy to every served wiki (`source/js/utils/wiki-server.js`):
`connect-src` limited to self plus the attachment origin, `object-src 'none'`, `base-uri 'none'`,
`form-action 'none'`. It is described there, correctly, as the only measure on any of our lists that
constrains what a wiki can send **out** rather than what it can read.

`SingleFileWikiServer.kt` sends no CSP, and no CSP appears anywhere in the Android sources. So on
Android a wiki can beacon to any host it likes via `fetch`, XHR, WebSocket, `sendBeacon` or a form
POST. Everything the desktop CSP was written to prevent is available.

**Fix:** send the same policy from the Android servers. The desktop header is the reference,
including its deliberate exceptions (`script-src` must keep `unsafe-eval`/`unsafe-inline`, and
`img-src`/`media-src` stay open).

## 2. `CollabBridge.httpGet` / `wsCreate` are unconstrained (High)

Both take a URL and a header map straight from wiki JavaScript:

```kotlin
fun httpGet(id: Int, url: String, headersJson: String) { ... Request.Builder().url(url) ... }
```

The desktop equivalents reject anything that is not a web scheme, explicitly — `"URL scheme not
permitted"` in `source/js/utils/bridges.js`, for both the HTTP and WebSocket bridges. Android has no
such check.

OkHttp itself only speaks http/https, so this is not a `file://` read. The problem is that it is an
**unrestricted outbound channel from the app's network context**, with attacker-chosen headers: it
exfiltrates, it reaches loopback services, and it will bypass whatever CSP finding 1 adds, because
the request is made by the app rather than by the page.

**Fix:** mirror the desktop scheme check, and consider whether these need to be reachable by any
wiki at all or only by one running a collab session.

## 3. Arbitrary intent launch (Medium)

`CollabBridge.openExternal(url)` does `startActivity(ACTION_VIEW, Uri.parse(url))` with no
validation. `WikiActivity.shouldOverrideUrlLoading` does the same for any non-loopback top-level
navigation.

So a wiki can cause arbitrary URIs to be handed to the system — deep links into other installed
apps, `tel:`, `sms:`, vendor schemes — without user interaction. Desktop restricts its
`_nwjsOpenExternal` to https for exactly this reason, and says so: an unrestricted bridge "would let
wiki script launch local files (file://), UNC paths, and any exotic scheme the OS has registered".

**Fix:** allowlist `http`, `https`, `mailto`, `tel` in both places.

## 4. `sanitizeAttachmentName` permits `..` (Info — not exploitable)

The character whitelist `[A-Za-z0-9._-]` allows dots, so the leaf name `..` survives sanitisation.
It does **not** traverse: `File(dir, "..")` exists, so the duplicate-name loop rewrites it to
`.-1.` before anything is written. Traversal is prevented incidentally rather than by rule.

`sanitizeAttachmentRel` gets this right — it drops `.` and `..` segments explicitly. Worth making
the leaf sanitiser do the same, so the property does not depend on an unrelated loop.

## Inspected and found sound

- **Desktop path containment.** `resolveWithin` decodes, rejects NUL, resolves, and realpaths both
  ends before `trust.isInside`, which uses `path.relative` and checks the first segment — so
  `/foo` does not match `/foobar`.
- **`sanitizeAttachmentRel`.** Per-segment whitelist, drops `.`/`..`; cannot escape `attachments/`.
- **`saveBytes` / download.** Routes through a SAF create-document picker: the destination is chosen
  by the user, which is unforgeable from script.
- **`AuthProxy`.** Two doors with different keys — HTTP basic credentials upstream, session cookie
  downstream — and the WebView never holds the credential.
- **Bridge placement.** `TDHost` and `TDPlugins` are attached only to the WikiList's WebView, never
  to a wiki's.
- **Desktop bridges.** Scheme checks on HTTP/WebSocket/openExternal; the file bridge is gated by
  `trust.isTrusted(...)` against the wiki's grants.

## Not audited

Stated so nobody mistakes silence for a clean bill:

- `CollabBridge.lanInit` / `lanAddPeer` / `lanBroadcast` — the LAN peer crypto and pairing.
- `CollabBridge.saveAssetAs`, `MetaBridge`, `SystemBarsBridge`.
- The Yjs/collab protocol itself, and the relay server.
- Desktop `protocol.js` / `deeplink.js` (custom URL scheme) and `embeds.js`.
- Supply chain: dependency provenance, CI signing, update delivery.
