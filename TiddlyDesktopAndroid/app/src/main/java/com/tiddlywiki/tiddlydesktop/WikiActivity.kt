package com.tiddlywiki.tiddlydesktop

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.tiddlywiki.tiddlydesktop.collab.CollabBridge
import com.tiddlywiki.tiddlydesktop.host.MetaBridge
import com.tiddlywiki.tiddlydesktop.host.SystemBarsBridge
import com.tiddlywiki.tiddlydesktop.host.WikiUrl
import com.tiddlywiki.tiddlydesktop.node.NodeServer
import com.tiddlywiki.tiddlydesktop.server.SingleFileWikiServer
import java.io.File

/**
 * Hosts a single opened wiki in its own task/process (see manifest: :wiki,
 * documentLaunchMode="always"). Started via an Intent carrying the extras below.
 *
 * Single-file wikis: served by a lightweight local HTTP server (SingleFileWikiServer)
 * so no Node is required to view/save them.
 * Folder wikis: served by a Node `--listen` server ([NodeServer]).
 *
 * In both cases the collab bridge shim + [CollabBridge] JavascriptInterface are injected
 * so the codemirror-6-collab-nwjs plugin works (see README.md → "The `window._nwjs*` bridge
 * contract").
 */
class WikiActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var folderServer: NodeServer? = null
    private var singleFileServer: SingleFileWikiServer? = null
    /** Owns the collab LAN helper process; disposed on destroy. */
    private var collabBridge: CollabBridge? = null
    /** Key (wiki path) this folder wiki's server is parked under in WarmNodeServers on close (#3). */
    private var warmKey: String? = null
    /** The server URL this window loaded — passed to child (tm-open-window) windows. */
    @Volatile private var loadedServerUrl: String? = null
    @Volatile private var pageReady = false

    // Wiki identity (needed by the attachments bridge + interceptor).
    private var wikiPathField: String = ""
    private var isFolderFlag: Boolean = false
    private var backupDirField: String? = null

    // Import (WebView file input) + export (download → SAF) plumbing.
    private var fileChooserCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null
    private var pendingSaveBytes: ByteArray? = null
    // When the user clicks a PDF/download link, bridge/pdf-viewer.js "arms" a download so onDownload
    // lets that PDF through; an un-armed PDF download is the pdfparser's inline viewer auto-loading,
    // which we swallow (it's rendered inline). See onDownload / WikiUxBridge.armDownload.
    @Volatile private var downloadArmedAt = 0L

    // Fullscreen (embedded players / HTML5 video) via WebChromeClient.onShowCustomView.
    private var customView: android.view.View? = null
    private var customViewCallback: android.webkit.WebChromeClient.CustomViewCallback? = null

    private val fileChooserLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = fileChooserCallback; fileChooserCallback = null
        cb?.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    private val createDocLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("*/*")
    ) { uri ->
        val bytes = pendingSaveBytes; pendingSaveBytes = null
        if (uri != null && bytes != null) {
            runCatching { contentResolver.openOutputStream(uri)?.use { it.write(bytes) } }
                .onSuccess { toast(R.string.toast_saved) }.onFailure { toast(R.string.toast_save_failed) }
        }
    }

    // Collab "save asset to disk" = external attachment: prompt for a filename, then tell the plugin
    // to save into the wiki's attachments/ folder (dest "attachments/<name>"). Its file bridge
    // (TDCollab.fileCmd) writes the bytes there and returns "./attachments/<name>" as _canonical_uri,
    // which our server serves (with range). Saving to an arbitrary SAF location would give a broken,
    // non-relative _canonical_uri.
    fun pickCollabSave(title: String, filename: String) = runOnUiThread {
        val input = android.widget.EditText(this).apply {
            setText(filename.ifBlank { "asset" }); setSelection(text.length)
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("Save attachment as")
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val name = sanitizeAttachmentName(input.text.toString().trim().ifBlank { filename })
                webView.evaluateJavascript(
                    "\$tw.rootWidget.dispatchEvent({type:'codemirror-6-collab-get-asset',param:${jsQuote(title)}," +
                        "files:[{path:${jsQuote("attachments/$name")}}]});", null)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Write a collab asset into this wiki's attachments/ folder; returns "./attachments/<name>". */
    fun writeCollabAsset(base64: String, name: String): String = writeAttachment(base64, name)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)

        val wikiPath = intent.getStringExtra(EXTRA_WIKI_PATH) ?: ""
        val wikiTitle = intent.getStringExtra(EXTRA_WIKI_TITLE) ?: "Wiki"
        val isFolder = intent.getBooleanExtra(EXTRA_IS_FOLDER, false)
        // Set for the WikiList backstage: a view onto an already-running Node server.
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL)
        title = wikiTitle
        wikiPathField = wikiPath
        isFolderFlag = isFolder
        backupDirField = intent.getStringExtra(EXTRA_BACKUP_DIR)

        // WikiActivity runs in the :wiki process, which also creates a WebView. Two processes
        // of the same app sharing the default WebView data directory is forbidden and crashes
        // the second one. Give each wiki its own data dir suffix (also isolates cookies/storage
        // per wiki). Must run before any WebView is created in this process.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                val key = serverUrl ?: wikiPath
                val hash = (key.hashCode().toLong() and 0xFFFFFFFFL)
                WebView.setDataDirectorySuffix("wiki_%08x".format(hash))
            } catch (e: Exception) {
                Log.w(TAG, "setDataDirectorySuffix failed: ${e.message}")
            }
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            // Pinch-zoom. Folder wikis (bundled recent core) already allow it, but many single-file
            // wikis ship a viewport with user-scalable=no / maximum-scale=1 that the WebView honours,
            // blocking the gesture. Enable the built-in zoom mechanism (pinch + double-tap) and hide
            // the deprecated on-screen +/- controls; bridge/pinch-zoom.js neutralises restrictive
            // viewports so both wiki types behave the same.
            settings.setSupportZoom(true)
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url.toString()
                    // Keep loopback wiki URLs in-app; send everything else to the browser.
                    if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) return false
                    startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
                    return true
                }

                // External attachments (_canonical_uri ./attachments/<name>) are served over real
                // HTTP with Range/206 support (so media can be seeked): single-file wikis by
                // SingleFileWikiServer, folder wikis by the bundled core-server /attachments/ route.
                // The interceptor can't do 206 (Chrome retries endlessly), so we DON'T handle
                // /attachments/ here at all — let it fall through to the respective HTTP server.

                // Serve the bundled pdf.js from a SAME-ORIGIN virtual path (/__td/pdfjs/…) so the
                // loopback-served wiki page can load it (and its worker) without CORS. Everything
                // else returns null → falls through to the wiki's Node/HTTP server.
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): android.webkit.WebResourceResponse? {
                    val path = request.url.path ?: return null
                    if (path.startsWith("/__td/pdfjs/")) {
                        val asset = "pdfjs/" + path.substringAfterLast('/')
                        return runCatching {
                            android.webkit.WebResourceResponse("application/javascript", "UTF-8", assets.open(asset))
                        }.getOrNull()
                    }
                    return null
                }

                override fun onPageFinished(view: WebView, url: String) {
                    injectCollabBridge(wikiPath)
                    injectAsset(view, SystemBarsBridge.SCRIPT_ASSET)
                    injectAsset(view, "bridge/no-save-notify.js")
                    injectAsset(view, "bridge/wiki-ux.js") // print / fullscreen hooks
                    injectAsset(view, "bridge/pinch-zoom.js") // allow pinch-zoom on single-file wikis
                    injectAsset(view, "bridge/attachments.js") // external-attachments import hook
                    injectAsset(view, "bridge/embeds.js") // harden allowlisted media embeds (YouTube, …)
                    injectAsset(view, "bridge/pdf-viewer.js") // inline PDF via pdf.js (WebView has no PDF plugin)
                    injectAsset(view, "bridge/collab-getasset.js") // collab "save asset to disk" → SAF
                    // Saving for TiddlyWiki Classic single-file wikis (no-op for TW5). Single-file
                    // only — classic wikis are single HTML files served by SingleFileWikiServer.
                    if (serverUrl == null && !isFolderFlag) injectAsset(view, "bridge/classic-saver.js")
                    // tm-open-window → child Activity; child windows render just their tiddler.
                    intent.getStringExtra(EXTRA_FOCUS_TIDDLER)?.let {
                        view.evaluateJavascript("window.__tdFocusTiddler=${jsQuote(it)};", null)
                    }
                    injectAsset(view, "bridge/open-window.js")
                    injectAsset(view, "bridge/share-tiddler.js") // "Share" tiddler-toolbar button
                    injectAsset(view, "bridge/share-import.js")  // defines window.__tdImportShare
                    // Push live SiteTitle/SiteSubtitle/favicon back to the WikiList (real wikis only).
                    if (serverUrl == null) injectAsset(view, MetaBridge.SCRIPT_ASSET)
                    pageReady = true
                    drainShares() // import any content shared to this wiki
                }
            }
            // Import: route the wiki's <input type=file> to the SAF picker.
            webChromeClient = object : android.webkit.WebChromeClient() {
                // Surface the wiki page's console.* in logcat (tag "TDConsole") — invaluable for
                // diagnosing the collab plugin ([collab-transport]/oauth) and other in-page logic.
                override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                    Log.d("TDConsole", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
                override fun onShowFileChooser(
                    view: WebView, callback: android.webkit.ValueCallback<Array<android.net.Uri>>,
                    params: FileChooserParams
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = callback
                    return runCatching { fileChooserLauncher.launch(params.createIntent()); true }
                        .getOrElse { fileChooserCallback = null; false }
                }

                // Fullscreen for embedded players / HTML5 video (the <iframe>/<video> goes
                // fullscreen over the whole window, system bars hidden).
                override fun onShowCustomView(view: android.view.View, callback: CustomViewCallback) {
                    if (customView != null) { callback.onCustomViewHidden(); return }
                    customView = view
                    customViewCallback = callback
                    (window.decorView as FrameLayout).addView(
                        view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
                    )
                    androidx.core.view.WindowCompat.getInsetsController(window, view).hide(WindowInsetsCompat.Type.systemBars())
                }

                override fun onHideCustomView() {
                    customView?.let { (window.decorView as FrameLayout).removeView(it) }
                    customView = null
                    customViewCallback?.onCustomViewHidden(); customViewCallback = null
                    androidx.core.view.WindowCompat.getInsetsController(window, webView).show(WindowInsetsCompat.Type.systemBars())
                }
            }
            // Export: the wiki triggers a download (data: or blob:) — save it via SAF.
            setDownloadListener { downloadUrl, _, contentDisposition, mimetype, _ ->
                onDownload(downloadUrl, contentDisposition, mimetype)
            }
            addJavascriptInterface(WikiUxBridge(), "TDWikiUX")
            addJavascriptInterface(WikiAttachBridge(), "TDAttach")
            addJavascriptInterface(WindowBridge(), "TDWindow")
            addJavascriptInterface(ShareBridge(), "TDShare")
        }
        val root = FrameLayout(this).apply { addView(webView) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        webView.addJavascriptInterface(SystemBarsBridge(this, root), SystemBarsBridge.INTERFACE_NAME)
        // Register the collab bridge BEFORE loadUrl — addJavascriptInterface only takes effect on
        // the next page load, so registering it in onPageFinished (single-file wikis never reload)
        // left `TDCollab` undefined, the shim bailed out, and OAuth fell back to CORS-blocked fetch.
        collabBridge = CollabBridge(this, webView, wikiPath)
        webView.addJavascriptInterface(collabBridge!!, CollabBridge.INTERFACE_NAME)
        if (serverUrl == null) {
            val wikiUrl = WikiUrl.encode(wikiPath, isFolder)
            webView.addJavascriptInterface(MetaBridge(applicationContext, wikiUrl), MetaBridge.INTERFACE_NAME)
        }
        setContentView(root)

        // Back closes the wiki window. If it has unsaved changes, prompt first (like the desktop
        // "leave wiki" confirmation) instead of silently discarding them.
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                confirmCloseIfDirty { finish() }
            }
        })

        WikiServerService.wikiOpened(
            this, wikiPath, wikiTitle, isFolder,
            intent.getBooleanExtra(EXTRA_BACKUPS_ENABLED, true),
            intent.getIntExtra(EXTRA_BACKUP_COUNT, 20),
            intent.getStringExtra(EXTRA_BACKUP_DIR) ?: ""
        )

        Thread {
            val url = try {
                when {
                    // Backstage: just load an already-running server (the WikiList itself).
                    serverUrl != null -> serverUrl
                    isFolder -> {
                        warmKey = wikiPath
                        // #3: reuse a warm server parked for this wiki — skips the multi-second Node
                        // boot. Node serves the wiki folder directly off its real filesystem path.
                        val warmed = com.tiddlywiki.tiddlydesktop.node.WarmNodeServers.take(this, wikiPath)
                        val server = warmed?.also { folderServer = it }
                            ?: NodeServer(this, File(wikiPath)).also { folderServer = it; it.start() }
                        server.url
                    }
                    else -> {
                        val backupsEnabled = intent.getBooleanExtra(EXTRA_BACKUPS_ENABLED, true)
                        val backupCount = intent.getIntExtra(EXTRA_BACKUP_COUNT, 20)
                        val backupDir = intent.getStringExtra(EXTRA_BACKUP_DIR)
                        val server = SingleFileWikiServer(this, wikiPath, backupsEnabled, backupCount, backupDir)
                        singleFileServer = server
                        server.start()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start wiki server: ${e.message}")
                return@Thread
            }
            loadedServerUrl = url
            // Child (tm-open-window) windows load the target tiddler's permalink so it opens
            // reliably; open-window.js then styles it as a single-tiddler window.
            val focus = intent.getStringExtra(EXTRA_FOCUS_TIDDLER)
            val loadUrl = if (!focus.isNullOrBlank()) "$url#${android.net.Uri.encode(focus)}" else url
            runOnUiThread { webView.loadUrl(loadUrl) }
        }.apply { isDaemon = true; start() }
    }

    override fun onResume() {
        super.onResume()
        // Sharing to an ALREADY-open wiki brings it to front → import the queued content now.
        if (pageReady) drainShares()
    }

    /** Import any content shared to this wiki (queued as files to dodge Intent size limits). */
    private fun drainShares() {
        val path = wikiPathField
        if (path.isBlank()) return
        Thread {
            val payloads = com.tiddlywiki.tiddlydesktop.node.ShareQueue.drain(applicationContext, path)
            payloads.forEach { p ->
                runOnUiThread { webView.evaluateJavascript("window.__tdImportShare && window.__tdImportShare(${jsQuote(p)});", null) }
            }
        }.apply { isDaemon = true; start() }
    }

    /** Inject the shim that wires window._nwjs* to the (already-registered) TDCollab interface. */
    private fun injectCollabBridge(wikiPath: String) {
        injectAsset(webView, CollabBridge.SHIM_ASSET)
    }

    private fun injectAsset(view: WebView, assetPath: String) {
        val js = runCatching {
            assets.open(assetPath).bufferedReader().use { it.readText() }
        }.getOrNull() ?: run { Log.w(TAG, "asset missing: $assetPath"); return }
        view.evaluateJavascript(js, null)
    }

    // ── print / fullscreen / import-export (window.TDWikiUX) ─────────────────────────

    /** JS-facing bridge for the wiki's print + fullscreen buttons and blob exports. */
    inner class WikiUxBridge {
        @android.webkit.JavascriptInterface
        fun print() = runOnUiThread { printWebView() }

        @android.webkit.JavascriptInterface
        fun setFullscreen(on: Boolean) = runOnUiThread { applyImmersive(on) }

        /** JS calls this when the user clicks a PDF/download link, so onDownload lets that PDF
         * through instead of treating it as the pdfparser's inline-viewer auto-load. */
        @android.webkit.JavascriptInterface
        fun armDownload() { downloadArmedAt = System.currentTimeMillis() }

        /** Called back from JS after reading a blob: download as a data URL. */
        @android.webkit.JavascriptInterface
        fun saveBlob(dataUrl: String, name: String) {
            decodeDataUrl(dataUrl)?.let { saveBytes(name, it) }
        }
    }

    // ── tm-open-window → child Activity in the :wiki process (window.TDWindow) ────────

    inner class WindowBridge {
        @android.webkit.JavascriptInterface
        fun openTiddler(title: String) = runOnUiThread {
            val server = loadedServerUrl
            if (server.isNullOrBlank()) { toast(R.string.toast_window_not_ready); return@runOnUiThread }
            com.tiddlywiki.tiddlydesktop.host.WikiLauncher.openChildWindow(
                this@WikiActivity, server, title, wikiPathField, isFolderFlag, backupDirField ?: ""
            )
        }
    }

    // ── share a tiddler out (window.TDShare) ─────────────────────────────────────────

    inner class ShareBridge {
        /** Localized labels (device language) for the injected in-wiki "Share" button. */
        @android.webkit.JavascriptInterface
        fun uiStrings(): String = org.json.JSONObject(
            mapOf(
                "share" to getString(R.string.share_btn),
                "tooltip" to getString(R.string.share_btn_tooltip),
                "text" to getString(R.string.share_as_text),
                "tid" to getString(R.string.share_as_tid),
                "html" to getString(R.string.share_as_html),
                "json" to getString(R.string.share_as_json),
                "csv" to getString(R.string.share_as_csv)
            )
        ).toString()

        @android.webkit.JavascriptInterface
        fun shareText(subject: String, text: String) = runOnUiThread {
            runCatching {
                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    if (subject.isNotBlank()) putExtra(android.content.Intent.EXTRA_SUBJECT, subject)
                    putExtra(android.content.Intent.EXTRA_TEXT, text)
                }
                startActivity(android.content.Intent.createChooser(send, getString(R.string.share_tiddler_chooser))
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            }.onFailure { toast(R.string.toast_share_failed) }
        }

        /** Share the tiddler as an actual <title>.tid file via FileProvider. */
        @android.webkit.JavascriptInterface
        fun shareTidFile(title: String, tidContent: String) = shareFile(title, tidContent, "tid", "application/octet-stream")

        /** Share [content] as a <title>.<ext> file (JSON/CSV/…) via FileProvider. */
        @android.webkit.JavascriptInterface
        fun shareFile(title: String, content: String, ext: String, mime: String) = runOnUiThread {
            runCatching {
                // Outgoing shares live in their OWN dir — NOT cache/shared/, which the receiving side
                // (MainActivity.buildFilePayload) purges, which would delete a file shared to ourselves
                // before it could be read. Drop stale outgoing files (>10 min) to bound growth.
                val dir = File(cacheDir, "share-out").apply { mkdirs() }
                runCatching { dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 600_000) it.delete() } }
                val safe = title.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().ifBlank { "tiddler" }
                val cleanExt = ext.trim().trim('.').ifBlank { "txt" }
                val f = File(dir, "$safe.$cleanExt").apply { writeText(content) }
                val uri = androidx.core.content.FileProvider.getUriForFile(this@WikiActivity, "$packageName.fileprovider", f)
                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = mime.ifBlank { "application/octet-stream" }
                    putExtra(android.content.Intent.EXTRA_STREAM, uri)
                    putExtra(android.content.Intent.EXTRA_SUBJECT, "$safe.$cleanExt")
                    addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(android.content.Intent.createChooser(send, getString(R.string.share_tid_file_chooser))
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            }.onFailure { toast(R.string.toast_share_failed) }
        }
    }

    private fun printWebView() {
        runCatching {
            val pm = getSystemService(android.content.Context.PRINT_SERVICE) as android.print.PrintManager
            val jobName = title?.toString()?.ifBlank { null } ?: "TiddlyWiki"
            pm.print(jobName, webView.createPrintDocumentAdapter(jobName), android.print.PrintAttributes.Builder().build())
        }.onFailure { Log.w(TAG, "print failed: ${it.message}") }
    }

    private fun applyImmersive(on: Boolean) {
        val controller = androidx.core.view.WindowCompat.getInsetsController(window, webView)
        if (on) {
            controller.systemBarsBehavior =
                androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun onDownload(url: String, contentDisposition: String?, mimetype: String?) {
        // The WebView has no PDF plugin, so when TiddlyWiki's pdfparser inserts its viewer (a
        // <iframe>/<embed> pointing at the PDF — data: for embedded, ./attachments/… for external)
        // the WebView tries to *download* it and pops the "Save file" dialog — even though
        // bridge/pdf-viewer.js is already rendering that same PDF inline with pdf.js (which fetches
        // it itself, so it's unaffected). Swallow that AUTOMATIC PDF load. A DELIBERATE download —
        // the user clicking a PDF/download link — is armed from JS first (armDownload), so it still
        // works. Non-PDF attachments (zip, docx, …) and TW exports (json/html/blob) always fall
        // through and download normally.
        if (isPdfContent(url, mimetype) && !consumeDownloadArm()) {
            Log.d(TAG, "Suppressing PDF inline-viewer download (not user-initiated): $url"); return
        }
        val name = guessFilename(url, contentDisposition, mimetype)
        when {
            url.startsWith("data:") -> decodeDataUrl(url)?.let { saveBytes(name, it) }
            // blob: (TW exports) and http(s) (the "Get" button on an external-attachment tiddler,
            // whose _canonical_uri resolves to http://127.0.0.1/attachments/…) both live only in
            // the page's same-origin context — fetch there (cookie included), hand back a data URL,
            // then save via the SAF "Save As" picker so the user can choose the filename.
            url.startsWith("blob:") || url.startsWith("http://") || url.startsWith("https://") -> {
                val js = "fetch(${jsQuote(url)}).then(function(r){return r.blob();})." +
                    "then(function(b){var fr=new FileReader();fr.onload=function(){" +
                    "TDWikiUX.saveBlob(fr.result, ${jsQuote(name)});};fr.readAsDataURL(b);}).catch(function(e){});"
                runOnUiThread { webView.evaluateJavascript(js, null) }
            }
        }
    }

    /** True when a download is a PDF — the pdfparser's inline viewer, unless the user armed it. */
    private fun isPdfContent(url: String, mimetype: String?): Boolean {
        if (mimetype?.startsWith("application/pdf", ignoreCase = true) == true) return true
        val path = url.substringBefore('?').substringBefore('#')
        return path.startsWith("data:application/pdf", ignoreCase = true) ||
            path.endsWith(".pdf", ignoreCase = true)
    }

    /** A one-shot "the user deliberately started this download" flag, set by JS on a link click. */
    private fun consumeDownloadArm(): Boolean {
        val armed = downloadArmedAt != 0L && System.currentTimeMillis() - downloadArmedAt < 3000
        downloadArmedAt = 0L // one-shot: never let a stale arm wave through a later auto-load
        return armed
    }

    private fun decodeDataUrl(url: String): ByteArray? {
        val comma = url.indexOf(','); if (comma < 0) return null
        val meta = url.substring(0, comma)
        val data = url.substring(comma + 1)
        return runCatching {
            if (meta.contains("base64", ignoreCase = true))
                android.util.Base64.decode(data, android.util.Base64.DEFAULT)
            else java.net.URLDecoder.decode(data, "UTF-8").toByteArray()
        }.getOrNull()
    }

    private fun saveBytes(name: String, bytes: ByteArray) {
        pendingSaveBytes = bytes
        runOnUiThread { runCatching { createDocLauncher.launch(name) }.onFailure { pendingSaveBytes = null } }
    }

    private fun guessFilename(url: String, contentDisposition: String?, mimetype: String?): String {
        contentDisposition?.let {
            Regex("filename\\*?=\"?([^\";]+)", RegexOption.IGNORE_CASE).find(it)
                ?.let { m -> return m.groupValues[1].trim().trim('"') }
        }
        return runCatching { android.webkit.URLUtil.guessFileName(url, contentDisposition, mimetype) }
            .getOrNull()?.takeIf { it.isNotBlank() && it != "downloadfile.bin" } ?: "tiddlers.json"
    }

    private fun jsQuote(s: String): String = org.json.JSONObject.quote(s)

    // ── external attachments (window.TDAttach) ───────────────────────────────────────

    /** JS-facing bridge: the external-attachments import hook copies files here. */
    inner class WikiAttachBridge {
        /** Returns "./attachments/<name>" for the _canonical_uri, or "" on failure. */
        @android.webkit.JavascriptInterface
        fun saveAttachment(base64: String, filename: String, mime: String): String =
            runCatching { writeAttachment(base64, filename) }
                .getOrElse { Log.w(TAG, "saveAttachment failed: ${it.message}"); "" }

        /**
         * Attach a shared file staged by MainActivity (share-import.js, External Attachments ON):
         * stream it from [tempPath] into the wiki's attachments/ folder — no base64, so large media
         * (video) works. Deletes the temp on success. Returns "./attachments/<name>" or "".
         */
        @android.webkit.JavascriptInterface
        fun importSharedFile(tempPath: String, filename: String, mime: String): String =
            runCatching {
                val src = File(tempPath)
                if (!src.exists()) return ""
                val dir = attachmentsDir()?.apply { mkdirs() } ?: error("no folder for attachments")
                val safe = sanitizeAttachmentName(filename)
                var name = safe; var n = 1
                while (File(dir, name).exists()) { name = bump(safe, n++) }
                src.inputStream().use { i -> File(dir, name).outputStream().use { o -> i.copyTo(o) } }
                runCatching { src.delete() }
                "./attachments/$name"
            }.getOrElse { Log.w(TAG, "importSharedFile failed: ${it.message}"); "" }

        /** Base64 of a staged shared file (embed/import when External Attachments is OFF). "" on failure. */
        @android.webkit.JavascriptInterface
        fun sharedFileBase64(tempPath: String): String =
            runCatching {
                val src = File(tempPath)
                if (!src.exists()) return ""
                val b64 = android.util.Base64.encodeToString(src.readBytes(), android.util.Base64.NO_WRAP)
                runCatching { src.delete() }
                b64
            }.getOrElse { Log.w(TAG, "sharedFileBase64 failed: ${it.message}"); "" }

        /** UTF-8 text of a staged shared text file (shared .txt etc.). "" on failure. */
        @android.webkit.JavascriptInterface
        fun sharedFileText(tempPath: String): String =
            runCatching {
                val src = File(tempPath)
                if (!src.exists()) return ""
                val txt = src.readText(Charsets.UTF_8)
                runCatching { src.delete() }
                txt
            }.getOrElse { Log.w(TAG, "sharedFileText failed: ${it.message}"); "" }

        /** Localized note (caption+body) explaining EA absolute-path options don't apply on Android. */
        @android.webkit.JavascriptInterface
        fun note(): String = org.json.JSONObject(
            mapOf(
                "caption" to getString(R.string.ea_note_caption),
                "body" to getString(R.string.ea_note_body)
            )
        ).toString()
    }

    /**
     * The wiki's attachments/ folder on disk: inside the folder wiki itself, or (single-file) in
     * the wiki's containing folder. Both are now absolute paths (direct file access, no SAF mirror).
     */
    private fun attachmentsDir(): File? {
        val base = if (isFolderFlag) wikiPathField else backupDirField?.ifBlank { null } ?: return null
        return File(base, "attachments")
    }

    private fun writeAttachment(base64: String, filename: String): String {
        val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
        val safe = sanitizeAttachmentName(filename)
        val dir = attachmentsDir()?.apply { mkdirs() } ?: error("no folder for attachments")
        var name = safe; var n = 1
        while (File(dir, name).exists()) { name = bump(safe, n++) }
        File(dir, name).writeBytes(bytes)
        return "./attachments/$name"
    }

    /** Read a stored attachment's raw bytes from the wiki's attachments/ folder (null if absent). */
    fun readAttachmentBytes(name: String): ByteArray? = runCatching {
        val dir = attachmentsDir() ?: return@runCatching null
        val f = File(dir, sanitizeAttachmentName(name))
        if (f.exists()) f.readBytes() else null
    }.getOrNull()


    private fun sanitizeAttachmentName(name: String): String =
        name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._-]"), "_")
            .ifBlank { "attachment" }

    private fun bump(name: String, n: Int): String {
        val dot = name.lastIndexOf('.')
        return if (dot > 0) "${name.substring(0, dot)}-$n${name.substring(dot)}" else "$name-$n"
    }


    private fun toast(msg: String) =
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    private fun toast(resId: Int) = toast(getString(resId))

    /**
     * Ask the wiki whether it has unsaved changes; if so, prompt (Save / Discard / Cancel) before
     * running [onClose]. Covers single-file savers ($tw.saverHandler) and folder-wiki syncers.
     */
    private fun confirmCloseIfDirty(onClose: () -> Unit) {
        if (!pageReady) { onClose(); return }
        webView.evaluateJavascript(DIRTY_JS) { result ->
            if (result == "true") showUnsavedDialog(onClose) else onClose()
        }
    }

    private fun showUnsavedDialog(onClose: () -> Unit) {
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.unsaved_title)
            .setMessage(R.string.unsaved_message)
            .setCancelable(true)
            .setPositiveButton(R.string.unsaved_save) { _, _ -> saveThenClose(onClose) }
            .setNegativeButton(R.string.unsaved_discard) { _, _ -> onClose() }
            .setNeutralButton(android.R.string.cancel, null)
            .show()
    }

    /** Trigger a save, then close once the save has had time to flush to the (loopback) server. */
    private fun saveThenClose(onClose: () -> Unit) {
        webView.evaluateJavascript("try{\$tw.rootWidget.dispatchEvent({type:'tm-save-wiki'});}catch(e){}", null)
        webView.postDelayed({ onClose() }, 900)
    }

    override fun onDestroy() {
        // Always tear down the collab LAN helper process — even on a non-finishing recreate, so a
        // config change can't orphan it.
        runCatching { collabBridge?.dispose() }
        collabBridge = null
        if (isFinishing) {
            // We own the server (serverUrl==null). Close any tm-open-window child windows pointing at
            // it first — otherwise they'd be left showing a dead (connection-refused) server.
            if (intent.getStringExtra(EXTRA_SERVER_URL) == null) {
                loadedServerUrl?.let { com.tiddlywiki.tiddlydesktop.host.WikiLauncher.closeChildWindows(this, it) }
            }
            // #3: park the folder server warm for an instant reopen instead of killing it. park()
            // sets the warm hold BEFORE wikiClosed() drops the open count, so :wiki is never briefly
            // reap-eligible. Single-file servers are cheap (no Node boot) — just stop them.
            // BUT if this wiki was swiped out of the Overview, the user wants it gone: stop the
            // server (don't park) so the foreground service can actually shut down.
            val swiped = WikiServerService.consumeSwiped(wikiPathField)
            val fs = folderServer
            val key = warmKey
            if (fs != null && key != null && !swiped) {
                com.tiddlywiki.tiddlydesktop.node.WarmNodeServers.park(this, key, fs)
            } else {
                fs?.stop()
            }
            singleFileServer?.stop()
            WikiServerService.wikiClosed(this, intent.getStringExtra(EXTRA_WIKI_PATH) ?: "")
        }
        super.onDestroy()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // Warm servers cost ~150 MB each — the moment Android signals memory pressure, drop them.
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            com.tiddlywiki.tiddlydesktop.node.WarmNodeServers.clear(applicationContext)
        }
    }

    companion object {
        private const val TAG = "WikiActivity"

        // Returns "true" if the wiki has unsaved changes — single-file savers ($tw.saverHandler) or
        // folder-wiki syncer tasks still pending. Any error → "false" (don't block closing).
        private const val DIRTY_JS =
            "(function(){try{if(window.\$tw){" +
                "if(\$tw.saverHandler&&typeof \$tw.saverHandler.isDirty==='function'&&\$tw.saverHandler.isDirty())return true;" +
                "if(\$tw.syncer){" +
                "if(\$tw.syncer.taskQueue&&Object.keys(\$tw.syncer.taskQueue).length>0)return true;" +
                "if(\$tw.syncer.taskInProgress&&Object.keys(\$tw.syncer.taskInProgress).length>0)return true;" +
                "}}}catch(e){}return false;})()"
        const val EXTRA_WIKI_PATH = "wiki_path"
        const val EXTRA_WIKI_TITLE = "wiki_title"
        const val EXTRA_IS_FOLDER = "is_folder"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_FOCUS_TIDDLER = "focus_tiddler"
        const val EXTRA_SHARE_PAYLOAD = "share_payload"
        const val EXTRA_BACKUPS_ENABLED = "backups_enabled"
        const val EXTRA_BACKUP_COUNT = "backup_count"
        const val EXTRA_BACKUP_DIR = "backup_dir"
    }
}
