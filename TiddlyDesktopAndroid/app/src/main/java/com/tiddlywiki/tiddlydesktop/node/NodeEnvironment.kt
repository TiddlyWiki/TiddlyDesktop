package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.util.Log
import java.io.File
import java.util.zip.ZipInputStream

/**
 * Resolves everything the bundled Node.js needs to run on Android and prepares the
 * TiddlyWiki resources on disk.
 *
 * Key facts (see ../../../../../../ANDROID.md Part 2):
 *  - The only place Android lets you execute a binary is the app's native library dir,
 *    so the Node binary ships as `libnode.so` in jniLibs and is found there at runtime.
 *  - The Termux-built node links against versioned lib names (libz.so.1, …) that Android
 *    does not package, so we create symlinks and point LD_LIBRARY_PATH at them.
 *  - The Termux binary has hardcoded Termux paths, so we override HOME/TMPDIR/SSL etc.
 *  - TiddlyWiki JS resources are shipped as an assets ZIP and extracted on first run.
 */
object NodeEnvironment {

    private const val TAG = "NodeEnvironment"

    /** Bundled TiddlyWiki engine zip in assets. Produced by the packaging build step. */
    private const val TIDDLYWIKI_ASSET_ZIP = "tiddlywiki.zip"

    /** Bundled WikiList folder-wiki zip in assets. Produced by the packaging build step. */
    private const val WIKILIST_ASSET_ZIP = "wikilist.zip"

    /** Bundled collab LAN helper (lan-helper.js + lan-node.js + ws). May be absent → relay-only. */
    private const val LAN_ASSET_ZIP = "lan.zip"

    /** Versioned -> unversioned library names the node binary dlopen()s. */
    private val LIB_SYMLINKS = listOf(
        "libz.so.1" to "libz.so",
        "libcrypto.so.3" to "libcrypto.so",
        "libssl.so.3" to "libssl.so",
        "libicui18n.so.78" to "libicui18n.so",
        "libicuuc.so.78" to "libicuuc.so",
        "libicudata.so.78" to "libicudata.so"
    )

    /** Absolute path to the executable node binary (libnode.so in the native lib dir). */
    fun nodeBinary(context: Context): File {
        val dir = context.applicationInfo.nativeLibraryDir
        return File(dir, "libnode.so")
    }

    fun nativeLibDir(context: Context): File =
        File(context.applicationInfo.nativeLibraryDir)

    /** Where TiddlyWiki resources are extracted: {filesDir}/tiddlywiki. */
    fun tiddlywikiDir(context: Context): File =
        File(context.filesDir, "tiddlywiki")

    fun tiddlywikiJs(context: Context): File =
        File(tiddlywikiDir(context), "tiddlywiki.js")

    /**
     * Run a one-shot `tiddlywiki.js <args>` command, blocking until it exits. Output is
     * forwarded to logcat. Returns the process exit code (0 = success), or -1 on failure.
     */
    fun runNodeBlocking(context: Context, args: List<String>): Int {
        val node = nodeBinary(context)
        val twDir = tiddlywikiDir(context)
        val cmd = listOf(node.absolutePath, tiddlywikiJs(context).absolutePath) + args
        Log.i(TAG, "node ${args.joinToString(" ")}")
        return try {
            val pb = ProcessBuilder(cmd).directory(twDir).redirectErrorStream(true)
            applyEnv(context, pb.environment())
            val proc = pb.start()
            proc.inputStream.bufferedReader().use { r -> r.forEachLine { Log.d("NodeJS", it) } }
            proc.waitFor()
        } catch (e: Exception) {
            Log.e(TAG, "node command failed: ${e.message}"); -1
        }
    }

    /** A writable scratch dir for node build/convert operations. */
    fun workDir(context: Context): File =
        File(context.cacheDir, "tw-work").apply { mkdirs() }

    /**
     * A tiny boot wrapper equivalent to tiddlywiki.js, but which lets us override the
     * language search path via TD_LANGUAGES_PATH before boot. Needed for the WikiList's
     * "backstage" language set (TiddlyWiki resolves the first matching languages dir, so an
     * env-var append can't override the engine's clean languages — languagesPath must be set).
     */
    fun ensureBackstageBootScript(context: Context): File {
        val f = File(tiddlywikiDir(context), "td-backstage-boot.js")
        val s = "\$tw"
        f.writeText(
            "var $s = require(\"./boot/boot.js\").TiddlyWiki();\n" +
            "$s.boot.argv = Array.prototype.slice.call(process.argv, 2);\n" +
            "$s.config = $s.config || {};\n" +
            "if (process.env.TD_LANGUAGES_PATH) { $s.config.languagesPath = process.env.TD_LANGUAGES_PATH; }\n" +
            "$s.boot.boot();\n"
        )
        return f
    }

