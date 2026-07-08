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
import android.provider.Settings
import java.io.File
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
    private val pickFile = registerForActivityResult(
        OpenWritableDocument()
    ) { uri -> uri?.let { onSingleFilePicked(it) } }

    private val pickFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri -> uri?.let { onFolderWikiPicked(it) } }

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
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val u = request.url.toString()
                // Keep the loopback-served WikiList in-app; open any external link (e.g. the
                // Support / Open Collective link) in the system browser rather than letting it
                // navigate — and replace — the WikiList webview.
                if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) return false
                openExternal(u)
                return true
            }
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

        // Ask for POST_NOTIFICATIONS up front so the persistent keep-alive notification is visible.
        ensureNotificationPermission()
        // Direct-path wiki access needs All-Files-Access; prompt (with a link to Settings) if missing.
        ensureStorageAccess()

        Thread {
            // Guard the entire boot: an uncaught exception in this thread (e.g. a transient
            // extraction/Node startup error on reopen) would crash the whole app.
            runCatching {
                NodeEnvironment.ensureResourcesExtracted(this)
                NodeEnvironment.ensureWikiListExtracted(this)
                NodeEnvironment.verifyNodeBinary(this)?.let { Log.e(TAG, it) }
                startWikiListServer()
                // Persistent foreground notification keeps THIS (main) process — and its WikiList
                // Node server on 127.0.0.1:38000 — alive in the background so it isn't reaped.
                WikiListForegroundService.start(this)
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

    /** Boot (or reboot) the WikiList Node server for the active language only, then load it. */
    private fun startWikiListServer() {
        NodeEnvironment.applyWikiListLanguage(this, NodeEnvironment.activeWikiListLanguage(this))
        // Fixed port so a language-switch reboot rebinds the SAME url (stable page).
        val server = NodeServer(this, NodeEnvironment.wikiListDir(this), port = WIKILIST_PORT)
        wikiListServer = server
        val url = server.start()
        runOnUiThread { runCatching { webView.loadUrl(url) } }
    }

    /**
     * Switch the WikiList language: only the active language is loaded, so a switch reboots the
     * server with the new one (and reloads the page). Rare action; runs off the UI thread.
     */
    override fun setLanguage(languageTitle: String) {
        val code = languageTitle.substringAfterLast("/").ifBlank { "en-GB" }
        if (code == NodeEnvironment.activeWikiListLanguage(this)) return
        // Tear down the current page first so its tiddlyweb syncer stops polling the server we're
        // about to kill (otherwise a poll mid-reboot surfaces a network error).
        runOnUiThread { runCatching { webView.loadUrl("about:blank") } }
        Thread {
            runCatching {
                wikiListServer?.stop()
                NodeEnvironment.setActiveWikiListLanguage(this, code)
                startWikiListServer()
            }.onFailure { Log.e(TAG, "language switch failed: ${it.message}", it) }
        }.apply { isDaemon = true; start() }
    }

    /**
     * Reboot the WikiList server and reload the page — used after installing/removing a plugin into
     * the WikiList itself (the backstage "Install plugins" flow), so the change actually boots.
     * Same teardown pattern as [setLanguage] (blank the page first so its syncer stops polling the
     * server we're about to kill).
     */
    override fun reloadWikiList() {
        runOnUiThread { runCatching { webView.loadUrl("about:blank") } }
        Thread {
            runCatching {
                wikiListServer?.stop()
                pluginBridge.invalidateCache()
                startWikiListServer()
            }.onFailure { Log.e(TAG, "wiki-list reload failed: ${it.message}", it) }
        }.apply { isDaemon = true; start() }
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

    private fun persistPermission(uri: Uri) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { contentResolver.takePersistableUriPermission(uri, flags) }
    }

    /** A folder wiki was picked: resolve to an absolute path (on-device only) and register it. */
    private fun onFolderWikiPicked(uri: Uri) {
        val path = com.tiddlywiki.tiddlydesktop.host.SafPaths.toFilePath(uri)
        if (path == null) { toast(R.string.toast_pick_on_device_folder); return }
        registerAndOpenWiki(path, isFolder = true)
    }

    /** A single-file wiki was picked: resolve to an absolute path; its folder is the parent dir. */
    private fun onSingleFilePicked(uri: Uri) {
        val path = com.tiddlywiki.tiddlydesktop.host.SafPaths.toFilePath(uri)
        if (path == null) { toast(R.string.toast_pick_on_device_file); return }
        registerAndOpenWiki(path, isFolder = false, folderPath = File(path).parent ?: "")
    }

    /**
     * Register a wiki as a tiddler in the (node-served, persisted) WikiList, then open it. [path]
     * is an absolute filesystem path; [folderPath] is the containing folder (backups + attachments)
     * for single-file wikis, defaulting to the wiki's own folder.
     */
    private fun registerAndOpenWiki(path: String, isFolder: Boolean, folderPath: String = "") {
        val url = WikiUrl.encode(path, isFolder)
        val name = File(path).name
        val title = (if (isFolder) name else name.substringBeforeLast('.')).ifBlank { "Wiki" }
        val folder = folderPath.ifBlank { if (isFolder) path else File(path).parent ?: "" }
        val js = "window.__tdAddWiki && window.__tdAddWiki(" +
            "${q(url)},${q(title)},\"\",${isFolder},${q(path)},${q(folder)});"
        // Register with the filename first, then fill in live SiteTitle/subtitle/favicon.
        webView.post { webView.evaluateJavascript(js) { refreshMeta(url) } }
    }

    override fun refreshWikiMeta(url: String) = refreshMeta(url)

    override fun pickPluginFolder() = runOnUiThread { pickPluginFolderLauncher.launch(null) }

    // ── config folder (persistent settings) ─────────────────────────────────────────

    // Holds an absolute folder path (was a content:// URI before direct-file access).
    private val configFolderUriFile get() = java.io.File(filesDir, "config-folder.uri")
    private fun configFolderPathOrNull(): String? =
        configFolderUriFile.takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }
    private fun configDir(): File? = configFolderPathOrNull()?.let { File(it) }

    override fun pickConfigFolder() = runOnUiThread { pickConfigFolderLauncher.launch(null) }

    private fun onConfigFolderPicked(uri: Uri) {
        val path = com.tiddlywiki.tiddlydesktop.host.SafPaths.toFilePath(uri)
        if (path == null) { toast(R.string.toast_pick_on_device_folder); return }
        configFolderUriFile.writeText(path)
        webView.evaluateJavascript(
            "window.__tdSetConfigPath && window.__tdSetConfigPath(${q(path)});" +
                "window.__tdConfigFolderPicked && window.__tdConfigFolderPicked();", null
        )
        toast(R.string.toast_config_folder_set)
    }

    override fun exportSettings(json: String) {
        Thread {
            runCatching {
                val dir = configDir()?.apply { mkdirs() } ?: return@runCatching
                File(dir, SETTINGS_FILE).writeText(json)
            }.onFailure { Log.w(TAG, "exportSettings failed: ${it.message}") }
        }.apply { isDaemon = true; start() }
    }

    override fun readConfigJson(): String = runCatching {
        val f = configDir()?.let { File(it, SETTINGS_FILE) } ?: return ""
        if (f.exists()) f.readText() else ""
    }.getOrElse { "" }

    override fun saveWikiList(json: String) =
        com.tiddlywiki.tiddlydesktop.host.WikiListStore.save(this, json)

    override fun configFolderPath(): String = configFolderPathOrNull() ?: ""

    override fun openConfigFolder() = runOnUiThread {
        configFolderPathOrNull()?.let { openPath(it) } ?: toast(R.string.toast_no_config_folder)
    }

    // ── global backup folder ─────────────────────────────────────────────────────────

    // Holds an absolute folder path (was a content:// URI before direct-file access).
    private fun backupFolderPathOrNull(): String? = com.tiddlywiki.tiddlydesktop.node.Backups
        .backupFolderUriFile(this).takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }

    override fun pickBackupFolder() = runOnUiThread { pickBackupFolderLauncher.launch(null) }

    private fun onBackupFolderPicked(uri: Uri) {
        val path = com.tiddlywiki.tiddlydesktop.host.SafPaths.toFilePath(uri)
        if (path == null) { toast(R.string.toast_pick_on_device_folder); return }
        com.tiddlywiki.tiddlydesktop.node.Backups.backupFolderUriFile(this).writeText(path)
        webView.evaluateJavascript("window.__tdSetBackupPath && window.__tdSetBackupPath(${q(path)});", null)
        toast(R.string.toast_backup_folder_set)
    }

    override fun backupFolderPath(): String = backupFolderPathOrNull() ?: ""

    override fun openBackupFolder() = runOnUiThread {
        backupFolderPathOrNull()?.let { openPath(it) } ?: toast(R.string.toast_no_backup_folder)
    }

    // The WikiList reports $:/TiddlyDesktop/BackupPath here (on load and on change). Persisted
    // app-wide so the :wiki-process saver and the PluginChooser lay backups out per the setting.
    override fun setBackupPathTemplate(template: String) {
        runCatching {
            com.tiddlywiki.tiddlydesktop.node.Backups.backupPathTemplateFile(this).writeText(template.trim())
        }
    }

    private fun onPluginFolderPicked(uri: Uri) {
        val path = com.tiddlywiki.tiddlydesktop.host.SafPaths.toFilePath(uri)
        if (path == null) { toast(R.string.toast_pick_on_device_folder); return }
        toast(R.string.toast_importing_plugins)
        Thread {
            val dest = NodeEnvironment.customPluginsDir(this)
            val ok = runCatching {
                if (dest.exists()) dest.deleteRecursively()
                dest.mkdirs()
                File(path).copyRecursively(dest, overwrite = true)
            }.getOrElse { Log.e(TAG, "plugin import failed: ${it.message}"); false }
            pluginBridge.invalidateCache()
            runCatching { pluginBridge.listAvailable() } // re-warm
            runOnUiThread {
                if (ok) {
                    webView.evaluateJavascript(
                        "window.__tdSetPluginPath && window.__tdSetPluginPath(${q(path)});", null
                    )
                    toast(R.string.toast_custom_plugin_folder_set)
                } else toast(R.string.toast_import_folder_failed)
            }
        }.apply { isDaemon = true; start() }
    }

    override fun revealFolder(treeUri: String) = runOnUiThread {
        if (treeUri.isBlank()) { toast(R.string.toast_no_folder_access_reveal); return@runOnUiThread }
        openPath(treeUri)
    }

    /**
     * Open a folder in the device file manager, revealing its contents. Tries, in order: a direct
     * ACTION_VIEW on the folder's external-storage document URI (respects a default file manager);
     * then the same via a chooser (surfaces any handler even when there's no default, and shows a
     * graceful "no apps" dialog otherwise); and finally a toast with the exact path so the user is
     * never left with nothing.
     */
    private fun openPath(path: String) {
        val docUri = com.tiddlywiki.tiddlydesktop.host.SafPaths.documentUri(path)
        if (docUri != null) {
            val view = Intent(Intent.ACTION_VIEW)
                .setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { startActivity(view); true }.getOrDefault(false)) return
            val chooser = Intent.createChooser(view, getString(R.string.reveal_chooser))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { startActivity(chooser); true }.getOrDefault(false)) return
        }
        toast(getString(R.string.reveal_path_hint, path))
    }

    override fun revealBackups(treeUri: String, url: String) = runOnUiThread {
        if (treeUri.isBlank()) { toast(R.string.toast_no_folder_access_reveal); return@runOnUiThread }
        val wikiPath = WikiUrl.decode(url)?.path
        val fileName = wikiPath?.let { File(it).name } ?: "wiki.html"
        val subPath = com.tiddlywiki.tiddlydesktop.node.Backups.backupSubPath(this, fileName, wikiPath ?: "")
        val backupDir = File(treeUri, subPath)
        if (backupDir.isDirectory) openPath(backupDir.absolutePath) else openPath(treeUri)
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
        val destPath = com.tiddlywiki.tiddlydesktop.host.SafPaths.toFilePath(dest)
        if (destPath == null) {
            toast(if (op.destIsFolder) R.string.toast_pick_on_device_folder else R.string.toast_pick_on_device_file)
            return
        }
        toast(R.string.toast_working)
        Thread {
            val ok = when (op.type) {
                "clone-url" -> WikiOps.cloneFromUrl(this, op.source, destPath)
                "clone-file" -> WikiOps.cloneFile(this, op.source, destPath)
                "clone-folder" -> WikiOps.cloneFolder(this, op.source, destPath)
                "convert-file2folder" -> WikiOps.fileToFolder(this, op.source, destPath)
                "convert-folder2file" -> WikiOps.folderToFile(this, op.source, destPath)
                else -> false
            }
            runOnUiThread {
                if (!ok) toast(R.string.toast_operation_failed)
                // Direct paths: the containing folder (backups + attachments) is just the parent dir.
                else registerAndOpenWiki(destPath, isFolder = op.destIsFolder)
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
        // Re-check All-Files-Access: the user grants it in Settings and returns here.
        ensureStorageAccess()
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

    /** Scratch dir for streamed share payloads (cleared per share). */
    private fun shareTempDir(): File = File(cacheDir, "shared").apply { mkdirs() }

    /**
     * Build a payload from shared/opened files. `.tid` files ride along as text; every other file is
     * STREAMED to a temp file (referenced by `__sharedFile`) rather than base64-encoded into the
     * payload — otherwise a shared video (tens/hundreds of MB) would OOM here. The wiki side
     * (share-import.js) then attaches it (streamed into attachments/) or embeds it, per the External
     * Attachments setting. Returns null if nothing usable was shared.
     */
    private fun buildFilePayload(intent: Intent, action: String?): String? {
        val uris = when (action) {
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: arrayListOf()
            Intent.ACTION_VIEW -> intent.data?.let { arrayListOf(it) } ?: arrayListOf()
            else -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { arrayListOf(it) } ?: arrayListOf()
        }
        if (uris.isEmpty()) return null
        // Drop temp files from a previous (possibly abandoned) share before staging new ones.
        runCatching { shareTempDir().listFiles()?.forEach { it.delete() } }
        val arr = org.json.JSONArray()
        for (uri in uris) {
            runCatching {
                val name = androidx.documentfile.provider.DocumentFile.fromSingleUri(this, uri)?.name ?: uri.lastPathSegment ?: ""
                val lower = name.ifBlank { uri.toString() }.lowercase()
                if (TIDDLER_CONTAINER_EXTS.any { lower.endsWith(it) }) {
                    // TiddlyWiki tiddler-container files (.tid/.json/.html/.csv/.multids/…): read as
                    // text so share-import.js can deserialize them into real tiddlers, not a blob.
                    val text = contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: return@runCatching
                    arr.put(org.json.JSONObject().put("__importText", text).put("__importName", name.ifBlank { "shared" }))
                } else {
                    // Stream to a temp file (small 8K buffer) — no whole-file-in-RAM, no base64 here.
                    val temp = File(shareTempDir(), "s${System.nanoTime()}")
                    val copied = contentResolver.openInputStream(uri)?.use { input ->
                        temp.outputStream().use { input.copyTo(it) }; true
                    } ?: false
                    if (!copied || temp.length() == 0L) { temp.delete(); return@runCatching }
                    arr.put(org.json.JSONObject()
                        .put("title", sanitizeShareTitle(name).ifBlank { "shared-${System.currentTimeMillis()}" })
                        .put("type", contentResolver.getType(uri) ?: "application/octet-stream")
                        .put("tags", "shared")
                        .put("__sharedFile", temp.absolutePath))
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
            // Only release the keep-alive when the WikiList task is actually closed (swiped away) —
            // NOT when merely backgrounded, so the Node server survives in the background.
            WikiListForegroundService.stop(this)
            wikiListServer?.stop()
        }
        super.onDestroy()
    }

    private var storageDialog: android.app.AlertDialog? = null

    /**
     * Direct-path wiki access needs All-Files-Access (MANAGE_EXTERNAL_STORAGE) on Android 11+, or
     * WRITE_EXTERNAL_STORAGE on 10 and below. If it isn't granted, show a blocking prompt with an
     * "Open settings" button that deep-links to the toggle. Called on startup and every onResume,
     * so returning from the Settings screen dismisses it automatically once granted.
     */
    private fun ensureStorageAccess() {
        if (com.tiddlywiki.tiddlydesktop.host.StorageAccess.isGranted(this)) {
            storageDialog?.dismiss(); storageDialog = null
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            runCatching { requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE), 9912) }
            return
        }
        if (storageDialog?.isShowing == true) return
        storageDialog = android.app.AlertDialog.Builder(this)
            .setTitle(R.string.storage_access_title)
            .setMessage(R.string.storage_access_message)
            .setCancelable(false)
            .setPositiveButton(R.string.storage_access_open_settings) { _, _ ->
                runCatching { startActivity(com.tiddlywiki.tiddlydesktop.host.StorageAccess.settingsIntent(this)) }
                    .onFailure {
                        runCatching {
                            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                    }
            }
            .setNegativeButton(R.string.storage_access_later, null)
            .show()
    }

    /** Android 13+: the persistent foreground notification only shows with POST_NOTIFICATIONS. */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            runCatching { requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 9911) }
        }
    }

    companion object {
        private const val TAG = "MainActivity"
        /** Fixed WikiList server port so a language-switch reboot keeps the same url. */
        private const val WIKILIST_PORT = 38000
        private const val SETTINGS_FILE = "tiddlydesktop-settings.json"
        /** Shared files with these extensions are read as text and imported as tiddlers (not blobs). */
        private val TIDDLER_CONTAINER_EXTS =
            listOf(".tid", ".json", ".html", ".htm", ".csv", ".multids", ".tids", ".tiddler")
    }
}
