package com.tiddlywiki.tiddlydesktop.host

import android.webkit.JavascriptInterface

/**
 * `window.TDHost` — the native side of the classic TiddlyDesktop WikiList.
 *
 * The WikiList is the classic `plugins/tiddlydesktop` UI served by Node.js. Its
 * `$tw.desktop` implementation (android-desktop.js) calls the methods here; native code
 * calls back into the page via `window.__tdAddWiki(...)` / `window.__tdWikiListChanged()`.
 *
 * Methods run on a WebView binder thread, so all Activity/UI work is delegated to
 * [Callbacks] (which hops to the UI thread).
 */
class TDHost(
    private val callbacks: Callbacks
) {
    interface Callbacks {
        /** Launch SAF picker; on success call window.__tdAddWiki(url,title,favicon,isFolder). */
        fun pickSingleFileWiki()
        fun pickFolderWiki()
        /** Decode [url] (wikifile://…/wikifolder://…) and open it in a WikiActivity. */
        fun openWikiUrl(url: String, title: String, isFolder: Boolean, backupsEnabled: Boolean, backupCount: Int, backupDir: String)
        /** Open a SAF folder (tree URI) in the system file manager, best-effort. */
        fun revealFolder(treeUri: String)
        /** Open the wiki's `<file>.backups` subfolder inside [treeUri]. */
        fun revealBackups(treeUri: String, url: String)
        /** Open a link in the system browser. */
        fun openExternal(url: String)
        /** Create a new wiki by cloning [source] (a template URL, wikifile://… or wikifolder://…). */
        fun cloneWiki(source: String)
        /** Convert [sourceUrl] (wikifile://… ⇄ wikifolder://…) to the other form. */
        fun convertWiki(sourceUrl: String)
        /** Extract live SiteTitle/SiteSubtitle/favicon for [url] and push back via __tdSetWikiMeta. */
        fun refreshWikiMeta(url: String)
        /** Pick a SAF folder to use as a custom plugin library. */
        fun pickPluginFolder()
        /** Pick a SAF folder to persist WikiList settings (survives reinstall). */
        fun pickConfigFolder()
        /** Write the settings JSON export to the config folder. */
        fun exportSettings(json: String)
        /** Read the settings JSON from the config folder ("" if none). */
        fun readConfigJson(): String
        /** Persist the wiki list (JSON array) so the Quick Note widget can offer a wiki chooser. */
        fun saveWikiList(json: String)
        /** Readable path of the config folder ("" if unset). */
        fun configFolderPath(): String
        /** Open the config folder in the system file manager. */
        fun openConfigFolder()
        /** Pick a SAF folder where all backups are written (overrides per-wiki backups). */
        fun pickBackupFolder()
        /** Readable path of the global backup folder ("" if unset). */
        fun backupFolderPath(): String
        /** Open the global backup folder in the system file manager. */
        fun openBackupFolder()
        /** Whether a shared payload is waiting to be imported into a wiki. */
        fun hasPendingShare(): Boolean
        /** Enriched metadata for the pending share (kind/title/description/image/embed/…) as JSON. */
        fun getShareData(): String
        /**
         * Import the pending share into the chosen wiki (opens it). [tiddlersJson] is the finished
         * tiddler array produced from a share template (empty → use the native payload, e.g. files).
         */
        fun shareToWiki(url: String, title: String, isFolder: Boolean, backupsEnabled: Boolean, backupCount: Int, backupDir: String, tiddlersJson: String)
        /** Discard the pending shared payload. */
        fun cancelShare()
    }

    @JavascriptInterface
    fun openWiki(url: String, title: String, isFolder: Boolean, backupsEnabled: Boolean, backupCount: Int, backupDir: String) =
        callbacks.openWikiUrl(url, title, isFolder, backupsEnabled, backupCount, backupDir)

    @JavascriptInterface
    fun revealFolder(treeUri: String) = callbacks.revealFolder(treeUri)

    @JavascriptInterface
    fun revealBackups(treeUri: String, url: String) = callbacks.revealBackups(treeUri, url)

    @JavascriptInterface
    fun addSingleFileWiki() = callbacks.pickSingleFileWiki()

    @JavascriptInterface
    fun addFolderWiki() = callbacks.pickFolderWiki()

    @JavascriptInterface
    fun openExternal(url: String) = callbacks.openExternal(url)

    @JavascriptInterface
    fun cloneWiki(source: String) = callbacks.cloneWiki(source)

    @JavascriptInterface
    fun convertWiki(sourceUrl: String) = callbacks.convertWiki(sourceUrl)

    @JavascriptInterface
    fun refreshWikiMeta(url: String) = callbacks.refreshWikiMeta(url)

    @JavascriptInterface
    fun pickPluginFolder() = callbacks.pickPluginFolder()

    @JavascriptInterface
    fun pickConfigFolder() = callbacks.pickConfigFolder()

    @JavascriptInterface
    fun exportSettings(json: String) = callbacks.exportSettings(json)

    @JavascriptInterface
    fun readConfigJson(): String = callbacks.readConfigJson()

    @JavascriptInterface
    fun saveWikiList(json: String) = callbacks.saveWikiList(json)

    @JavascriptInterface
    fun configFolderPath(): String = callbacks.configFolderPath()

    @JavascriptInterface
    fun openConfigFolder() = callbacks.openConfigFolder()

    @JavascriptInterface
    fun pickBackupFolder() = callbacks.pickBackupFolder()

    @JavascriptInterface
    fun backupFolderPath(): String = callbacks.backupFolderPath()

    @JavascriptInterface
    fun openBackupFolder() = callbacks.openBackupFolder()

    @JavascriptInterface
    fun hasPendingShare(): Boolean = callbacks.hasPendingShare()

    @JavascriptInterface
    fun getShareData(): String = callbacks.getShareData()

    @JavascriptInterface
    fun shareToWiki(url: String, title: String, isFolder: Boolean, backupsEnabled: Boolean, backupCount: Int, backupDir: String, tiddlersJson: String) =
        callbacks.shareToWiki(url, title, isFolder, backupsEnabled, backupCount, backupDir, tiddlersJson)

    @JavascriptInterface
    fun cancelShare() = callbacks.cancelShare()

    companion object {
        const val INTERFACE_NAME = "TDHost"
    }
}
