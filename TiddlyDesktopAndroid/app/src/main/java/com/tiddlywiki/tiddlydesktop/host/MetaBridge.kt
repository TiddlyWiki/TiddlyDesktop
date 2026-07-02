package com.tiddlywiki.tiddlydesktop.host

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface

/**
 * `window.TDMeta` — added to each wiki window's WebView. The wiki pushes its live
 * SiteTitle / SiteSubtitle / favicon here (see assets/bridge/meta-push.js); we forward
 * them to the WikiList (main process) via an app-internal broadcast so the row updates
 * instantly, with no file reads.
 */
class MetaBridge(
    private val context: Context,
    private val wikiUrl: String
) {
    @JavascriptInterface
    fun setMeta(title: String, subtitle: String, favicon: String) {
        // Keep the broadcast payload well under the Binder transaction limit; a huge favicon
        // is dropped here and picked up instead by the WikiList's file-read refresh.
        val fav = if (favicon.length <= MAX_FAVICON) favicon else ""
        context.sendBroadcast(Intent(ACTION_WIKI_META).apply {
            setPackage(context.packageName)
            putExtra("url", wikiUrl)
            putExtra("title", title)
            putExtra("subtitle", subtitle)
            putExtra("favicon", fav)
        })
    }

    companion object {
        const val INTERFACE_NAME = "TDMeta"
        const val SCRIPT_ASSET = "bridge/meta-push.js"
        const val ACTION_WIKI_META = "com.tiddlywiki.tiddlydesktop.ACTION_WIKI_META"
        private const val MAX_FAVICON = 400_000
    }
}
