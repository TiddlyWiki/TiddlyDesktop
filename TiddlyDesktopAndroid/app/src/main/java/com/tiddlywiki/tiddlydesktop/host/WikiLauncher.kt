package com.tiddlywiki.tiddlydesktop.host

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.tiddlywiki.tiddlydesktop.WikiActivity

/**
 * Launches a wiki into its own document task, reusing an already-open task if the same
 * wiki is open (mirrors RS's bring-to-front behaviour).
 *
 * Each WikiActivity task is tagged with a synthetic `tdwiki://<encoded-key>` data URI so
 * it can be found later by scanning ActivityManager.appTasks (app-wide, across the :wiki
 * process). The real path/title/isFolder ride in extras.
 */
object WikiLauncher {

    private const val TAG = "WikiLauncher"

    /** Open a wiki by its resolved path (content:// or filesystem). */
    fun open(
        context: Context, path: String, title: String, isFolder: Boolean,
        backupsEnabled: Boolean = true, backupCount: Int = 20, backupDir: String = "",
        sharePayload: String? = null
    ) {
        launch(context, key = path, extras = { i ->
            i.putExtra(WikiActivity.EXTRA_WIKI_PATH, path)
            i.putExtra(WikiActivity.EXTRA_WIKI_TITLE, title)
            i.putExtra(WikiActivity.EXTRA_IS_FOLDER, isFolder)
            i.putExtra(WikiActivity.EXTRA_BACKUPS_ENABLED, backupsEnabled)
            i.putExtra(WikiActivity.EXTRA_BACKUP_COUNT, backupCount)
            if (backupDir.isNotEmpty()) i.putExtra(WikiActivity.EXTRA_BACKUP_DIR, backupDir)
            if (!sharePayload.isNullOrEmpty()) i.putExtra(WikiActivity.EXTRA_SHARE_PAYLOAD, sharePayload)
        })
    }

    /**
     * Open a view onto an already-running Node server (used for the WikiList backstage:
     * a second synced client of the same server). No new server is started.
     */
    fun openServerUrl(context: Context, serverUrl: String, title: String) {
        launch(context, key = "server:$serverUrl", extras = { i ->
            i.putExtra(WikiActivity.EXTRA_SERVER_URL, serverUrl)
            i.putExtra(WikiActivity.EXTRA_WIKI_TITLE, title)
            i.putExtra(WikiActivity.EXTRA_IS_FOLDER, true)
        })
    }

    /**
     * Open a single-tiddler window (tm-open-window) as its own task in the :wiki process,
     * pointed at the parent wiki's already-running server. Reopening the same tiddler focuses
     * the existing window (bring-to-front), mirroring TiddlyWiki's window behaviour.
     */
    fun openChildWindow(
        context: Context, serverUrl: String, title: String,
        wikiPath: String, isFolder: Boolean, backupDir: String
    ) {
        launch(context, key = "window:$serverUrl#$title", extras = { i ->
            i.putExtra(WikiActivity.EXTRA_SERVER_URL, serverUrl)
            i.putExtra(WikiActivity.EXTRA_FOCUS_TIDDLER, title)
            i.putExtra(WikiActivity.EXTRA_WIKI_PATH, wikiPath)
            i.putExtra(WikiActivity.EXTRA_IS_FOLDER, isFolder)
            i.putExtra(WikiActivity.EXTRA_WIKI_TITLE, title)
            if (backupDir.isNotEmpty()) i.putExtra(WikiActivity.EXTRA_BACKUP_DIR, backupDir)
        })
    }

    /** Close all tm-open-window child windows viewing [serverUrl] (their owner server is going away). */
    fun closeChildWindows(context: Context, serverUrl: String) {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        for (task in am.appTasks) {
            val base = runCatching { task.taskInfo.baseIntent }.getOrNull() ?: continue
            if (base.getStringExtra(WikiActivity.EXTRA_SERVER_URL) == serverUrl &&
                base.getStringExtra(WikiActivity.EXTRA_FOCUS_TIDDLER) != null) {
                runCatching { task.finishAndRemoveTask() }
            }
        }
    }

    /** Bring an already-open wiki task ([key] = its path) to the front. Returns false if not open. */
    fun bringToFront(context: Context, key: String): Boolean {
        val dataUri = Uri.parse("tdwiki://" + Uri.encode(key))
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        for (task in am.appTasks) {
            if (runCatching { task.taskInfo.baseIntent.data }.getOrNull() == dataUri) {
                return runCatching { task.moveToFront(); true }.getOrDefault(false)
            }
        }
        return false
    }

    private fun launch(context: Context, key: String, extras: (Intent) -> Unit) {
        val dataUri = Uri.parse("tdwiki://" + Uri.encode(key))

        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        for (task in am.appTasks) {
            val base = runCatching { task.taskInfo.baseIntent }.getOrNull()
            if (base?.data == dataUri) {
                Log.d(TAG, "Bringing existing wiki task to front: $key")
                runCatching { task.moveToFront() }
                return
            }
        }

        val intent = Intent(context, WikiActivity::class.java).apply {
            data = dataUri
            extras(this)
            addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
