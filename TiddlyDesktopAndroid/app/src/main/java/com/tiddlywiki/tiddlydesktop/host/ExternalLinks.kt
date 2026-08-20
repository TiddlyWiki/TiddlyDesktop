package com.tiddlywiki.tiddlydesktop.host

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * The one place a wiki's link becomes a system Intent.
 *
 * Handing an arbitrary URI to ACTION_VIEW lets wiki script reach any app on the device that has
 * registered a scheme — deep links into other apps, the dialler, the SMS composer, vendor
 * schemes — with no interaction from the user at all. The desktop app restricts its equivalent
 * bridge for exactly this reason: an unrestricted one "would let wiki script launch local files
 * (file://), UNC paths, and any exotic scheme the OS has registered"
 * (source/js/utils/bridges.js).
 *
 * The allowlist is what a wiki legitimately links to. Notably absent:
 *
 *   file://           hands out local files, and throws FileUriExposedException anyway
 *   intent://         the general "start any component" scheme
 *   tiddlydesktop://  our own OAuth return, which only ever arrives FROM the system browser
 *                     (OAuthRedirectActivity) and is never navigated to from inside a wiki
 *   everything else   every scheme any installed app happens to have registered
 */
object ExternalLinks {

    private const val TAG = "ExternalLinks"

    private val ALLOWED = setOf("http", "https", "mailto", "tel")

    fun isAllowed(uri: Uri?): Boolean {
        val scheme = uri?.scheme?.lowercase() ?: return false
        return scheme in ALLOWED
    }

    /**
     * Open [uri] outside the app, if its scheme is allowed. Returns false when refused or when no
     * app can handle it — callers treat both as "handled", so a refused link simply does nothing
     * rather than falling through to the WebView.
     */
    fun open(context: Context, uri: Uri?): Boolean {
        if (!isAllowed(uri)) {
            Log.w(TAG, "refused a link with a disallowed scheme: $uri")
            return false
        }
        return runCatching {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            true
        }.getOrElse {
            Log.w(TAG, "could not open $uri: ${it.message}")
            false
        }
    }
}
