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
        try {
            activity.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            Log.w(TAG, "openExternal failed: ${e.message}")
        }
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
                            openOut(path).use { it.write(android.util.Base64.decode(base64, android.util.Base64.DEFAULT)) }
                            "{data:${jsStr(path)}}"
                        }
                    }
                    "read" -> {
                        val bytes = if (wa != null && attachName != null) {
                            wa.readAttachmentBytes(attachName) ?: throw java.io.FileNotFoundException("attachment not found: $path")
                        } else {
                            openIn(path).use { it.readBytes() }
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
        return if (p.startsWith("attachments/")) Uri.decode(p.substringAfterLast('/')) else null
    }

    private fun openOut(path: String): java.io.OutputStream =
        if (path.startsWith("content://"))
            activity.contentResolver.openOutputStream(Uri.parse(path), "wt") ?: throw java.io.IOException("cannot write $path")
        else java.io.FileOutputStream(path)

    private fun openIn(path: String): java.io.InputStream =
        if (path.startsWith("content://"))
            activity.contentResolver.openInputStream(Uri.parse(path)) ?: throw java.io.IOException("cannot read $path")
        else java.io.FileInputStream(path)

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
