package com.tiddlywiki.tiddlydesktop

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service that keeps the :wiki process (and each open wiki's Node server) alive while
 * wikis are open. All open wikis share this one process, so this owns the whole notification set for
 * them and keeps it in sync with the open-wiki map on every change:
 *
 *   - the foreground-service notification (id 2001) is a GROUP SUMMARY ("Open wikis") — a labelled
 *     group so Android bundles the per-wiki notifications predictably instead of auto-grouping them;
 *   - one CHILD notification per open wiki (id derived from its path), each naming its wiki and
 *     tapping through to it;
 *   - closing/​swiping a wiki cancels exactly that child; the last close stops the service.
 *
 * The WikiList's own notification lives in the main process ([WikiListForegroundService], id 2002)
 * and is untouched by any of this.
 */
class WikiServerService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android requires startForeground() within ~5s of startForegroundService(), so promote first.
        ForegroundNotification.ensureChannel(this)
        val wikis = snapshot()
        val nm = NotificationManagerCompat.from(this)

        if (wikis.isEmpty()) {
            // No wiki open — only a warm-parked server may be holding the process. Show a DISTINCT
            // keep-alive notification (not one that looks like the WikiList), and stop if nothing's held.
            promote(ForegroundNotification.build(
                this, WikiServerService::class.java,
                getString(R.string.wiki_keepalive_title), getString(R.string.wiki_keepalive_text),
                ForegroundNotification.mainActivityIntent(this)))
            cancelAllChildren(nm)
            if (!warmHeld.get()) { demote(); stopSelf() }
            return START_NOT_STICKY
        }

        // Foreground-service notification = the group summary.
        promote(ForegroundNotification.build(
            this, WikiServerService::class.java,
            getString(R.string.wiki_group_title),
            resources.getQuantityString(R.plurals.wiki_group_count, wikis.size, wikis.size),
            ForegroundNotification.mainActivityIntent(this),
            group = ForegroundNotification.GROUP_WIKIS, groupSummary = true))

        // One child per open wiki; cancel children for wikis that are no longer open.
        val current = HashSet<Int>()
        for (w in wikis) {
            val ci = openWikiIntent(this, w) ?: continue
            val id = wikiNotifId(w.path)
            current.add(id)
            nm.notify(id, ForegroundNotification.buildWikiChild(
                this, w.title.ifBlank { getString(R.string.wiki_group_title) },
                getString(R.string.wiki_notification_running), ci, ForegroundNotification.GROUP_WIKIS))
        }
        synchronized(postedChildIds) {
            postedChildIds.filterNot { it in current }.forEach { nm.cancel(it) }
            postedChildIds.clear()
            postedChildIds.addAll(current)
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // onTaskRemoved fires on ALL of the app's started services for ANY removed task, so act only
        // when the removed task is actually a wiki (it carries EXTRA_WIKI_PATH) — otherwise swiping
        // the WikiList (or a child window) here would wrongly tear down open wikis.
        val path = rootIntent?.getStringExtra(WikiActivity.EXTRA_WIKI_PATH)
        if (!path.isNullOrEmpty()) {
            markSwiped(path) // WikiActivity.onDestroy will stop (not park) this wiki's server
            wikiClosed(this, path)
            // Swiped from the Overview = "done": drop the warm server so the service can stop.
            runCatching { com.tiddlywiki.tiddlydesktop.node.WarmNodeServers.clear(this) }
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        cancelAllChildren(NotificationManagerCompat.from(this))
        super.onDestroy()
    }

    private fun promote(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun demote() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(true)
    }

    private fun cancelAllChildren(nm: NotificationManagerCompat) {
        synchronized(postedChildIds) {
            postedChildIds.forEach { runCatching { nm.cancel(it) } }
            postedChildIds.clear()
        }
    }

    companion object {
        private const val NOTIFICATION_ID = 2001
        private const val WIKILIST_NOTIFICATION_ID = 2002

        /** Enough to name the notification and re-open (or bring to front) the wiki on tap. */
        private data class OpenWiki(
            val path: String, val title: String, val isFolder: Boolean,
            val backupsEnabled: Boolean, val backupCount: Int, val backupDir: String
        )

        // path -> info for every currently-open wiki (insertion order). One child notification each.
        private val openWikis = LinkedHashMap<String, OpenWiki>()
        // Child notification ids currently posted, so a state change can cancel the ones that closed.
        private val postedChildIds = Collections.synchronizedSet(HashSet<Int>())
        // True while WarmNodeServers holds a parked server — keeps :wiki alive so it isn't reaped.
        private val warmHeld = AtomicBoolean(false)
        // Wikis whose task was swiped from the Overview: WikiActivity.onDestroy stops (not parks) them.
        private val swipedPaths = Collections.synchronizedSet(HashSet<String>())

        fun wikiOpened(
            context: Context, wikiPath: String, wikiTitle: String, isFolder: Boolean,
            backupsEnabled: Boolean, backupCount: Int, backupDir: String
        ) {
            synchronized(openWikis) {
                openWikis[wikiPath] = OpenWiki(wikiPath, wikiTitle, isFolder, backupsEnabled, backupCount, backupDir)
            }
            swipedPaths.remove(wikiPath) // (re)opened, so it's no longer a pending swipe
            refresh(context)
        }

        fun wikiClosed(context: Context, wikiPath: String) {
            val removed = synchronized(openWikis) { openWikis.remove(wikiPath) != null }
            if (removed && wikiPath.isNotEmpty()) {
                val id = wikiNotifId(wikiPath)
                postedChildIds.remove(id)
                runCatching { NotificationManagerCompat.from(context).cancel(id) }
            }
            refresh(context)
        }

        /** WarmNodeServers → keep the process alive iff at least one server is parked warm. */
        fun setWarmHeld(context: Context, held: Boolean) {
            warmHeld.set(held)
            refresh(context)
        }

        /** True (once) if this wiki's task was swiped from the Overview — stop it instead of parking. */
        fun consumeSwiped(path: String): Boolean = swipedPaths.remove(path)
        private fun markSwiped(path: String) { swipedPaths.add(path) }

        private fun snapshot(): List<OpenWiki> = synchronized(openWikis) { ArrayList(openWikis.values) }

        /** Stable, distinct child-notification id per wiki, avoiding the summary (2001)/WikiList (2002) ids. */
        private fun wikiNotifId(path: String): Int =
            path.hashCode().let { if (it == NOTIFICATION_ID || it == WIKILIST_NOTIFICATION_ID) it + 3 else it }

        /** PendingIntent that opens (or brings to front) [w] via the OpenWikiActivity trampoline. */
        private fun openWikiIntent(context: Context, w: OpenWiki): PendingIntent? {
            if (w.path.isEmpty()) return null
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
            val intent = Intent(context, OpenWikiActivity::class.java).apply {
                putExtra(OpenWikiActivity.EXTRA_PATH, w.path)
                putExtra(OpenWikiActivity.EXTRA_TITLE, w.title)
                putExtra(OpenWikiActivity.EXTRA_IS_FOLDER, w.isFolder)
                putExtra(OpenWikiActivity.EXTRA_BACKUPS_ENABLED, w.backupsEnabled)
                putExtra(OpenWikiActivity.EXTRA_BACKUP_COUNT, w.backupCount)
                putExtra(OpenWikiActivity.EXTRA_BACKUP_DIR, w.backupDir)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // Distinct request code per wiki so their PendingIntents don't collide.
            return PendingIntent.getActivity(context, w.path.hashCode(), intent, flags)
        }

        private fun refresh(context: Context) {
            val active = synchronized(openWikis) { openWikis.isNotEmpty() } || warmHeld.get()
            if (active) {
                val intent = Intent(context, WikiServerService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
            } else {
                context.stopService(Intent(context, WikiServerService::class.java))
            }
        }
    }
}
