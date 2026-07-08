package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.documentfile.provider.DocumentFile
import com.tiddlywiki.tiddlydesktop.host.WikiUrl
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * `window.TDPlugins` — the native backing for the PluginChooser (the WebView has no Node
 * `fs`, so enumeration and install/remove happen here). Added to the WikiList's WebView.
 *
 *  - listAvailable()      : plugins/themes/languages in the engine + WikiList library dirs
 *  - getInstalled(url)    : what a given wiki already has (store scan / tiddlywiki.info)
 *  - apply(url, ins, rem) : install/remove — folder wikis edit tiddlywiki.info; single-file
 *                           wikis are rebuilt via Node (file→folder, edit info, folder→file)
 *
 * All @JavascriptInterface methods are synchronous (they return JSON strings), so the JS
 * manager can use them exactly where it used `fs`.
 */
class PluginBridge(private val context: Context) {

    // ── enumeration (cached; the bundled library doesn't change at runtime) ───────

    @Volatile private var availableCache: String? = null

    @JavascriptInterface
    fun listAvailable(): String {
        availableCache?.let { return it }
        synchronized(this) {
            availableCache?.let { return it }
            val arr = JSONArray()
            val tw = NodeEnvironment.tiddlywikiDir(context)
            val wl = NodeEnvironment.wikiListDir(context)
            scanNested(File(tw, "plugins"), "bundled", arr)
            scanNested(File(wl, "plugins"), "external", arr)
            scanNested(File(tw, "themes"), "bundled", arr)
            // Only the CLEAN engine languages are installable into user wikis — never the
            // WikiList's backstage language set (which carries the TiddlyDesktop UI strings
            // and plugin-priority 100).
            scanFlat(File(tw, "languages"), "bundled", arr)
            // User's custom plugin library (folders may be author/name-nested or flat).
            val custom = NodeEnvironment.customPluginsDir(context)
            scanNested(custom, "custom", arr)
            scanFlat(custom, "custom", arr)
            return arr.toString().also { availableCache = it }
        }
    }

    /** Drop the cached library list (call after the custom plugin folder changes). */
    fun invalidateCache() { availableCache = null }

    /** Whether the given wiki is currently open in a WikiActivity (any process). */
    @JavascriptInterface
    fun isWikiOpen(url: String): Boolean {
        val d = WikiUrl.decode(url) ?: return false
        val dataUri = Uri.parse("tdwiki://" + Uri.encode(d.path))
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        return am.appTasks.any { runCatching { it.taskInfo.baseIntent.data }.getOrNull() == dataUri }
    }

