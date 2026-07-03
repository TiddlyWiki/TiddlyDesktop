package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File

/**
 * Manages the collab LAN fast-path helper: a dedicated Node process running lan-helper.js
 * (which drives the shared lan-node.js). Commands are written to its stdin and events read
 * from its stdout, both line-delimited JSON. See CollabBridge (bridge D) and lan-helper.js.
 *
 * Everything here is best-effort and fully guarded: if the helper can't start, dies, or the
 * pipe breaks, we log and stop — collab silently continues over the relay. Nothing thrown here
 * may reach the wiki WebView or crash the :wiki process.
 */
class LanNodeHelper(
    context: Context,
    /** Called on a background thread for each event line the helper emits. Must not throw. */
    private val onEvent: (JSONObject) -> Unit
) {
    private val appContext = context.applicationContext
    private var process: Process? = null
    private var writer: BufferedWriter? = null
    @Volatile private var running = false

    /** Spawn the helper. Returns true if it started; false (logged) means run relay-only. */
    @Synchronized
    fun start(): Boolean {
        if (running) return true
        return try {
            NodeEnvironment.ensureLanExtracted(appContext)
            val node = NodeEnvironment.nodeBinary(appContext)
            val helper = NodeEnvironment.lanHelperJs(appContext)
            val lanDir = NodeEnvironment.lanDir(appContext)
            if (!node.exists() || !helper.exists()) {
                Log.w(TAG, "LAN helper not available (node=${node.exists()} helper=${helper.exists()}) — relay-only")
                return false
            }
            val pb = ProcessBuilder(node.absolutePath, helper.absolutePath).directory(lanDir)
            NodeEnvironment.applyEnv(appContext, pb.environment())
            val proc = pb.start()
            process = proc
            writer = proc.outputStream.bufferedWriter()
            running = true

            // stdout → events. forEachLine blocks until the process exits, then we mark stopped.
            Thread {
                runCatching {
                    proc.inputStream.bufferedReader().use { r ->
                        r.forEachLine { line ->
                            if (line.isNotBlank()) {
                                runCatching { onEvent(JSONObject(line)) }
                                    .onFailure { Log.w(TAG, "bad LAN event: ${it.message}") }
                            }
                        }
                    }
                }
                running = false
                Log.i(TAG, "LAN helper stdout closed (process exited)")
            }.apply { name = "lan-helper-out"; isDaemon = true; start() }

            // Drain stderr to logcat so a failing helper is diagnosable.
            Thread {
                runCatching {
                    proc.errorStream.bufferedReader().use { r -> r.forEachLine { Log.d("LanHelperNode", it) } }
                }
            }.apply { name = "lan-helper-err"; isDaemon = true; start() }

            Log.i(TAG, "LAN helper started")
            true
        } catch (e: Exception) {
            Log.w(TAG, "LAN helper start failed: ${e.message} — relay-only")
            running = false
            process = null
            writer = null
            false
        }
    }

    /** Write one command line to the helper. No-op (logged) if it isn't running or the pipe broke. */
    @Synchronized
    fun send(cmd: JSONObject) {
        val w = writer ?: return
        if (!running) return
        try {
            w.write(cmd.toString())
            w.write("\n")
            w.flush()
        } catch (e: Exception) {
            Log.w(TAG, "LAN helper send failed: ${e.message}")
        }
    }

    @Synchronized
    fun stop() {
        running = false
        runCatching { writer?.close() }
        runCatching { process?.destroy() }
        writer = null
        process = null
    }

    companion object {
        private const val TAG = "LanNodeHelper"
    }
}
