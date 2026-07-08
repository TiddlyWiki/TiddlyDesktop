package com.tiddlywiki.tiddlydesktop

import android.app.Activity
import android.os.Bundle
import com.tiddlywiki.tiddlydesktop.host.WikiLauncher

/**
 * Invisible trampoline: the :wiki foreground-service notification points here so tapping it opens
 * (or brings to front) the corresponding wiki via [WikiLauncher] — instead of the WikiList
 * (MainActivity). Runs in the main process, has no UI, and finishes immediately, so there's no
 * flash of the WikiList. WikiLauncher reuses the wiki's existing document task when it's still open,
 * or recreates it from the passed extras if it was reaped.
 */
class OpenWikiActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val path = intent.getStringExtra(EXTRA_PATH)
        if (!path.isNullOrEmpty()) {
            WikiLauncher.open(
                this, path,
                intent.getStringExtra(EXTRA_TITLE) ?: "Wiki",
                intent.getBooleanExtra(EXTRA_IS_FOLDER, false),
                intent.getBooleanExtra(EXTRA_BACKUPS_ENABLED, true),
                intent.getIntExtra(EXTRA_BACKUP_COUNT, 20),
                intent.getStringExtra(EXTRA_BACKUP_DIR) ?: ""
            )
        }
        finish()
    }

    companion object {
        const val EXTRA_PATH = "path"
        const val EXTRA_TITLE = "title"
        const val EXTRA_IS_FOLDER = "is_folder"
        const val EXTRA_BACKUPS_ENABLED = "backups_enabled"
        const val EXTRA_BACKUP_COUNT = "backup_count"
        const val EXTRA_BACKUP_DIR = "backup_dir"
    }
}