    private fun scanNested(root: File, source: String, out: JSONArray) {
        root.listFiles()?.filter { it.isDirectory }?.forEach { author ->
            author.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
                addItem(dir, "${author.name}/${dir.name}", source, out)
            }
        }
    }

    private fun scanFlat(root: File, source: String, out: JSONArray) {
        root.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
            addItem(dir, dir.name, source, out)
        }
    }

    private fun addItem(dir: File, name: String, source: String, out: JSONArray) {
        val info = File(dir, "plugin.info")
        if (!info.exists()) return
        runCatching {
            val json = JSONObject(info.readText())
            val title = json.optString("title")
            if (title.isBlank()) return
            if (title == "\$:/plugins/tiddlywiki/tiddlydesktop") return // don't offer our own
            out.put(JSONObject().apply {
                put("path", dir.absolutePath)
                put("name", name)
                put("title", title)
                put("description", json.optString("description", ""))
                put("version", json.optString("version", ""))
                put("plugin-type", json.optString("plugin-type", "plugin"))
                put("source", source)
            })
        }
    }

    // ── installed detection ───────────────────────────────────────────────────────

    @JavascriptInterface
    fun getInstalled(url: String): String {
        val d = WikiUrl.decode(url) ?: return "{\"titles\":[],\"versions\":{}}"
        return if (d.isFolder) installedFromFolder(d.path) else installedFromFile(d.path)
    }

    private fun installedFromFile(path: String): String {
        val titles = JSONArray(); val versions = JSONObject()
        runCatching {
            val html = readText(path) ?: return@runCatching
            storeArray(html)?.let { arr ->
                for (i in 0 until arr.length()) {
                    val t = arr.optJSONObject(i) ?: continue
                    if (t.optString("plugin-type").isNotBlank() && t.optString("title").isNotBlank()) {
                        titles.put(t.getString("title"))
                        versions.put(t.getString("title"), t.optString("version", ""))
                    }
                }
            }
        }
        return JSONObject().put("titles", titles).put("versions", versions).toString()
    }

    private fun installedFromFolder(path: String): String {
        val titles = JSONArray()
        runCatching {
            val info = JSONObject(readInfo(path) ?: return@runCatching)
            info.optJSONArray("plugins")?.let { for (i in 0 until it.length()) titles.put("\$:/plugins/" + it.getString(i)) }
            info.optJSONArray("themes")?.let { for (i in 0 until it.length()) titles.put("\$:/themes/" + it.getString(i)) }
            info.optJSONArray("languages")?.let { for (i in 0 until it.length()) titles.put("\$:/languages/" + it.getString(i)) }
        }
        return JSONObject().put("titles", titles).put("versions", JSONObject()).toString()
    }

    // ── apply (install / remove) ──────────────────────────────────────────────────

    /** [installJson] = [{name,plugin-type,title}], [removeJson] = [title]. Returns "ok" or an error. */
    @JavascriptInterface
    fun apply(url: String, installJson: String, removeJson: String, backupDir: String, backupCount: Int): String {
        val d = WikiUrl.decode(url) ?: return "bad url"
        val install = JSONArray(installJson)
        val remove = JSONArray(removeJson)
        return runCatching {
            if (d.isFolder) applyFolder(d.path, install, remove)
            else applyFile(d.path, install, remove, backupDir, backupCount)
            "ok"
        }.getOrElse { Log.e(TAG, "apply failed: ${it.message}", it); it.message ?: "error" }
    }

    // ── backstage: install into the running WikiList folder wiki itself ────────────

    /** What the running WikiList (backstage) folder wiki already has installed. */
    @JavascriptInterface
    fun wikiListInstalled(): String = installedFromFolder(NodeEnvironment.wikiListDir(context).absolutePath)

    /**
     * Install/remove into the running WikiList folder wiki's tiddlywiki.info — the "install
     * plugins into the wiki list itself" backstage flow. The caller reboots the WikiList server
     * afterwards (TDHost.reloadWikiList) so the plugin actually boots. Same on-disk edit as a
     * normal folder wiki, so items resolve at boot from the bundled library + custom plugin dir.
     * [installJson] = [{name,plugin-type,title}], [removeJson] = [title]. Returns "ok" or an error.
     */
    @JavascriptInterface
    fun applyToWikiList(installJson: String, removeJson: String): String = runCatching {
        val install = JSONArray(installJson)
        applyFolder(NodeEnvironment.wikiListDir(context).absolutePath, install, JSONArray(removeJson))
        // The WikiList keeps only its ACTIVE language on disk (applyWikiListLanguage trims the rest
        // on reboot), so a language merely added to tiddlywiki.info would be trimmed away again.
        // Installing a language into the wiki list therefore means "switch the wiki list to it" —
        // make it active so the reboot keeps it (and $:/language activates it).
        for (i in 0 until install.length()) {
            val obj = install.getJSONObject(i)
            if (obj.optString("plugin-type") == "language") {
                NodeEnvironment.setActiveWikiListLanguage(context, obj.optString("name").substringAfterLast("/"))
            }
        }
        "ok"
    }.getOrElse { Log.e(TAG, "applyToWikiList failed: ${it.message}", it); it.message ?: "error" }

    /** Folder wiki: edit tiddlywiki.info's plugins/themes/languages arrays in the SAF tree. */
    private fun applyFolder(path: String, install: JSONArray, remove: JSONArray) {
        val info = JSONObject(readInfo(path) ?: error("no tiddlywiki.info"))
        editInfoArrays(info, install, remove)
        writeInfo(path, info.toString(2))
    }

    /**
     * Single-file wiki: splice the plugin tiddler(s) directly into the JSON tiddler store —
     * far lighter than re-rendering the whole wiki. Installs are packed once with Node
     * (json-tiddler template); removals need no Node at all.
     */
    private fun applyFile(path: String, install: JSONArray, remove: JSONArray, backupDir: String, backupCount: Int) {
        val oldBytes = readBytes(path) ?: error("cannot read wiki")
        // Back up the current wiki before editing its store.
        Backups.write(context, path, oldBytes, backupDir.ifBlank { null }, if (backupCount > 0) backupCount else 20)

        val html = oldBytes.toString(Charsets.UTF_8)
        val add = if (install.length() > 0) packPlugins(install) else emptyList()
        val removeTitles = (0 until remove.length()).map { remove.getString(it) }.toMutableSet()
        val newHtml = modifyStore(html, add, removeTitles)
        writeBytes(path, newHtml.toByteArray())
    }

    /** Pack each install plugin into its full JSON tiddler object via one Node render. */
    private fun packPlugins(install: JSONArray): List<JSONObject> {
        val work = File(NodeEnvironment.workDir(context), "pack-${System.currentTimeMillis()}")
        val edition = File(work, "edition"); val out = File(work, "out")
        File(edition, "tiddlers").mkdirs(); out.mkdirs()
        return try {
            val plugins = JSONArray(); val themes = JSONArray(); val languages = JSONArray()
            val args = mutableListOf(edition.absolutePath, "--output", out.absolutePath)
            val titleToFile = LinkedHashMap<String, File>()
            for (i in 0 until install.length()) {
                val it = install.getJSONObject(i)
                val name = it.optString("name"); val title = it.optString("title")
                when (it.optString("plugin-type", "plugin")) {
                    "theme" -> themes.put(name); "language" -> languages.put(name); else -> plugins.put(name)
                }
                val fileName = "p$i.json"
                titleToFile[title] = File(out, fileName)
                args.addAll(listOf("--rendertiddler", title, fileName, "text/plain", "\$:/core/templates/json-tiddler"))
            }
            File(edition, "tiddlywiki.info").writeText(
                JSONObject().put("plugins", plugins).put("themes", themes).put("languages", languages).toString()
            )
            NodeEnvironment.runNodeBlocking(context, args)
            val result = ArrayList<JSONObject>()
            for (f in titleToFile.values) {
                if (!f.exists()) continue
                val o = runCatching { JSONObject(f.readText()) }.getOrNull() ?: continue
                result.add(if (o.optString("plugin-type") == "language") sanitizeLanguage(o) else o)
            }
            result
        } finally {
            work.deleteRecursively()
        }
    }

    // Match TiddlyDesktop: a language installed into a user wiki must be clean — drop the
    // injected "$:/language/TiddlyDesktop/" strings and remove plugin-priority (100 as a
    // number white-screens single-file wikis on boot).
    private fun sanitizeLanguage(obj: JSONObject): JSONObject {
        obj.remove("plugin-priority")
        val text = obj.optString("text")
        if (text.isNotBlank()) runCatching {
            val payload = JSONObject(text)
            val tiddlers = payload.optJSONObject("tiddlers")
            if (tiddlers != null) {
                val keys = ArrayList<String>()
                val iter = tiddlers.keys()
                while (iter.hasNext()) keys.add(iter.next())
                for (k in keys) if (k.startsWith("\$:/language/TiddlyDesktop/")) tiddlers.remove(k)
                obj.put("text", payload.toString())
            }
        }
        return obj
    }

    /** Add/replace/remove tiddlers in the (last) JSON tiddler store of a single-file wiki. */
    private fun modifyStore(html: String, add: List<JSONObject>, removeTitles: Set<String>): String {
        val m = Regex("(<script[^>]*class=\"tiddlywiki-tiddler-store\"[^>]*>)([\\s\\S]*?)(</script>)")
            .findAll(html).lastOrNull() ?: error("no tiddler store found (older div-store wikis aren't supported)")
        val arr = JSONArray(m.groupValues[2].trim())
        val addTitles = add.map { it.optString("title") }.toSet()
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: continue
            val title = t.optString("title")
            if (title in removeTitles || title in addTitles) continue // replaced below
            kept.put(t)
        }
        add.forEach { kept.put(it) }
        // Escape "<" so a tiddler containing "</script>" can't break the store's script tag.
        val serialized = kept.toString().replace("<", "\\u003c")
        return html.substring(0, m.range.first) + m.groupValues[1] + serialized +
            m.groupValues[3] + html.substring(m.range.last + 1)
    }

    private fun editInfoArrays(info: JSONObject, install: JSONArray, remove: JSONArray) {
        for (i in 0 until install.length()) {
            val it = install.getJSONObject(i)
            addName(info, arrayKey(it.optString("plugin-type", "plugin")), it.optString("name"))
        }
        for (i in 0 until remove.length()) {
            val title = remove.getString(i)
            val (key, name) = titleToArray(title) ?: continue
            removeName(info, key, name)
        }
    }

    private fun arrayKey(pluginType: String) = when (pluginType) {
        "theme" -> "themes"; "language" -> "languages"; else -> "plugins"
    }

    private fun titleToArray(title: String): Pair<String, String>? = when {
        title.startsWith("\$:/plugins/") -> "plugins" to title.removePrefix("\$:/plugins/")
        title.startsWith("\$:/themes/") -> "themes" to title.removePrefix("\$:/themes/")
        title.startsWith("\$:/languages/") -> "languages" to title.removePrefix("\$:/languages/")
        else -> null
    }

    private fun addName(info: JSONObject, key: String, name: String) {
        if (name.isBlank()) return
        val arr = info.optJSONArray(key) ?: JSONArray().also { info.put(key, it) }
        for (i in 0 until arr.length()) if (arr.getString(i) == name) return
        arr.put(name)
    }

    private fun removeName(info: JSONObject, key: String, name: String) {
        val arr = info.optJSONArray(key) ?: return
        val kept = JSONArray()
        for (i in 0 until arr.length()) if (arr.getString(i) != name) kept.put(arr.getString(i))
        info.put(key, kept)
    }

    // ── io helpers (content:// vs file) ───────────────────────────────────────────

    private fun storeArray(html: String): JSONArray? {
        val m = Regex("<script[^>]*class=\"tiddlywiki-tiddler-store\"[^>]*>([\\s\\S]*?)</script>").find(html)
            ?: return null
        return runCatching { JSONArray(m.groupValues[1].trim()) }.getOrNull()
    }

    private fun readText(path: String): String? = readBytes(path)?.toString(Charsets.UTF_8)

    private fun readBytes(path: String): ByteArray? = runCatching {
        if (path.startsWith("content://"))
            context.contentResolver.openInputStream(Uri.parse(path))?.use { it.readBytes() }
        else File(path).readBytes()
    }.getOrNull()

    private fun writeBytes(path: String, bytes: ByteArray) {
        if (path.startsWith("content://"))
            context.contentResolver.openOutputStream(Uri.parse(path), "wt")?.use { it.write(bytes) }
        else File(path).writeBytes(bytes)
    }

    private fun readInfo(folderPath: String): String? {
        if (!folderPath.startsWith("content://")) {
            val f = File(folderPath, "tiddlywiki.info")
            return if (f.exists()) f.readText() else null
        }
        val root = DocumentFile.fromTreeUri(context, Uri.parse(folderPath)) ?: return null
        val info = root.findFile("tiddlywiki.info") ?: return null
        return context.contentResolver.openInputStream(info.uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    private fun writeInfo(folderPath: String, text: String) {
        if (!folderPath.startsWith("content://")) {
            File(folderPath, "tiddlywiki.info").writeText(text); return
        }
        val root = DocumentFile.fromTreeUri(context, Uri.parse(folderPath)) ?: error("no tree")
        // Create with a neutral MIME type, not application/json: SAF would otherwise append the
        // type's extension and produce "tiddlywiki.info.json", leaving the folder without a
        // usable tiddlywiki.info. Rename back if the provider still altered the name.
        val info = root.findFile("tiddlywiki.info")
            ?: (root.createFile("application/octet-stream", "tiddlywiki.info")
                ?: error("cannot create tiddlywiki.info")).also {
                if (it.name != "tiddlywiki.info") runCatching { it.renameTo("tiddlywiki.info") }
            }
        context.contentResolver.openOutputStream(info.uri, "wt")?.use { it.write(text.toByteArray()) }
    }

    companion object {
        private const val TAG = "PluginBridge"
        const val INTERFACE_NAME = "TDPlugins"
    }
}