    /**
     * Ensure the node binary is present and looks sane. Returns null on success or an
     * error message. Non-fatal for viewing, but folder wikis need it.
     */
    fun verifyNodeBinary(context: Context): String? {
        val node = nodeBinary(context)
        if (!node.exists()) {
            return "Node.js binary (libnode.so) not found at ${node.absolutePath}. " +
                "Ensure it is present in jniLibs/arm64-v8a/."
        }
        if (node.length() < 1_000_000L) {
            return "libnode.so exists but is too small (${node.length()} bytes) — corrupted?"
        }
        return null
    }

    /** Where the WikiList folder wiki is extracted: {filesDir}/wikilist. */
    fun wikiListDir(context: Context): File = File(context.filesDir, "wikilist")

    /** User-chosen custom plugin library (a SAF folder copied here so Node can read it). */
    fun customPluginsDir(context: Context): File = File(context.filesDir, "custom-plugins")

    fun hasCustomPlugins(context: Context): Boolean {
        val d = customPluginsDir(context)
        return d.isDirectory && (d.list()?.isNotEmpty() == true)
    }

    /**
     * Extract the bundled TiddlyWiki engine from assets on first run (or after an app
     * update). Guarded by a version marker file. ZIP entries are prefixed "tiddlywiki/".
     */
    fun ensureResourcesExtracted(context: Context) {
        extractZipAsset(context, TIDDLYWIKI_ASSET_ZIP, tiddlywikiDir(context), stripPrefix = "tiddlywiki/")
    }

    /** Extract the bundled WikiList folder wiki. ZIP entries are prefixed "wikilist/". */
    fun ensureWikiListExtracted(context: Context) {
        extractZipAsset(context, WIKILIST_ASSET_ZIP, wikiListDir(context), stripPrefix = "wikilist/")
    }

    /** The full backstage language set, moved aside so languages/ can hold only the active one. */
    private fun wikiListLanguagesAll(context: Context): File = File(wikiListDir(context), "languages-all")

    /** SharedPreferences holding the WikiList's active language code (e.g. "de-DE"). */
    private fun langPrefs(context: Context) =
        context.getSharedPreferences("wikilist-lang", Context.MODE_PRIVATE)

    /** The active WikiList language code. Defaults to the system language if we ship it, else en-GB. */
    fun activeWikiListLanguage(context: Context): String {
        langPrefs(context).getString("active", null)?.let { return it }
        val all = wikiListLanguagesAll(context)
        val available = (all.list()?.toSet() ?: emptySet()) + "en-GB"
        val sys = context.resources.configuration.locales[0]
        val tag = sys.toLanguageTag()            // e.g. "de-DE"
        return when {
            available.contains(tag) -> tag
            available.contains(sys.language + "-" + sys.language.uppercase()) ->
                sys.language + "-" + sys.language.uppercase()
            else -> available.firstOrNull { it.startsWith(sys.language + "-") } ?: "en-GB"
        }
    }

    fun setActiveWikiListLanguage(context: Context, code: String) {
        langPrefs(context).edit().putString("active", code).apply()
    }

