package com.tiddlywiki.tiddlydesktop.collab

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import com.tiddlywiki.tiddlydesktop.node.LanNodeHelper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Native backing for the codemirror-6-collab-nwjs plugin's `window._nwjs*` bridge
 * contract (see README.md → "The `window._nwjs*` bridge contract"). Exposed to the wiki WebView
 * as `TDCollab`.
 *
 * Implemented here (Phase 1 + partial 2):
 *   - httpGet     : CORS-free HTTP GET for the relay REST API (bridge A)
 *   - openExternal: system browser for OAuth (bridge A)
 *   - wsCreate/wsSend/wsClose : WebSocket with custom Authorization header (bridge B)
 *   - wikiDir     : base dir string for asset path resolution (bridge C)
 *   - fileCmd     : asset read/write to the wiki's folder on disk (bridge C)
 *
 * NOT implemented: the LAN peer transport (bridge D) — relay-only works without it.
 *
 * Every callback into JS goes through webView.post { evaluateJavascript(...) } to stay
 * on the UI thread. All @JavascriptInterface methods run on a background WebView thread.
 */
class CollabBridge(
    private val activity: Activity,
    private val webView: WebView,
    /** Base directory / identity of the current wiki, used for relative asset paths. */
    private val wikiDir: String
) {
    private val http = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        // Actively keep the relay WebSocket alive and detect dead half-open links: OkHttp sends a
        // ping every 20s and fails the socket if no pong comes back. Without this the socket leaned
        // entirely on the relay's inbound pings to avoid the read timeout, and a live-but-idle link
        // could drop. (20s < the relay's 60s idle close, matching the NW.js `ws` behaviour.)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val sockets = ConcurrentHashMap<Int, WebSocket>()

    // Per-socket heartbeat feeding a synthetic "ping" to the collab plugin's JS liveness watchdog.
    private val heartbeats = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    private val heartbeatExec = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "collab-ws-heartbeat").apply { isDaemon = true }
    }

    // ── bridge A: HTTP + open browser ──────────────────────────────────────────

    @JavascriptInterface
    fun httpGet(id: Int, url: String, headersJson: String) {
        if (!schemeAllowed(url, ws = false)) {
            Log.w(TAG, "httpGet refused a non-web scheme: $url")
            deliverHttp(id, err = "URL scheme not permitted", jsonBody = null)
            return
        }
        Thread {
            try {
                val builder = Request.Builder().url(url)
                jsonToMap(headersJson).forEach { (k, v) -> builder.header(k, v) }
                http.newCall(builder.get().build()).execute().use { resp: Response ->
                    if (!resp.isSuccessful) {
                        deliverHttp(id, err = "HTTP ${resp.code}", jsonBody = null)
                    } else {
                        // The plugin reads _nwjsHttpResults[id].data as an *object*, so we
                        // hand back the raw JSON text as the object literal value.
                        deliverHttp(id, err = null, jsonBody = resp.body?.string() ?: "null")
                    }
                }
            } catch (e: Exception) {
                deliverHttp(id, err = e.message ?: "request failed", jsonBody = null)
            }
        }.start()
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        // Record which wiki opened the browser, so the tiddlydesktop:// OAuth return
        // (OAuthRedirectActivity) can bring THIS wiki window back to front — its paused WebView
        // then resumes and oauth.js's relay poll finalises the token.
        runCatching { java.io.File(activity.filesDir, "collab-oauth-origin").writeText(wikiDir) }
        // Scheme-gated: this is reachable from any wiki's JavaScript, and an unrestricted
        // ACTION_VIEW is a deep link into any app on the device. See host/ExternalLinks.kt.
        com.tiddlywiki.tiddlydesktop.host.ExternalLinks.open(activity, Uri.parse(url))
    }

    private fun deliverHttp(id: Int, err: String?, jsonBody: String?) {
        val result = if (err != null) {
            "{err:${jsStr(err)}}"
        } else {
            "{data:${jsonBody ?: "null"}}"
        }
        eval("window._nwjsHttpResults && (window._nwjsHttpResults[$id]=$result);")
    }

    // ── bridge B: relay WebSocket (text frames, custom headers) ──────────────────

    @JavascriptInterface
    fun wsCreate(id: Int, url: String, headersJson: String) {
        if (!schemeAllowed(url, ws = true)) {
            Log.w(TAG, "wsCreate refused a non-WebSocket scheme: $url")
            wsEvent(id, "error", "URL scheme not permitted")
            return
        }
        try {
            val builder = Request.Builder().url(url)
            builder.header("User-Agent", "TiddlyDesktopAndroid/1.0")
            jsonToMap(headersJson).forEach { (k, v) -> builder.header(k, v) }
            val ws = http.newWebSocket(builder.build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    startHeartbeat(id)
                    wsEvent(id, "open", null)
                }
                override fun onMessage(webSocket: WebSocket, text: String) =
                    wsEvent(id, "message", text)
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) =
                    // Relay frames are text; if a binary frame arrives, decode as UTF-8.
                    wsEvent(id, "message", bytes.utf8())
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                    stopHeartbeat(id)
                    sockets.remove(id)
                    wsEvent(id, "close", null)
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    stopHeartbeat(id)
                    sockets.remove(id)
                    wsEvent(id, "error", t.message ?: "ws failure")
                }
            })
            sockets[id] = ws
        } catch (e: Exception) {
            wsEvent(id, "error", e.message ?: "ws create failed")
        }
    }

    @JavascriptInterface
    fun wsSend(id: Int, data: String) {
        sockets[id]?.send(data)
    }

    @JavascriptInterface
    fun wsClose(id: Int) {
        stopHeartbeat(id)
        sockets.remove(id)?.cancel()
    }

    /**
     * Keep the collab plugin's JS liveness watchdog satisfied on a healthy but idle link. That
     * watchdog force-reconnects if it hears no relay activity for ~50s, and on NW.js the relay's
     * keepalive pings arrive as "ping" events that reset its timer. OkHttp answers those pings
     * internally and never surfaces them, so without this the watchdog would tear down and rebuild
     * a perfectly good socket every ~50s. OkHttp's own pingInterval remains the real dead-link
     * detector: a genuinely dead socket fails there and stops the heartbeat via onFailure.
     */
    private fun startHeartbeat(id: Int) {
        stopHeartbeat(id)
        heartbeats[id] = heartbeatExec.scheduleWithFixedDelay(
            { if (sockets.containsKey(id)) wsEvent(id, "ping", null) },
            20, 20, TimeUnit.SECONDS
        )
    }

    private fun stopHeartbeat(id: Int) {
        heartbeats.remove(id)?.cancel(false)
    }

    private fun wsEvent(id: Int, type: String, data: String?) {
        val dataArg = if (data == null) "null" else jsStr(data)
        eval("window._nwjsWsOnEvent && window._nwjsWsOnEvent($id,'$type',$dataArg);")
    }

    // ── bridge D: LAN peers (fast direct path via a Node helper) ─────────────────
    // The WebView has no Node, so the LAN node (lan-node.js, X25519 + ChaCha20 + a WS
    // listener) runs in a helper process — mirroring how desktop single-file wikis run it in
    // the parent. Failsafe: a helper that can't start / dies just means no LAN events, and the
    // plugin (transport.js) stays on the relay. Nothing here throws into the WebView.
    private var lanHelper: LanNodeHelper? = null

    /** Lazily start the helper on first use. Returns null (→ relay-only) if it won't start. */
    @Synchronized
    private fun ensureLanHelper(): LanNodeHelper? {
        lanHelper?.let { return it }
        val h = LanNodeHelper(activity.applicationContext) { ev -> onLanEvent(ev) }
        if (!h.start()) return null
        lanHelper = h
        return h
    }

    @JavascriptInterface
    fun lanInit(roomKeyHex: String, deviceId: String) {
        val h = ensureLanHelper() ?: return
        h.send(JSONObject().put("cmd", "init").put("key", roomKeyHex).put("deviceId", deviceId))
    }

    @JavascriptInterface
    fun lanAddPeer(deviceId: String, pubkey: String, endpointsJson: String) {
        val h = lanHelper ?: return
        val eps = runCatching { JSONArray(endpointsJson) }.getOrDefault(JSONArray())
        h.send(JSONObject().put("cmd", "addPeer").put("deviceId", deviceId).put("pubkey", pubkey).put("endpoints", eps))
    }

    @JavascriptInterface
    fun lanBroadcast(json: String) {
        lanHelper?.send(JSONObject().put("cmd", "broadcast").put("json", json))
    }

    @JavascriptInterface
    fun lanClose() {
        lanHelper?.send(JSONObject().put("cmd", "close"))
    }

    /** A helper event (background thread) → the plugin's window._nwjsLanOn* callbacks. */
    private fun onLanEvent(ev: JSONObject) {
        when (ev.optString("ev")) {
            "ready" -> {
                val pubArg = if (ev.isNull("pubkey")) "null" else jsStr(ev.optString("pubkey"))
                val eps = ev.optJSONArray("endpoints") ?: JSONArray()
                eval("window._nwjsLanOnReady && window._nwjsLanOnReady($pubArg,$eps);")
            }
            "message" -> eval(
                "window._nwjsLanOnMessage && window._nwjsLanOnMessage(" +
                    "${jsStr(ev.optString("peerId"))},${jsStr(ev.optString("json"))});"
            )
            "peers" -> eval("window._nwjsLanOnPeers && window._nwjsLanOnPeers(${ev.optInt("n")});")
        }
    }

    /** Tear the helper down. Called from WikiActivity.onDestroy. */
    fun dispose() {
        lanHelper?.stop()
        lanHelper = null
    }

    // ── bridge C: asset file I/O (SAF) ───────────────────────────────────────────

    @JavascriptInterface
    fun wikiDir(): String = wikiDir

    /** A human-meaningful machine name (shown in the collab member list). */
    @JavascriptInterface
    fun hostname(): String =
        listOf(android.os.Build.MODEL, android.os.Build.DEVICE).firstOrNull { !it.isNullOrBlank() } ?: "android"

    /** Ask the user where to save a collab asset (SAF "Save As"); resolves to a content:// dest. */
    @JavascriptInterface
    fun saveAssetAs(title: String, filename: String) {
        (activity as? com.tiddlywiki.tiddlydesktop.WikiActivity)?.pickCollabSave(title, filename)
    }

    @JavascriptInterface
    fun fileCmd(id: String, op: String, path: String, base64: String) {
        Thread {
            val result = runCatching {
                val wa = activity as? com.tiddlywiki.tiddlydesktop.WikiActivity
                // A wiki-relative "./attachments/<name>" _canonical_uri lives in the wiki's own
                // attachments folder (SAF single-file / local mirror folder), NOT a filesystem path;
                // route both read and write through WikiActivity so they resolve symmetrically.
                val attachName = attachmentName(path)
                when (op) {
                    "write" -> {
                        if (wa != null && attachName != null) {
                            "{data:${jsStr(wa.writeCollabAsset(base64, attachName))}}"
                        } else {
                            val target = confinedFile(path)
                                ?: throw SecurityException("refused a write outside the wiki: $path")
                            java.io.FileOutputStream(target).use { it.write(android.util.Base64.decode(base64, android.util.Base64.DEFAULT)) }
                            "{data:${jsStr(target.absolutePath)}}"
                        }
                    }
                    "read" -> {
                        val bytes = if (wa != null && attachName != null) {
                            wa.readAttachmentBytes(attachName) ?: throw java.io.FileNotFoundException("attachment not found: $path")
                        } else {
                            val source = confinedFile(path)
                                ?: throw SecurityException("refused a read outside the wiki: $path")
                            java.io.FileInputStream(source).use { it.readBytes() }
                        }
                        "{data:${jsStr(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))}}"
                    }
                    else -> "{err:${jsStr("unsupported file op: $op")}}"
                }
            }.getOrElse { "{err:${jsStr(it.message ?: "file error")}}" }
            eval("window._nwjsFileResults && (window._nwjsFileResults[${jsStr(id)}]=$result);")
        }.start()
    }

    /** If [path] is a wiki-relative attachments reference, its decoded file name; else null. */
    private fun attachmentName(path: String): String? {
        val p = path.removePrefix("./")
        // Keep the full sub-path under attachments/ (subfolders preserved), not just the basename.
        return if (p.startsWith("attachments/")) Uri.decode(p.removePrefix("attachments/")).ifBlank { null } else null
    }

    /**
     * Web schemes only, for the two bridges that make a network request on the page's behalf.
     *
     * These answer with the raw response, so they are CORS-free fetches — a real capability the
     * page does not otherwise have, and one that bypasses the wiki's Content-Security-Policy
     * because the request is made by the app rather than by the document. Restricting the scheme
     * is what the desktop bridge does (source/js/utils/bridges.js, "URL scheme not permitted").
     *
     * Deliberately NOT host-scoped: collab relays are frequently self-hosted on a LAN or on
     * localhost, so pinning to a host list would break legitimate setups. The residual surface is
     * reads of whatever HTTP endpoints the device can reach; see docs/security-audit-2026-08.md.
     */
    private fun schemeAllowed(url: String, ws: Boolean): Boolean {
        val u = url.trim().lowercase()
        return if (ws) u.startsWith("ws://") || u.startsWith("wss://")
        else u.startsWith("http://") || u.startsWith("https://")
    }

    /**
     * Resolve a raw fileCmd path, or null if it escapes the wiki's own directory.
     *
     * fileCmd is reachable from the wiki's own JavaScript, so an unconstrained path here is
     * arbitrary file read and write with this app's authority -- which, holding All-Files-Access,
     * is the user's entire shared storage plus this app's private data directory. Collab assets
     * never need that: they arrive as "attachments/<name>" and are handled by the branch above,
     * which resolves them against the wiki's own folder. Anything else is confined to the wiki
     * directory, and content:// URIs are refused outright -- a wiki naming a provider URI is not
     * a case that arises legitimately, and honouring one would reach into other apps' data
     * through permissions this app holds.
     *
     * Same confinement the share bridge already has (WikiActivity.stagedShareFile).
     */
    private fun confinedFile(path: String): java.io.File? {
        if (path.isBlank() || path.startsWith("content://")) {
            Log.w(TAG, "refused a non-filesystem fileCmd path: $path")
            return null
        }
        val base = runCatching { java.io.File(wikiDir).canonicalFile }.getOrNull()
        if (base == null) {
            Log.w(TAG, "no wiki directory to confine fileCmd against; refusing: $path")
            return null
        }
        val resolved = runCatching {
            val f = java.io.File(path).canonicalFile
            if (f == base) return@runCatching f
            var parent: java.io.File? = f.parentFile
            while (parent != null) {
                if (parent == base) return@runCatching f
                parent = parent.parentFile
            }
            null
        }.getOrNull()
        if (resolved == null) Log.w(TAG, "refused a fileCmd path outside the wiki dir: $path")
        return resolved
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    private fun eval(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun jsonToMap(json: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        if (json.isBlank()) return out
        val obj = JSONObject(json)
        obj.keys().forEach { k -> out[k] = obj.getString(k) }
        return out
    }

    /** JSON-encode a string so it is safe to splice into an evaluateJavascript literal. */
    private fun jsStr(s: String): String = JSONObject.quote(s)

    companion object {
        private const val TAG = "CollabBridge"
        const val INTERFACE_NAME = "TDCollab"

        /** JS shim asset injected after page load; adapts window._nwjs* to TDCollab. */
        const val SHIM_ASSET = "bridge/collab-bridge.js"
    }
}
