package com.tiddlywiki.tiddlydesktop.host

import android.content.Context
import org.json.JSONArray

/**
 * Persists the wiki list (pushed from the WikiList JS via `TDHost.saveWikiList`) to
 * SharedPreferences, so the Quick Note widget/activity can offer a wiki chooser without
 * booting the WikiList Node server. Refreshed whenever the WikiList is open.
 */
object WikiListStore {
    private const val PREFS = "td_quicknote"
    private const val KEY = "wikilist"

    data class Wiki(
        val url: String,
        val title: String,
        val isFolder: Boolean,
        val backupsEnabled: Boolean,
        val backupCount: Int,
        val backupDir: String
    )

    fun save(context: Context, json: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
    }

    fun load(context: Context): List<Wiki> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]") ?: "[]"
        val out = ArrayList<Wiki>()
        runCatching {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val url = o.optString("url", "")
                if (url.isBlank()) continue
                out.add(
                    Wiki(
                        url = url,
                        title = o.optString("title", url).ifBlank { url },
                        isFolder = o.optBoolean("isFolder", false),
                        backupsEnabled = o.optBoolean("backupsEnabled", true),
                        backupCount = o.optInt("backupCount", 20),
                        backupDir = o.optString("backupDir", "")
                    )
                )
            }
        }
        return out
    }
}
