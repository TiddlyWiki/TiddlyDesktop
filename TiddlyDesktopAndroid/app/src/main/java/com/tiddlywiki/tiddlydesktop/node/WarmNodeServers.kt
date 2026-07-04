package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.util.Log
import com.tiddlywiki.tiddlydesktop.WikiServerService

/**
 * #3 — a tiny bounded pool of *warm* folder-wiki NodeServers, living in the :wiki process.
 *
 * Closing a folder wiki PARKS its still-running server here instead of killing it, so reopening
 * the SAME wiki skips both the SAF re-mirror and the multi-second Node boot. Bounded to [MAX_WARM]
 * because each node ≈ 150 MB: the LRU is stopped on overflow, and everything is dropped under
 * memory pressure ([clear], called from WikiActivity.onTrimMemory).
 *
 * While the pool holds anything it keeps the WikiServerService foreground (via [WikiServerService.
 * setWarmHeld]) so Android doesn't reap the :wiki process — and the warm servers with it. All
 * operations are best-effort and guarded; a failure just means the next open boots fresh.
 */
object WarmNodeServers {
    private const val TAG = "WarmNodeServers"
    private const val MAX_WARM = 1

    private class Entry(val key: String, val server: NodeServer)

    // LRU order: last = most recently parked.
    private val warm = ArrayList<Entry>()
    private val lock = Any()

    /**
     * Take (remove) a warm, still-running server for [key] (the wiki path). Null if none — the
     * caller then boots fresh. The caller owns the returned server again (it will park or stop it).
     */
    fun take(context: Context, key: String): NodeServer? {
        val server = synchronized(lock) {
            val i = warm.indexOfFirst { it.key == key }
            if (i < 0) null else warm.removeAt(i).server
        }
        updateHold(context)
        if (server == null) return null
        if (!server.isRunning) { runCatching { server.stop() }; return null }
        Log.i(TAG, "reusing warm server for $key")
        return server
    }

    /** Park a running [server] for [key] instead of stopping it on close. */
    fun park(context: Context, key: String, server: NodeServer) {
        if (!server.isRunning) { runCatching { server.stop() }; return }
        val evicted = ArrayList<NodeServer>()
        synchronized(lock) {
            warm.removeAll { it.key == key }            // drop any stale entry for this key
            warm.add(Entry(key, server))
            while (warm.size > MAX_WARM) evicted.add(warm.removeAt(0).server)
        }
        evicted.forEach { runCatching { it.stop() } }
        Log.i(TAG, "parked warm server for $key (pool=${synchronized(lock) { warm.size }})")
        updateHold(context)
    }

    /** Stop and drop every warm server (memory pressure / process teardown). */
    fun clear(context: Context) {
        val all = synchronized(lock) { val c = warm.map { it.server }; warm.clear(); c }
        all.forEach { runCatching { it.stop() } }
        if (all.isNotEmpty()) Log.i(TAG, "cleared ${all.size} warm server(s)")
        updateHold(context)
    }

    private fun updateHold(context: Context) {
        val held = synchronized(lock) { warm.isNotEmpty() }
        runCatching { WikiServerService.setWarmHeld(context, held) }
    }
}
