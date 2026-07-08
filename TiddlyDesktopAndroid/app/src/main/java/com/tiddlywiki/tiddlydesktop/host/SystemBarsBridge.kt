package com.tiddlywiki.tiddlydesktop.host

import android.app.Activity
import android.view.View
import android.webkit.JavascriptInterface

/**
 * `window.TDBars` — lets a wiki page report its palette so native can color the system
 * bars to match (see assets/bridge/system-bars.js). Added to both the WikiList and each
 * wiki window's WebView.
 */
class SystemBarsBridge(
    private val activity: Activity,
    private val root: View
) {
    @JavascriptInterface
    fun setSystemBarColors(background: String, foreground: String) {
        SystemBars.apply(activity, root, background, foreground)
    }

    companion object {
        const val INTERFACE_NAME = "TDBars"
        const val SCRIPT_ASSET = "bridge/system-bars.js"
    }
}
