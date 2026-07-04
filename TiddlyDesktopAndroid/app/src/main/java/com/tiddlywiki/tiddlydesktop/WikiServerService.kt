package com.tiddlywiki.tiddlydesktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground service that keeps the :wiki process (and the WikiList/Node servers) alive
 * while wikis are open, so Android is far less likely to kill them in the background.
 *
 * Uses an in-memory count (not SharedPreferences) since it shares the process with the
 * activities; START_NOT_STICKY avoids orphan notifications after a process death.
 */
class WikiServerService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started via startForegroundService(): Android requires startForeground() within ~5s or it
        // kills the process (ForegroundServiceDidNotStartInTimeException). So ALWAYS promote to
        // foreground first — even if we're about to stop — then bail if there's nothing to keep alive.
        ensureChannel(this)
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.wiki_server_notification_title))
            .setContentText(getString(R.string.wiki_server_notification_text))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }
        // Nothing to keep alive (no open wikis AND no parked warm server) → drop notification, stop.
        if (activeCount.get() <= 0 && !warmHeld.get()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL_ID = "wiki_server_channel"
        private const val NOTIFICATION_ID = 2001

        // WikiList + each open wiki bump this; the service stops at zero (and no warm server held).
        private val activeCount = AtomicInteger(0)
        // True while WarmNodeServers holds a parked server — keeps :wiki alive so it isn't reaped
        // (which would kill the warm servers). See node/WarmNodeServers.kt (#3).
        private val warmHeld = java.util.concurrent.atomic.AtomicBoolean(false)

        /** Called by MainActivity when the WikiList comes up. */
        fun start(context: Context) = bump(context, +1)
        fun wikiListClosed(context: Context) = bump(context, -1)
        fun wikiOpened(context: Context, wikiKey: String, wikiTitle: String) = bump(context, +1)
        fun wikiClosed(context: Context, wikiKey: String) = bump(context, -1)

        /** WarmNodeServers → keep the process alive iff at least one server is parked warm. */
        fun setWarmHeld(context: Context, held: Boolean) {
            warmHeld.set(held)
            refresh(context)
        }

        private fun bump(context: Context, delta: Int) {
            activeCount.addAndGet(delta).coerceAtLeast(0)
            refresh(context)
        }

        private fun refresh(context: Context) {
            if (activeCount.get() > 0 || warmHeld.get()) {
                val intent = Intent(context, WikiServerService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } else {
                context.stopService(Intent(context, WikiServerService::class.java))
            }
        }

        private fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val mgr = context.getSystemService(NotificationManager::class.java)
                if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                    mgr.createNotificationChannel(
                        NotificationChannel(
                            CHANNEL_ID,
                            context.getString(R.string.wiki_server_channel_name),
                            NotificationManager.IMPORTANCE_LOW
                        )
                    )
                }
            }
        }
    }
}
