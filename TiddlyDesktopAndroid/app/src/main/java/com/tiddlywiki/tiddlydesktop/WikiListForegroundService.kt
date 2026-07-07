package com.tiddlywiki.tiddlydesktop

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service for the MAIN process — keeps the WikiList's Node server (127.0.0.1:38000)
 * alive while the WikiList is open, even in the background, so it isn't reaped and connections /
 * unsaved data aren't lost. The :wiki-process equivalent is [WikiServerService]; both show the
 * shared persistent cat notification via [ForegroundNotification].
 */
class WikiListForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Promote to foreground within the ~5s window Android allows, then bail if no longer needed.
        ForegroundNotification.ensureChannel(this)
        val notif: Notification = ForegroundNotification.build(
            this, WikiListForegroundService::class.java,
            getString(R.string.wiki_server_notification_title),
            getString(R.string.wiki_server_notification_text),
            ForegroundNotification.mainActivityIntent(this))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }
        if (!active.get()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // onTaskRemoved fires on ALL of the app's started services for ANY removed task. Only stop
        // when the WikiList's OWN task is swiped — a wiki task carries EXTRA_WIKI_PATH; the WikiList
        // task doesn't. Otherwise swiping a wiki would wrongly kill the WikiList notification.
        val isWikiTask = rootIntent?.hasExtra(WikiActivity.EXTRA_WIKI_PATH) == true
        if (!isWikiTask) {
            active.set(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        private const val NOTIFICATION_ID = 2002
        private val active = AtomicBoolean(false)

        /** WikiList came up — keep the main process alive. */
        fun start(context: Context) { active.set(true); refresh(context) }

        /** WikiList closed — release. */
        fun stop(context: Context) { active.set(false); refresh(context) }

        private fun refresh(context: Context) {
            if (active.get()) {
                val intent = Intent(context, WikiListForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
            } else {
                context.stopService(Intent(context, WikiListForegroundService::class.java))
            }
        }
    }
}
