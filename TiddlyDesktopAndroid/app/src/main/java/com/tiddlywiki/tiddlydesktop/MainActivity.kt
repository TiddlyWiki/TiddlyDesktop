package com.tiddlywiki.tiddlydesktop

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.tiddlywiki.tiddlydesktop.host.MetaBridge
import com.tiddlywiki.tiddlydesktop.host.SystemBarsBridge
import com.tiddlywiki.tiddlydesktop.host.TDHost
import com.tiddlywiki.tiddlydesktop.host.WikiLauncher
import com.tiddlywiki.tiddlydesktop.host.WikiUrl
import com.tiddlywiki.tiddlydesktop.node.NodeEnvironment
import com.tiddlywiki.tiddlydesktop.node.NodeServer
import com.tiddlywiki.tiddlydesktop.node.WikiMeta
import com.tiddlywiki.tiddlydesktop.node.WikiOps
import org.json.JSONObject

/**
 * Landing page host. Serves the classic `plugins/tiddlydesktop` WikiList as a Node.js
 * folder wiki and shows it full-screen. The WikiList persists its own wiki tiddlers (it's
 * node-served) and drives everything through `window.TDHost` ([TDHost]); this activity is
 * the native side of that bridge.
 */
class MainActivity : ComponentActivity(), TDHost.Callbacks {

    private lateinit var webView: WebView
    private var wikiListServer: NodeServer? = null
    private val pluginBridge by lazy { com.tiddlywiki.tiddlydesktop.node.PluginBridge(this) }
    /** Shared content (a JSON tiddler array) awaiting the user picking a target wiki. */
    private var pendingSharePayload: String? = null
    /** Enriched metadata for the pending share (JSON: kind/title/description/image/embed/…). */
    @Volatile private var enrichedShareData: String = "{}"

    // ACTION_OPEN_DOCUMENT grants read-only by default; single-file wikis must be writable
    // to save, so request write + persistable access.
    private class OpenWritableDocument : ActivityResultContracts.OpenDocument() {
        override fun createIntent(context: Context, input: Array<String>): Intent =
            super.createIntent(context, input).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
    }

    // SAF pickers, registered before onStart. Persist permission so the wiki reopens later.
    private var pendingWikiFile: Uri? = null
    private val pickFile = registerForActivityResult(
        OpenWritableDocument()
    ) { uri ->
        uri?.let {
            persistPermission(it)
            // Also ask for the containing folder so backups can live next to the wiki and
            // "Reveal" works. Hint the picker at the file's location.
            pendingWikiFile = it
            pickWikiFolder.launch(it)
        }
    }

    private val pickWikiFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { treeUri ->
        val file = pendingWikiFile ?: return@registerForActivityResult
        pendingWikiFile = null
        if (treeUri == null) {
            // Folder access is required (backups + attachments live there) — abort the add.
            toast(R.string.toast_folder_required_not_added)
            return@registerForActivityResult
        }
        persistPermission(treeUri)
        registerAndOpenWiki(file, isFolder = false, folderUri = treeUri.toString())
    }

