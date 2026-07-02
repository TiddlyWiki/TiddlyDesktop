package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

/**
 * Spawns and supervises a single `tiddlywiki <folder> --listen` Node.js server.
 *
 * Node servers bind loopback (127.0.0.1) on a free port. The WebView then loads
 * http://127.0.0.1:PORT. One instance per open wiki (and one for the WikiList).
 *
 * NOTE: Node needs a *filesystem* path. SAF (content://) folder wikis must first be
 * copied to a local dir (see SafMirror — TODO) and this server pointed at that copy.
 */
class NodeServer(
    private val context: Context,
    private val wikiFolder: File,
    private val port: Int = allocatePort()
) {
    private var process: Process? = null
    @Volatile var isRunning = false; private set

    val url: String get() = "http://127.0.0.1:$port"

    fun start(): String {
        val node = NodeEnvironment.nodeBinary(context)
        val twJs = NodeEnvironment.tiddlywikiJs(context)
        val twDir = NodeEnvironment.tiddlywikiDir(context)

        // A picked folder that isn't a wiki folder yet (no tiddlywiki.info) is initialized
        // as a TiddlyWiki "server" edition so there is something to serve. Existing wiki
        // folders are left untouched.
        if (!File(wikiFolder, "tiddlywiki.info").exists()) {
            initWikiFolder(node, twJs, twDir)
        }

        // Boot via our wrapper so the WikiList can use its "backstage" language set.
        val bootScript = NodeEnvironment.ensureBackstageBootScript(context)
        val cmd = listOf(
            node.absolutePath,
            bootScript.absolutePath,
            wikiFolder.absolutePath,
            "--listen",
            "port=$port",
            "host=127.0.0.1"
        )
        Log.i(TAG, "Starting node server: ${cmd.joinToString(" ")}")

        val pb = ProcessBuilder(cmd)
            .directory(twDir)
            .redirectErrorStream(true)
        NodeEnvironment.applyEnv(context, pb.environment())

        // Plugin path: the wiki folder's own plugins (e.g. the WikiList's tiddlydesktop
        // plugin) plus the user's custom plugin library, both resolvable by name.
        val pluginPaths = mutableListOf<String>()
        File(wikiFolder, "plugins").takeIf { it.isDirectory }?.let { pluginPaths.add(it.absolutePath) }
        if (NodeEnvironment.hasCustomPlugins(context)) pluginPaths.add(NodeEnvironment.customPluginsDir(context).absolutePath)
        if (pluginPaths.isNotEmpty()) {
            pb.environment()["TIDDLYWIKI_PLUGIN_PATH"] = pluginPaths.joinToString(":")
        }

        // If the wiki folder ships a "backstage" language set (languages with the
        // TiddlyDesktop UI strings merged + plugin-priority 100), use it as the primary
        // language path, falling back to the engine's clean languages for the rest.
        val langDir = File(wikiFolder, "languages")
        if (langDir.isDirectory) {
            pb.environment()["TD_LANGUAGES_PATH"] = langDir.absolutePath
            pb.environment()["TIDDLYWIKI_LANGUAGE_PATH"] = File(twDir, "languages").absolutePath
        }
        // Also expose the engine's theme path (the PluginChooser will read these to list
        // installable items, once wired up).
        if (File(twDir, "themes").isDirectory) {
            pb.environment()["TIDDLYWIKI_THEME_PATH"] = File(twDir, "themes").absolutePath
        }

        val proc = pb.start()
        process = proc
        isRunning = true

        // Drain output to logcat so a failing server is diagnosable. Guard the whole loop:
        // when the process is destroyed (e.g. closing a folder wiki) the stream read can throw,
        // and an uncaught exception in this thread would kill the :wiki process.
        Thread {
            runCatching {
                proc.inputStream.bufferedReader().use { r: BufferedReader ->
                    r.forEachLine { Log.d("NodeJS", it) }
                }
            }
        }.apply { isDaemon = true; start() }

        // Reap: mark not-running when the process exits.
        Thread {
            val code = try { proc.waitFor() } catch (_: InterruptedException) { -1 }
            isRunning = false
            Log.w(TAG, "node server on port $port exited (code=$code)")
        }.apply { isDaemon = true; start() }

        waitForPort()
        return url
    }

    fun stop() {
        isRunning = false
        process?.destroy()
        process = null
    }

    /** One-shot `tiddlywiki <folder> --init server` to turn an empty folder into a wiki folder. */
    private fun initWikiFolder(node: File, twJs: File, twDir: File) {
        Log.i(TAG, "Initialising new wiki folder: ${wikiFolder.absolutePath}")
        wikiFolder.mkdirs()
        val pb = ProcessBuilder(
            node.absolutePath, twJs.absolutePath, wikiFolder.absolutePath, "--init", "server"
        ).directory(twDir).redirectErrorStream(true)
        NodeEnvironment.applyEnv(context, pb.environment())
        try {
            val proc = pb.start()
            Thread {
                runCatching { proc.inputStream.bufferedReader().use { r -> r.forEachLine { Log.d("NodeJS", it) } } }
            }.apply { isDaemon = true; start() }
            val ok = proc.waitFor(60, java.util.concurrent.TimeUnit.SECONDS)
            if (!ok) { proc.destroy(); Log.w(TAG, "--init timed out") }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to init wiki folder: ${e.message}")
        }
    }

    /** Poll loopback until the server accepts a connection (or we give up). */
    private fun waitForPort(timeoutMs: Long = 15000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                Socket("127.0.0.1", port).use { return }
            } catch (_: Exception) {
                Thread.sleep(200)
            }
        }
        Log.w(TAG, "node server on port $port not ready after ${timeoutMs}ms")
    }

    companion object {
        private const val TAG = "NodeServer"

        // Node servers: 38000-38999 (mirrors the RS convention, leaves room for other servers).
        private val nextPort = AtomicInteger(38000)

        fun allocatePort(): Int {
            repeat(1000) {
                val p = nextPort.getAndUpdate { if (it >= 38999) 38000 else it + 1 }
                try {
                    ServerSocket(p).use { return p }
                } catch (_: Exception) { /* in use, try next */ }
            }
            error("No free port in 38000-38999")
        }
    }
}