    /**
     * Restrict the WikiList to ONLY the active language so its served page isn't bloated with all
     * ~32 full language plugins (~4 MB, ~80% of the page — only one is ever active). Two independent
     * sources both pull every language, so BOTH must be trimmed:
     *   1. tiddlywiki.info "languages" — rewritten to just [code] (the info list otherwise resolves
     *      every entry from the engine's default languages dir, ignoring the languages path).
     *   2. the wiki-folder languages/ subdir — TiddlyWiki auto-loads every language folder in it, so
     *      we keep the full set in languages-all/ and mirror only the active one into languages/.
     * Also writes $:/language so TiddlyWiki activates it. Idempotent; safe to call every boot.
     */
    fun applyWikiListLanguage(context: Context, code: String) {
        val wl = wikiListDir(context)
        val all = wikiListLanguagesAll(context)
        val active = File(wl, "languages")
        // Capture the full backstage set aside. languages/ holds all ~32 whenever it was just
        // (re)extracted (first run or app update), and only the single active one after we trim it —
        // so a size > 1 means "freshly extracted": (re)build languages-all from it to avoid a stale copy.
        if (!all.exists() || (active.list()?.size ?: 0) > 1) {
            all.deleteRecursively()
            if (active.isDirectory) active.renameTo(all) else all.mkdirs()
        }
        // Rebuild languages/ with only the active language (en-GB lives in the core, needs no plugin).
        active.deleteRecursively(); active.mkdirs()
        if (code != "en-GB") File(all, code).takeIf { it.isDirectory }?.copyRecursively(File(active, code), overwrite = true)
        // tiddlywiki.info: languages -> [code] (preserve everything else).
        runCatching {
            val infoFile = File(wl, "tiddlywiki.info")
            val info = org.json.JSONObject(infoFile.readText())
            info.put("languages", org.json.JSONArray(if (code == "en-GB") emptyList() else listOf(code)))
            infoFile.writeText(info.toString(4))
        }
        // $:/language so TiddlyWiki activates the chosen language on boot. Written as a JSON tiddler
        // (not .tid) so the value is EXACTLY "$:/languages/<code>" — a .tid body keeps its trailing
        // newline, which wouldn't match the switcher's <option> values.
        runCatching {
            val t = File(wl, "tiddlers/_td-active-language.json")
            t.parentFile?.mkdirs()
            // Array form — the JSON tiddler-file deserializer expects [ {…} ], not a {tiddlers:{…}} wrapper.
            t.writeText("[{\"title\":\"\$:/language\",\"text\":\"\$:/languages/$code\"}]")
            File(wl, "tiddlers/_td-active-language.tid").delete() // drop any stale .tid form
        }
    }

    /** Where the collab LAN helper is extracted: {filesDir}/lan (lan-helper.js + lan-node.js + ws). */
    fun lanDir(context: Context): File = File(context.filesDir, "lan")

    /** The LAN helper entrypoint Node runs. Present only when lan.zip was bundled. */
    fun lanHelperJs(context: Context): File = File(lanDir(context), "lan-helper.js")

    /**
     * Extract the bundled LAN helper on first run (idempotent, versioned marker). No prefix in the
     * zip. A missing lan.zip is logged, not fatal — the app just runs collab relay-only.
     */
    fun ensureLanExtracted(context: Context) {
        extractZipAsset(context, LAN_ASSET_ZIP, lanDir(context), stripPrefix = "")
    }

    /**
     * Extract [assetZip] into [destDir], stripping [stripPrefix] from each entry.
     * Idempotent: a `.extracted` marker records the app versionCode + install timestamp, so it
     * re-extracts on first run and on ANY (re)install — including a same-versionCode rebuild, which
     * is common during development. Without the install time, a new APK with an unchanged versionCode
     * would keep serving the stale extracted assets. A missing asset is logged, not fatal.
     */
    private fun extractZipAsset(context: Context, assetZip: String, destDir: File, stripPrefix: String) {
        val marker = File(destDir, ".extracted")
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        val version = "${pkg.versionCode}:${pkg.lastUpdateTime}"
        if (marker.exists() && marker.readText().trim() == version) return

        Log.i(TAG, "Extracting $assetZip -> ${destDir.absolutePath}")
        destDir.mkdirs()
        try {
            context.assets.open(assetZip).use { input ->
                ZipInputStream(input.buffered()).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        val rel = entry.name.removePrefix(stripPrefix)
                        if (rel.isNotEmpty()) {
                            val out = File(destDir, rel)
                            if (entry.isDirectory) {
                                out.mkdirs()
                            } else {
                                out.parentFile?.mkdirs()
                                out.outputStream().use { zip.copyTo(it) }
                            }
                        }
                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            }
            marker.writeText(version)
            Log.i(TAG, "Extracted $assetZip (version $version)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to extract $assetZip: ${e.message} — was the packaging task run?")
        }
    }

    /**
     * Create the versioned-name symlinks the node binary needs and return the dir that
     * holds them (goes first on LD_LIBRARY_PATH).
     */
    fun prepareLibrarySymlinks(context: Context): File {
        val symlinkDir = File(context.filesDir, "node-libs").apply { mkdirs() }
        val nativeDir = nativeLibDir(context)
        for ((versioned, unversioned) in LIB_SYMLINKS) {
            val link = File(symlinkDir, versioned)
            val target = File(nativeDir, unversioned)
            try {
                // Always remove any existing link first. The app's native-lib dir path contains the
                // install hash, which changes on every reinstall/update, so a symlink left from the
                // previous install now dangles (points at a deleted path). File.exists() FOLLOWS the
                // link and returns false for a dangling one, so a guarded delete would skip it and
                // Os.symlink() would then fail with EEXIST — leaving libnode.so unable to find
                // libz.so.1 (→ Node exits → the WebView shows ERR_CONNECTION_REFUSED). delete() does
                // NOT follow the link, so it removes a dangling symlink too.
                link.delete()
                android.system.Os.symlink(target.absolutePath, link.absolutePath)
            } catch (e: Exception) {
                Log.w(TAG, "symlink $versioned -> ${target.name} failed: ${e.message}")
            }
        }
        return symlinkDir
    }

