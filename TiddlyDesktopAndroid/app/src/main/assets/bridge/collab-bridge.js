/*
 * Collab bridge shim for the codemirror-6-collab-nwjs plugin on Android.
 *
 * The plugin (running in this WebView) expects the NW.js host's `window._nwjs*` API.
 * Android has no `require`/`nw.Shell`, so we reimplement that contract on top of the
 * native `TDCollab` @JavascriptInterface (see collab/CollabBridge.kt and ANDROID.md
 * Part 8). Injected in WikiActivity.onPageFinished().
 *
 * Bridges implemented: A (HTTP + openExternal), B (relay WebSocket), C stubs.
 * Bridge D (LAN peers) is intentionally absent — relay-only collaboration works.
 */
(function () {
    if (window.__tdCollabBridge) return;
    window.__tdCollabBridge = true;
    if (typeof TDCollab === "undefined") { return; }

    // ── A) HTTP GET (CORS-free) + open system browser ────────────────────────────
    window._nwjsHttpResults = {};
    window._nwjsHttpQueue = [];
    // Keep it a real Array (the plugin checks Array.isArray) but route push -> native.
    window._nwjsHttpQueue.push = function (req) {
        try { TDCollab.httpGet(req.id, req.url, JSON.stringify(req.headers || {})); } catch (e) {}
        return 0;
    };
    window._nwjsOpenExternal = function (url) {
        try { TDCollab.openExternal(url); } catch (e) {}
    };

    // ── B) Relay WebSocket (custom Authorization header, text frames) ─────────────
    var _wsSeq = 0;
    window._nwjsWsCreate = function (url, headers) {
        var id = ++_wsSeq;
        try { TDCollab.wsCreate(id, url, JSON.stringify(headers || {})); } catch (e) {}
        return id;
    };
    window._nwjsWsSend = function (id, data) {
        // Relay payloads are strings (JSON); coerce anything else to string.
        try { TDCollab.wsSend(id, typeof data === "string" ? data : String(data)); } catch (e) {}
    };
    window._nwjsWsTerminate = function (id) {
        try { TDCollab.wsClose(id); } catch (e) {}
    };
    // Native calls window._nwjsWsOnEvent(id, type, data) directly.

    // ── C) Asset file I/O (SAF) — stubbed until Phase 2 ──────────────────────────
    try { window._nwjsWikiDir = TDCollab.wikiDir(); } catch (e) { window._nwjsWikiDir = ""; }
    try { window._nwjsHostname = TDCollab.hostname(); } catch (e) {}
    window._nwjsFileResults = {};
    window._nwjsFileCmdQueue = [];
    window._nwjsFileCmdQueue.push = function (cmd) {
        try { TDCollab.fileCmd(cmd.id, cmd.op, cmd.path, cmd.base64 || ""); } catch (e) {}
        return 0;
    };

    // ── Signal readiness to the plugin ───────────────────────────────────────────
    // The plugin defines these ready handlers during its OWN boot (oauth.js / transport.js).
    // This shim is injected at onPageFinished, which may run BEFORE or AFTER that boot, so a
    // one-shot call races: if we fire before the handler exists it's lost — and critically the
    // OAuth result poller (started by _nwjsHttpQueueReady) then NEVER starts → no token → the
    // relay refuses the socket → collab silently never connects. So poll until each handler
    // appears and call it exactly once.
    var httpReady = false, wsReady = false, tries = 0;
    (function signalReady() {
        try { if (!httpReady && typeof window._nwjsHttpQueueReady === "function") { window._nwjsHttpQueueReady(); httpReady = true; } } catch (e) {}
        try { if (!wsReady && typeof window._nwjsWsBridgeReady === "function") { window._nwjsWsBridgeReady(); wsReady = true; } } catch (e) {}
        if ((!httpReady || !wsReady) && tries++ < 100) { setTimeout(signalReady, 150); }
    })();

    console.log("[td-collab-bridge] installed");
})();