    private val pickFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri -> uri?.let { onWikiPicked(it, isFolder = true) } }

    // Re-grant SAF access before opening a wiki whose persisted permission was lost (e.g. after
    // a reinstall, or restoring the wiki list from a config folder).
    private data class PendingOpen(
        val url: String, val title: String, val isFolder: Boolean,
        val backupsEnabled: Boolean, val backupCount: Int, val backupDir: String, val path: String,
        val sharePayload: String? = null
    )
    private var pendingOpen: PendingOpen? = null

    private val regrantWikiFile = registerForActivityResult(OpenWritableDocument()) { uri ->
        val req = pendingOpen ?: return@registerForActivityResult
        if (uri == null) { pendingOpen = null; toast(R.string.toast_access_not_granted); return@registerForActivityResult }
        persistPermission(uri)
        if (uri.toString() == req.path) {
            ensureAccessAndOpen(req) // essential granted — check the folder next
        } else {
            pendingOpen = null // re-linked to a different file: update the entry + open it
            val newUrl = WikiUrl.encode(uri.toString(), false)
            val newPath = readablePath(uri, false)
            webView.evaluateJavascript(
                "window.__tdRelinkWiki && window.__tdRelinkWiki(${q(req.url)},${q(newUrl)},false,${q(req.title)},${q(newPath)});", null)
        }
    }

    private val regrantWikiFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { treeUri ->
        val req = pendingOpen ?: return@registerForActivityResult
        if (treeUri == null) {
            pendingOpen = null
            if (req.isFolder) toast(R.string.toast_access_not_granted)
            else WikiLauncher.open(this, req.path, req.title, false, req.backupsEnabled, req.backupCount, req.backupDir, req.sharePayload)
            return@registerForActivityResult
        }
        persistPermission(treeUri)
        if (req.isFolder) {
            if (treeUri.toString() == req.path) ensureAccessAndOpen(req)
            else {
                pendingOpen = null
                val newUrl = WikiUrl.encode(treeUri.toString(), true)
                val newPath = readablePath(treeUri, true)
                webView.evaluateJavascript(
                    "window.__tdRelinkWiki && window.__tdRelinkWiki(${q(req.url)},${q(newUrl)},true,${q(req.title)},${q(newPath)});", null)
            }
        } else {
            // Single-file: this tree is the containing folder (backups + attachments).
            webView.evaluateJavascript(
                "window.__tdSetWikiFolder && window.__tdSetWikiFolder(${q(req.url)},${q(treeUri.toString())});", null)
            pendingOpen = null
            WikiLauncher.open(this, req.path, req.title, false, req.backupsEnabled, req.backupCount, treeUri.toString(), req.sharePayload)
        }
    }

    // Destination pickers for create/convert/clone. The pending op is run once a dest is picked.
    private data class PendingOp(val type: String, val source: String, val destIsFolder: Boolean)
    private var pendingOp: PendingOp? = null

    private val createDoc = registerForActivityResult(
        ActivityResultContracts.CreateDocument("text/html")
    ) { uri -> uri?.let { onDestPicked(it) } }

    private val pickDestFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri -> uri?.let { onDestPicked(it) } }

    private val pickPluginFolderLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri -> uri?.let { onPluginFolderPicked(it) } }

    private val pickConfigFolderLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri -> uri?.let { onConfigFolderPicked(it) } }

    private val pickBackupFolderLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri -> uri?.let { onBackupFolderPicked(it) } }

    // A freshly-created single-file wiki whose containing folder we're asking the user to grant
    // (CreateDocument only grants the file; backups + attachments live in the folder).
    private var pendingNewWiki: Uri? = null
    private val newWikiFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { treeUri ->
        val dest = pendingNewWiki ?: return@registerForActivityResult
        pendingNewWiki = null
        val folder = if (treeUri != null) { persistPermission(treeUri); treeUri.toString() } else ""
        registerAndOpenWiki(dest, isFolder = false, folderUri = folder)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            }
            addJavascriptInterface(TDHost(this@MainActivity), TDHost.INTERFACE_NAME)
            addJavascriptInterface(pluginBridge, com.tiddlywiki.tiddlydesktop.node.PluginBridge.INTERFACE_NAME)
        }
        val root = FrameLayout(this).apply { addView(webView) }
        applySystemBarInsets(root)
        webView.addJavascriptInterface(SystemBarsBridge(this, root), SystemBarsBridge.INTERFACE_NAME)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                injectAsset(view, SystemBarsBridge.SCRIPT_ASSET)
            }
        }
        webView.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) {
                val t = title?.takeIf { it.isNotBlank() } ?: return
                setTitle(t)
                runCatching { setTaskDescription(android.app.ActivityManager.TaskDescription(t)) }
            }
        }
        setContentView(root)

        // Live metadata pushed from open wiki windows (:wiki process) via broadcast.
        val filter = IntentFilter(MetaBridge.ACTION_WIKI_META)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(metaReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(metaReceiver, filter)
        }

        // Back returns to the WikiList when a backstage/settings/help view is showing,
        // otherwise closes the app.
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val js = "(function(){try{if(window.\$tw && \$tw.wiki.getTiddlerText('\$:/temp/td-view','')){" +
                    "\$tw.wiki.deleteTiddler('\$:/temp/td-view');return 'handled';}}catch(e){}return 'no';})();"
                webView.evaluateJavascript(js) { result ->
                    if (result == null || !result.contains("handled")) {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })

        // The foreground service keeps the :wiki process (open wikis) alive; the WikiList runs in
        // the main process as a normal foreground activity and doesn't need it. Managing it from
        // here also mis-fires: activeCount is per-process, so starting the :wiki service from the
        // main process finds count 0 there and crashed on Android 14+.

        Thread {
            // Guard the entire boot: an uncaught exception in this thread (e.g. a transient
            // extraction/Node startup error on reopen) would crash the whole app.
            runCatching {
                NodeEnvironment.ensureResourcesExtracted(this)
                NodeEnvironment.ensureWikiListExtracted(this)
                NodeEnvironment.verifyNodeBinary(this)?.let { Log.e(TAG, it) }

                val server = NodeServer(this, NodeEnvironment.wikiListDir(this))
                wikiListServer = server
                val url = server.start()
                runOnUiThread { runCatching { webView.loadUrl(url) } }
                // Warm the plugin-library enumeration cache so the PluginChooser opens instantly.
                pluginBridge.listAvailable()
            }.onFailure { Log.e(TAG, "WikiList boot failed: ${it.message}", it) }
        }.apply { isDaemon = true; start() }

        // A share that launched us cold: stash the payload; android-desktop.js pulls it via
        // host.hasPendingShare() once the WikiList is ready.
        handleShareIntent(intent, notify = false)
    }

    // ── TDHost.Callbacks ─────────────────────────────────────────────────────────

    override fun pickSingleFileWiki() = runOnUiThread {
        pickFile.launch(arrayOf("text/html", "application/xhtml+xml", "*/*"))
    }

    override fun pickFolderWiki() = runOnUiThread { pickFolder.launch(null) }

    override fun openWikiUrl(url: String, title: String, isFolder: Boolean, backupsEnabled: Boolean, backupCount: Int, backupDir: String) = runOnUiThread {
        val decoded = WikiUrl.decode(url) ?: return@runOnUiThread
        ensureAccessAndOpen(PendingOpen(url, title, decoded.isFolder, backupsEnabled, backupCount, backupDir, decoded.path))
    }

    /** Whether we still hold a persisted SAF grant for [uriStr] (non-content:// paths need none). */
    private fun hasAccess(uriStr: String, needWrite: Boolean): Boolean {
        if (!uriStr.startsWith("content://")) return true
        val uri = runCatching { Uri.parse(uriStr) }.getOrNull() ?: return false
        return contentResolver.persistedUriPermissions.any {
            it.uri == uri && it.isReadPermission && (!needWrite || it.isWritePermission)
        }
    }

    /** Verify file + folder access before opening; prompt to re-grant whatever is missing. */
    private fun ensureAccessAndOpen(req: PendingOpen) {
        // 1. Essential: the wiki itself (the file for single-file, the tree for folder wikis).
        if (!hasAccess(req.path, needWrite = true)) {
            pendingOpen = req
            toast(R.string.toast_regrant_wiki)
            if (req.isFolder) regrantWikiFolder.launch(runCatching { Uri.parse(req.path) }.getOrNull())
            else regrantWikiFile.launch(arrayOf("text/html", "application/xhtml+xml", "*/*"))
            return
        }
        // 2. Single-file: also ensure the containing folder (backups + attachments live there).
        if (!req.isFolder && req.backupDir.isNotBlank() && !hasAccess(req.backupDir, needWrite = true)) {
            pendingOpen = req
            toast(R.string.toast_regrant_folder)
            regrantWikiFolder.launch(runCatching { Uri.parse(req.path) }.getOrNull())
            return
        }
        pendingOpen = null
        WikiLauncher.open(this, req.path, req.title, req.isFolder, req.backupsEnabled, req.backupCount, req.backupDir, req.sharePayload)
    }

    override fun openExternal(url: String) = runOnUiThread {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    // ── picker result handling ───────────────────────────────────────────────────

    private fun onWikiPicked(uri: Uri, isFolder: Boolean) {
        persistPermission(uri)
        registerAndOpenWiki(uri, isFolder)
    }

    private fun persistPermission(uri: Uri) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { contentResolver.takePersistableUriPermission(uri, flags) }
    }

    /** Register a wiki as a tiddler in the (node-served, persisted) WikiList, then open it. */
    private fun registerAndOpenWiki(uri: Uri, isFolder: Boolean, folderUri: String = "") {
        val url = WikiUrl.encode(uri.toString(), isFolder)
        val title = displayName(uri, isFolder)
        val readablePath = readablePath(uri, isFolder)
        val js = "window.__tdAddWiki && window.__tdAddWiki(" +
            "${q(url)},${q(title)},\"\",${isFolder},${q(readablePath)},${q(folderUri)});"
        // Register with the filename first, then fill in live SiteTitle/subtitle/favicon.
        webView.post { webView.evaluateJavascript(js) { refreshMeta(url) } }
    }

    override fun refreshWikiMeta(url: String) = refreshMeta(url)

    override fun pickPluginFolder() = runOnUiThread { pickPluginFolderLauncher.launch(null) }

    // ── config folder (persistent settings) ─────────────────────────────────────────

    private val configFolderUriFile get() = java.io.File(filesDir, "config-folder.uri")
    private fun configFolderUri(): String? =
        configFolderUriFile.takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }
    private fun configTree(): androidx.documentfile.provider.DocumentFile? =
        configFolderUri()?.let { androidx.documentfile.provider.DocumentFile.fromTreeUri(this, Uri.parse(it)) }

    override fun pickConfigFolder() = runOnUiThread { pickConfigFolderLauncher.launch(null) }

    private fun onConfigFolderPicked(uri: Uri) {
        persistPermission(uri)
        configFolderUriFile.writeText(uri.toString())
        val display = readablePath(uri, isFolder = true)
        webView.evaluateJavascript(
            "window.__tdSetConfigPath && window.__tdSetConfigPath(${q(display)});" +
                "window.__tdConfigFolderPicked && window.__tdConfigFolderPicked();", null
        )
        toast(R.string.toast_config_folder_set)
    }

    override fun exportSettings(json: String) {
        Thread {
            runCatching {
                val root = configTree() ?: return@runCatching
                val f = root.findFile(SETTINGS_FILE)
                    ?: root.createFile("application/json", SETTINGS_FILE) ?: return@runCatching
                contentResolver.openOutputStream(f.uri, "wt")?.use { it.write(json.toByteArray()) }
            }.onFailure { Log.w(TAG, "exportSettings failed: ${it.message}") }
        }.apply { isDaemon = true; start() }
    }

    override fun readConfigJson(): String = runCatching {
        val f = configTree()?.findFile(SETTINGS_FILE) ?: return ""
        contentResolver.openInputStream(f.uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
    }.getOrElse { "" }

    override fun saveWikiList(json: String) =
        com.tiddlywiki.tiddlydesktop.host.WikiListStore.save(this, json)

    override fun configFolderPath(): String =
        configFolderUri()?.let { runCatching { readablePath(Uri.parse(it), isFolder = true) }.getOrDefault("") } ?: ""

    override fun openConfigFolder() = runOnUiThread {
        configFolderUri()?.let { openTree(it) } ?: toast(R.string.toast_no_config_folder)
    }

    // ── global backup folder ─────────────────────────────────────────────────────────

    private fun backupFolderUri(): String? = com.tiddlywiki.tiddlydesktop.node.Backups
        .backupFolderUriFile(this).takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }

    override fun pickBackupFolder() = runOnUiThread { pickBackupFolderLauncher.launch(null) }

    private fun onBackupFolderPicked(uri: Uri) {
        persistPermission(uri)
        com.tiddlywiki.tiddlydesktop.node.Backups.backupFolderUriFile(this).writeText(uri.toString())
        val display = readablePath(uri, isFolder = true)
        webView.evaluateJavascript("window.__tdSetBackupPath && window.__tdSetBackupPath(${q(display)});", null)
        toast(R.string.toast_backup_folder_set)
    }

    override fun backupFolderPath(): String =
        backupFolderUri()?.let { runCatching { readablePath(Uri.parse(it), isFolder = true) }.getOrDefault("") } ?: ""

    override fun openBackupFolder() = runOnUiThread {
        backupFolderUri()?.let { openTree(it) } ?: toast(R.string.toast_no_backup_folder)
    }

    private fun onPluginFolderPicked(uri: Uri) {
        persistPermission(uri)
        val display = readablePath(uri, isFolder = true)
        toast(R.string.toast_importing_plugins)
        Thread {
            val ok = com.tiddlywiki.tiddlydesktop.node.SafMirror
                .importTreeTo(this, uri.toString(), NodeEnvironment.customPluginsDir(this))
            pluginBridge.invalidateCache()
            runCatching { pluginBridge.listAvailable() } // re-warm
            runOnUiThread {
                if (ok) {
                    webView.evaluateJavascript(
                        "window.__tdSetPluginPath && window.__tdSetPluginPath(${q(display)});", null
                    )
                    toast(R.string.toast_custom_plugin_folder_set)
                } else toast(R.string.toast_import_folder_failed)
            }
        }.apply { isDaemon = true; start() }
    }

    override fun revealFolder(treeUri: String) = runOnUiThread {
        if (treeUri.isBlank()) {
            toast(R.string.toast_no_folder_access_reveal)
            return@runOnUiThread
        }
        openTree(treeUri)
    }

    /** Open a SAF *tree* URI in the file manager (as its root document, not the raw tree URI). */
    private fun openTree(treeUri: String) {
        val tree = Uri.parse(treeUri)
        val docUri = runCatching {
            DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        }.getOrNull() ?: tree
        openDirectory(docUri)
    }

    override fun revealBackups(treeUri: String, url: String) = runOnUiThread {
        if (treeUri.isBlank()) {
            toast(R.string.toast_no_folder_access_reveal)
            return@runOnUiThread
        }
        val path = WikiUrl.decode(url)?.path
        val fileName = path?.let { Uri.parse(it).lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':') }
            ?: "wiki.html"
        val backups = runCatching {
            androidx.documentfile.provider.DocumentFile.fromTreeUri(this, Uri.parse(treeUri))
                ?.findFile(com.tiddlywiki.tiddlydesktop.node.Backups.backupDirName(fileName))
        }.getOrNull()
        if (backups != null) openDirectory(backups.uri) else revealFolder(treeUri)
    }

    private fun openDirectory(dirUri: Uri) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(dirUri, DocumentsContract.Document.MIME_TYPE_DIR)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }.onFailure { toast(R.string.toast_open_folder_failed) }
    }

    // Last seen modification time per wiki, so we only re-parse files that actually changed.
    private val metaMtimes = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** Extract SiteTitle/SiteSubtitle/favicon from the wiki content and push it to the row. */
    private fun refreshMeta(url: String) {
        val decoded = WikiUrl.decode(url) ?: return
        Thread {
            // Cheap guard: skip the (potentially large) file read+parse when the wiki hasn't
            // changed since we last scanned it. lastModified() is a light metadata query.
            val mtime = lastModifiedOf(decoded.path, decoded.isFolder)
            if (mtime > 0L && metaMtimes[url] == mtime) return@Thread

            val m = WikiMeta.extract(this, decoded.path, decoded.isFolder)
            if (mtime > 0L) metaMtimes[url] = mtime
            val js = "window.__tdSetWikiMeta && window.__tdSetWikiMeta(" +
                "${q(url)},${q(m.title)},${q(m.subtitle)},${q(m.favicon)},${m.isClassic});"
            runOnUiThread { webView.evaluateJavascript(js, null) }
        }.apply { isDaemon = true; start() }
    }

    private fun lastModifiedOf(path: String, isFolder: Boolean): Long = runCatching {
        if (path.startsWith("content://")) {
            val uri = Uri.parse(path)
            val df = if (isFolder) androidx.documentfile.provider.DocumentFile.fromTreeUri(this, uri)
            else androidx.documentfile.provider.DocumentFile.fromSingleUri(this, uri)
            df?.lastModified() ?: 0L
        } else {
            java.io.File(path).lastModified()
        }
    }.getOrDefault(0L)

    // ── create / convert / clone (TDHost.Callbacks) ──────────────────────────────

    override fun cloneWiki(source: String) = runOnUiThread {
        when {
            source.startsWith("http") -> {
                pendingOp = PendingOp("clone-url", source, false); createDoc.launch("wiki.html")
            }
            source.startsWith("wikifile://") -> {
                val d = WikiUrl.decode(source) ?: return@runOnUiThread
                pendingOp = PendingOp("clone-file", d.path, false); createDoc.launch(suggestName(d.path))
            }
            source.startsWith("wikifolder://") -> {
                val d = WikiUrl.decode(source) ?: return@runOnUiThread
                pendingOp = PendingOp("clone-folder", d.path, true); pickDestFolder.launch(null)
            }
        }
    }

    override fun convertWiki(sourceUrl: String) = runOnUiThread {
        val d = WikiUrl.decode(sourceUrl) ?: return@runOnUiThread
        if (d.isFolder) {
            pendingOp = PendingOp("convert-folder2file", d.path, false); createDoc.launch(suggestName(d.path))
        } else {
            pendingOp = PendingOp("convert-file2folder", d.path, true); pickDestFolder.launch(null)
        }
    }

    private fun onDestPicked(dest: Uri) {
        val op = pendingOp ?: return
        pendingOp = null
        persistPermission(dest)
        toast(R.string.toast_working)
        Thread {
            val ok = when (op.type) {
                "clone-url" -> WikiOps.cloneFromUrl(this, op.source, dest.toString())
                "clone-file" -> WikiOps.cloneFile(this, op.source, dest.toString())
                "clone-folder" -> WikiOps.cloneFolder(this, op.source, dest.toString())
                "convert-file2folder" -> WikiOps.fileToFolder(this, op.source, dest.toString())
                "convert-folder2file" -> WikiOps.folderToFile(this, op.source, dest.toString())
                else -> false
            }
            runOnUiThread {
                when {
                    !ok -> toast(R.string.toast_operation_failed)
                    // Folder wiki: the picked tree already grants folder access.
                    op.destIsFolder -> registerAndOpenWiki(dest, isFolder = true)
                    // New single-file wiki: also ask for its containing folder now (backups +
                    // attachments live there), so opening it doesn't prompt a re-grant later.
                    else -> {
                        pendingNewWiki = dest
                        toast(R.string.toast_regrant_folder)
                        newWikiFolder.launch(null)
                    }
                }
            }
        }.apply { isDaemon = true; start() }
    }

    private fun suggestName(path: String): String {
        val base = Uri.parse(path).lastPathSegment
            ?.substringAfterLast('/')?.substringAfterLast(':')?.substringBeforeLast('.')
            ?.takeIf { it.isNotBlank() } ?: "wiki"
        return "$base.html"
    }

    private fun toast(msg: String) =
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    private fun toast(resId: Int) = toast(getString(resId))

    /** A human-readable location from a SAF URI, e.g. "Internal storage/Docs/wiki.html". */
    private fun readablePath(uri: Uri, isFolder: Boolean): String {
        val docId = runCatching {
            if (isFolder) DocumentsContract.getTreeDocumentId(uri)
            else DocumentsContract.getDocumentId(uri)
        }.getOrNull() ?: return uri.toString()
        val parts = docId.split(":", limit = 2)
        // A "raw:" document ID is already an absolute filesystem path (raw:/storage/emulated/0/…) —
        // return it as-is, not "raw//storage/…".
        if (parts[0] == "raw") return parts.getOrElse(1) { docId }
        val volName = if (parts[0] == "primary") "Internal storage" else parts[0]
        val rel = parts.getOrElse(1) { "" }
        return if (rel.isEmpty()) volName else "$volName/$rel"
    }

    private fun displayName(uri: Uri, isFolder: Boolean): String {
        if (isFolder) {
            val docId = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()
            docId?.substringAfterLast('/')?.substringAfterLast(':')
                ?.takeIf { it.isNotBlank() }?.let { return it }
        }
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) c.getString(idx)?.let { return it.substringBeforeLast('.') }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "Wiki"
    }

    /** JSON-encode for safe splicing into an evaluateJavascript literal. */
    private fun q(s: String): String = JSONObject.quote(s)

    private fun injectAsset(view: WebView, assetPath: String) {
        val js = runCatching {
            assets.open(assetPath).bufferedReader().use { it.readText() }
        }.getOrNull() ?: return
        view.evaluateJavascript(js, null)
    }

    /** Pad the content below/around the system bars (Android 15+ enforces edge-to-edge). */
    private fun applySystemBarInsets(view: android.view.View) {
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    /** Receives live metadata from open wiki windows and updates the corresponding row. */
    private val metaReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val url = intent.getStringExtra("url") ?: return
            val title = intent.getStringExtra("title") ?: ""
            val subtitle = intent.getStringExtra("subtitle") ?: ""
            val favicon = intent.getStringExtra("favicon") ?: ""
            val js = "window.__tdSetWikiMeta && window.__tdSetWikiMeta(" +
                "${q(url)},${q(title)},${q(subtitle)},${q(favicon)});"
            webView.post { webView.evaluateJavascript(js, null) }
        }
    }

    override fun onResume() {
        super.onResume()
        // Returning to the WikiList (e.g. after editing a wiki): re-extract titles/favicons
        // so rows reflect the latest content. No-op until the page has loaded.
        if (this::webView.isInitialized) {
            webView.evaluateJavascript("window.__tdRefreshAllMeta && window.__tdRefreshAllMeta();", null)
            // Re-read the plugin library + re-scan update badges, so a changed library (app update,
            // custom plugin folder edit) reflects on the Plugins buttons without a manual re-scan.
            webView.evaluateJavascript("window.__tdRescanPlugins && window.__tdRescanPlugins();", null)
        }
    }

    // ── share TO wiki (ACTION_SEND) ──────────────────────────────────────────────────

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent, notify = true)
    }

    /**
     * Handle a share/open intent. Files → a native (base64/.tid) payload used verbatim. Text/URL →
     * a basic fallback payload plus async enrichment (ShareEnricher) that the WikiList reads via
     * getShareData() to render a share template. On fresh launch JS pulls it via hasPendingShare().
     */
    private fun handleShareIntent(intent: Intent?, notify: Boolean) {
        intent ?: return
        val action = intent.action
        val isSend = action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE
        val isView = action == Intent.ACTION_VIEW && intent.data != null
        if (!isSend && !isView) return

        val filePayload = runCatching { buildFilePayload(intent, action) }.getOrNull()
        if (!filePayload.isNullOrBlank()) {
            pendingSharePayload = filePayload
            enrichedShareData = org.json.JSONObject().put("kind", "file").toString()
        } else {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            if (text.isBlank()) { intent.action = null; toast(R.string.toast_nothing_to_share); return }
            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.let { sanitizeShareTitle(it) } ?: ""
            val title = subject.ifBlank { deriveShareTitle(text) }
            // Fallback (used if enrichment fails / JS returns empty): a plain note/link tiddler.
            pendingSharePayload = org.json.JSONArray().put(
                org.json.JSONObject().put("title", title).put("text", text).put("tags", "shared")
            ).toString()
            enrichedShareData = org.json.JSONObject().put("kind", "text").put("url", "")
                .put("title", title).put("text", text).toString()
            // Enrich asynchronously; refresh the picker preview when done.
            Thread {
                val enriched = com.tiddlywiki.tiddlydesktop.node.ShareEnricher.enrich(text)
                if (subject.isNotBlank()) enriched.put("title", subject) // honour an explicit subject
                enrichedShareData = enriched.toString()
                runOnUiThread {
                    if (this::webView.isInitialized) webView.evaluateJavascript("window.__tdShareEnriched && window.__tdShareEnriched();", null)
                }
            }.apply { isDaemon = true; start() }
        }
        intent.action = null // don't re-handle on rotation/resume
        if (notify && this::webView.isInitialized) {
            webView.evaluateJavascript("window.__tdBeginShare && window.__tdBeginShare();", null)
        }
    }

    /** Build a payload from shared/opened files (base64, or raw text for .tid); null if none. */
    private fun buildFilePayload(intent: Intent, action: String?): String? {
        val uris = when (action) {
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: arrayListOf()
            Intent.ACTION_VIEW -> intent.data?.let { arrayListOf(it) } ?: arrayListOf()
            else -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { arrayListOf(it) } ?: arrayListOf()
        }
        val arr = org.json.JSONArray()
        for (uri in uris) {
            runCatching {
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching
                val name = androidx.documentfile.provider.DocumentFile.fromSingleUri(this, uri)?.name ?: uri.lastPathSegment ?: ""
                if (name.endsWith(".tid", true) || uri.toString().endsWith(".tid", true)) {
                    arr.put(org.json.JSONObject().put("__tid", String(bytes, Charsets.UTF_8)))
                } else {
                    arr.put(org.json.JSONObject()
                        .put("title", sanitizeShareTitle(name).ifBlank { "shared-${System.currentTimeMillis()}" })
                        .put("type", contentResolver.getType(uri) ?: "application/octet-stream")
                        .put("text", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                        .put("tags", "shared"))
                }
            }
        }
        return if (arr.length() > 0) arr.toString() else null
    }

    private fun deriveShareTitle(text: String): String {
        val first = text.trim().lineSequence().firstOrNull()?.trim().orEmpty()
        return (if (first.length > 60) first.take(57) + "…" else first)
            .ifBlank { "Shared " + java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(java.util.Date()) }
    }

    private fun sanitizeShareTitle(raw: String): String =
        raw.replace(Regex("[\\u0000-\\u001F\\u007F]"), "").replace(Regex("\\s+"), " ").trim()

    override fun hasPendingShare(): Boolean = pendingSharePayload != null
    override fun getShareData(): String = enrichedShareData

    override fun shareToWiki(url: String, title: String, isFolder: Boolean, backupsEnabled: Boolean, backupCount: Int, backupDir: String, tiddlersJson: String) = runOnUiThread {
        val payload = tiddlersJson.ifBlank { pendingSharePayload } ?: return@runOnUiThread
        pendingSharePayload = null; enrichedShareData = "{}"
        val decoded = WikiUrl.decode(url) ?: return@runOnUiThread
        // Queue as a file (not an Intent extra) so large payloads don't crash the launch and an
        // already-open wiki can pick it up on resume; then open / bring the wiki to front.
        com.tiddlywiki.tiddlydesktop.node.ShareQueue.enqueue(this, decoded.path, payload)
        ensureAccessAndOpen(PendingOpen(url, title.ifBlank { decoded.path }, decoded.isFolder, backupsEnabled, backupCount, backupDir, decoded.path))
    }

    override fun cancelShare() { pendingSharePayload = null; enrichedShareData = "{}" }

    override fun onDestroy() {
        runCatching { unregisterReceiver(metaReceiver) }
        if (isFinishing) {
            wikiListServer?.stop()
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MainActivity"
        private const val SETTINGS_FILE = "tiddlydesktop-settings.json"
    }
}
