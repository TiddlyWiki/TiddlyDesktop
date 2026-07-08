package com.tiddlywiki.tiddlydesktop

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * Home-screen "Quick note" widget. A widget's RemoteViews can't host an editable text field, so the
 * tile just launches [QuickNoteActivity] (a dialog with the wiki chooser + note box + Done).
 */
class QuickNoteWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val intent = Intent(context, QuickNoteActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        val pending = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val views = RemoteViews(context.packageName, R.layout.widget_quick_note).apply {
            setOnClickPendingIntent(R.id.quicknote_widget_root, pending)
        }
        appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
    }
}
