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

    fun build(context: Context, serviceClass: Class<*>, text: String): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        // Tapping it returns to the WikiList.
        val launch = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentIntent = PendingIntent.getActivity(context, 0, launch, flags)
        // Non-dismissible: Android 14+ lets users swipe away foreground-service notifications
        // (setOngoing no longer prevents it). The service is still running, so re-launch it on
        // dismissal to immediately re-post the notification — like Termux's persistent one.
        val reqCode = serviceClass.name.hashCode()
        val repost = Intent(context, serviceClass)
        val deleteIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            PendingIntent.getForegroundService(context, reqCode, repost, flags)
        else PendingIntent.getService(context, reqCode, repost, flags)
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(context.getString(R.string.wiki_server_notification_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_cat)
            .setContentIntent(contentIntent)
            .setDeleteIntent(deleteIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
