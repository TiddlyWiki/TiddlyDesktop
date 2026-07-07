package com.tiddlywiki.tiddlydesktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Shared builder for the persistent, ongoing "keep the Node servers alive" notification, used by
 * both the main-process ([WikiListForegroundService]) and :wiki-process ([WikiServerService])
 * foreground services. Monochrome cat small-icon (like tiddlydesktop-rs), non-dismissible.
 */
object ForegroundNotification {

    const val CHANNEL_ID = "wiki_server_channel"
    /** Groups the :wiki process's per-wiki notifications under one expandable stack. */
    const val GROUP_WIKIS = "com.tiddlywiki.tiddlydesktop.wikis"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = context.getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.wiki_server_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                )
                channel.setShowBadge(false)
                mgr.createNotificationChannel(channel)
            }
        }
    }

    private fun piFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)

    /** Tap target for the WikiList (main-process) notification: bring the WikiList to front. */
    fun mainActivityIntent(context: Context): PendingIntent {
        val launch = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        return PendingIntent.getActivity(context, 0, launch, piFlags())
    }

    /**
     * Build the persistent notification. [contentTitle] + [contentIntent] differ per service so the
     * WikiList and each open wiki are distinguishable and tap to the right place (the WikiList vs the
     * corresponding wiki), rather than every notification looking identical and opening MainActivity.
     */
    fun build(
        context: Context, serviceClass: Class<*>, contentTitle: String, text: String,
        contentIntent: PendingIntent, group: String? = null, groupSummary: Boolean = false
    ): Notification {
        // Non-dismissible: Android 14+ lets users swipe away foreground-service notifications
        // (setOngoing no longer prevents it). The service is still running, so re-launch it on
        // dismissal to immediately re-post the notification — like Termux's persistent one.
        val reqCode = serviceClass.name.hashCode()
        val repost = Intent(context, serviceClass)
        val deleteIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            PendingIntent.getForegroundService(context, reqCode, repost, piFlags())
        else PendingIntent.getService(context, reqCode, repost, piFlags())
        val b = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(contentTitle)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_cat)
            .setContentIntent(contentIntent)
            .setDeleteIntent(deleteIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (group != null) { b.setGroup(group); if (groupSummary) b.setGroupSummary(true) }
        return b.build()
    }

    /**
     * A per-wiki child notification (grouped, not a foreground-service notification): names the wiki
     * and taps through to it. Ongoing so it reads as "this wiki is running".
     */
    fun buildWikiChild(context: Context, contentTitle: String, text: String, contentIntent: PendingIntent, group: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(contentTitle)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_cat)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setGroup(group)
            .build()
}