    /** LD_LIBRARY_PATH value: symlink dir first, then the native lib dir. */
    fun ldLibraryPath(context: Context): String {
        val symlinkDir = prepareLibrarySymlinks(context)
        return "${symlinkDir.absolutePath}:${nativeLibDir(context).absolutePath}"
    }

    /**
     * Environment overrides that let the Termux-built node run inside this app's sandbox.
     * Apply to every ProcessBuilder.environment() before spawning node.
     */
    fun applyEnv(context: Context, env: MutableMap<String, String>) {
        env["LD_LIBRARY_PATH"] = ldLibraryPath(context)

        // Don't load Termux's openssl.cnf.
        env["OPENSSL_CONF"] = "/dev/null"

        // System CA bundle so HTTPS (relay REST/WS, cloud savers) works.
        caBundle(context)?.let {
            env["SSL_CERT_FILE"] = it.absolutePath
            env["NODE_EXTRA_CA_CERTS"] = it.absolutePath
        }

        val home = File(context.filesDir, "node_home").apply { mkdirs() }
        env["HOME"] = home.absolutePath

        val tmp = File(context.filesDir, "tmp").apply { mkdirs() }
        env["TMPDIR"] = tmp.absolutePath

        // ── Node startup caches (arm64 boot is dominated by parse/compile + node bootstrap) ──
        // NODE_COMPILE_CACHE: Node ≥22 caches compiled bytecode of require()-loaded modules
        // (boot.js, tiddlywiki.js, ws, …) — cuts Node's own bootstrap cost. Self-healing across
        // node upgrades (V8 tags the cache; a mismatch is ignored + rebuilt).
        env["NODE_COMPILE_CACHE"] = File(context.filesDir, "node-compile-cache").apply { mkdirs() }.absolutePath
        // TW_COMPILE_CACHE_DIR: consumed by the boot.js compile-cache patch (bin/patch-boot-compile-cache.js)
        // to cache the vm.Script bytecode of TiddlyWiki's module tiddlers. The patch creates the
        // version-scoped subdir itself and degrades to plain compilation on any error.
        env["TW_COMPILE_CACHE_DIR"] = File(context.filesDir, "tw-compile-cache").absolutePath
        // TW_STORE_CACHE_DIR: consumed by the boot.js store-cache patch (bin/patch-boot-store-cache.js)
        // to v8-serialize loadPluginFolder's output — skips re-reading/re-parsing packed plugins
        // (esp. the 1.97 MB $:/core) each boot. ~22% faster boot; degrades to plain load on any error.
        env["TW_STORE_CACHE_DIR"] = File(context.filesDir, "tw-store-cache").absolutePath

        env["TZDIR"] = "/system/usr/share/zoneinfo"

        // Make a user-chosen custom plugin library resolvable by name (NodeServer may
        // override/extend this per wiki folder).
        if (hasCustomPlugins(context)) {
            env["TIDDLYWIKI_PLUGIN_PATH"] = customPluginsDir(context).absolutePath
        }
    }

    /**
     * Concatenate Android's individual system PEM certs into a single bundle OpenSSL
     * can consume. Built once, reused.
     */
    private fun caBundle(context: Context): File? {
        val bundle = File(context.filesDir, "cacert.pem")
        if (bundle.exists() && bundle.length() > 1000L) return bundle

        val certsDir = File("/system/etc/security/cacerts")
        if (!certsDir.isDirectory) return null

        val sb = StringBuilder()
        certsDir.listFiles()?.forEach { f ->
            try {
                val text = f.readText()
                if (text.contains("-----BEGIN CERTIFICATE-----")) {
                    sb.append(text)
                    if (!text.endsWith("\n")) sb.append("\n")
                }
            } catch (_: Exception) { /* skip unreadable certs */ }
        }
        if (sb.isEmpty()) return null
        bundle.writeText(sb.toString())
        return bundle
    }
}
