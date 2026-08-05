package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.util.Log
import com.tiddlywiki.tiddlydesktop.server.AuthProxy
import java.io.BufferedReader
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

/**
 * Spawns and supervises a single `tiddlywiki <folder> --listen` Node.js server.
 *
 * The WebView never talks to Node directly. Node binds loopback on a PRIVATE port behind HTTP
 * basic credentials generated per launch, and an [AuthProxy] on [port] is what the WebView loads;
 * the proxy holds the credentials and admits callers on a session cookie. On Android 127.0.0.1 is
 * reachable by any app holding INTERNET, so an unauthenticated Node server meant every other app
 * on the device could read and rewrite an open wiki. Both ports now need a secret to get past.
 *
 * Node needs a *filesystem* path; folder wikis are served directly from their real path in
 * shared storage (All-Files-Access), so there's no SAF copy/mirror.
 */
class NodeServer(
    private val context: Context,
    private val wikiFolder: File,
    private val port: Int = allocatePort()
) {
    private var process: Process? = null
    @Volatile var isRunning = false; private set

    // Node's own port, reachable only with the credentials below. Distinct from [port], which is
    // the proxy's and the only one anything outside this class is given.
    //
    // MUST exclude [port] explicitly. allocatePort() hands out the first free port from 38000, and
    // callers may ASK for a fixed one from that same range (the WikiList pins 38000 so a
    // language-switch reboot rebinds a stable URL). Nothing has bound it yet at construction time,
    // so the allocator would hand back the very port the proxy is about to take -- Node and the
    // proxy then fight over one port and neither comes up, which presents as the WikiList never
    // loading.
    private val nodePort: Int = allocatePort(avoid = port)
    private val nodeUser: String = "td"
    private val nodePassword: String = AuthProxy.randomToken()
    private var proxy: AuthProxy? = null

    /** The address for the WebView: the proxy, carrying its one-time token. */
    val url: String get() = proxy?.url ?: "http://127.0.0.1:$port/"

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
        val cmd = listOf(node.absolutePath) +
            // Confine what a wiki's own module-type tiddlers can reach once Node executes them.
            NodeEnvironment.permissionFlags(context, wikiFolder) +
            listOf(
            bootScript.absolutePath,
            wikiFolder.absolutePath,
            "--listen",
            "port=$nodePort",
            "host=127.0.0.1",
            // Without these, any app on the device can read and write this wiki. TiddlyWiki
            // requires BOTH to enforce anything -- a username with no password authenticates
            // nobody -- and the password is random per launch and never leaves this process.
            "username=$nodeUser",
            "password=$nodePassword",
            // Declares the above as a credential rather than a person. Without it /status
            // reports it as the logged-in user, the syncer copies that into
            // $:/status/UserName, and every edit gets signed "td". Read by our get-status
            // override; see overrides/core-server/ in the desktop repo.
            "system-username=$nodeUser"
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
            Log.w(TAG, "node server on port $nodePort exited (code=$code)")
        }.apply { isDaemon = true; start() }

        waitForPort()
        // Only start the gate once Node is actually answering, so the first request through it
        // cannot arrive before there is anything to forward to.
        proxy = AuthProxy(nodePort, nodeUser, nodePassword, port).also { it.start() }
        return url
    }

    fun stop() {
        isRunning = false
        try { proxy?.stop() } catch (_: Exception) {}
        proxy = null
        val p = process
        process = null
        if (p != null) {
            p.destroy()
            // Wait for the process to actually exit so its port is released before any restart
            // (a language switch reboots on the same port). Force-kill if it lingers.
            if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
        }
    }

    /** One-shot `tiddlywiki <folder> --init server` to turn an empty folder into a wiki folder. */
    private fun initWikiFolder(node: File, twJs: File, twDir: File) {
        Log.i(TAG, "Initialising new wiki folder: ${wikiFolder.absolutePath}")
        wikiFolder.mkdirs()
        val pb = ProcessBuilder(
            listOf(node.absolutePath) + NodeEnvironment.permissionFlags(context, wikiFolder) +
                listOf(twJs.absolutePath, wikiFolder.absolutePath, "--init", "server")
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
                Socket("127.0.0.1", nodePort).use { return }
            } catch (_: Exception) {
                Thread.sleep(200)
            }
        }
        Log.w(TAG, "node server on port $nodePort not ready after ${timeoutMs}ms")
    }

    companion object {
        private const val TAG = "NodeServer"

        // Node servers: 38000-38999 (mirrors the RS convention, leaves room for other servers).
        private val nextPort = AtomicInteger(38000)

        /** [avoid] is a port a caller has reserved but not yet bound, so probing cannot see it. */
        fun allocatePort(avoid: Int = -1): Int {
            repeat(1000) {
                val p = nextPort.getAndUpdate { if (it >= 38999) 38000 else it + 1 }
                if (p != avoid) {
                    try {
                        ServerSocket(p).use { return p }
                    } catch (_: Exception) { /* in use, try next */ }
                }
            }
            error("No free port in 38000-38999")
        }
    }
}
