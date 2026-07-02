package com.tiddlywiki.tiddlydesktop

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.tiddlywiki.tiddlydesktop.host.WikiLauncher
import java.io.File

/**
 * Handles the `tiddlydesktop://` OAuth return (collab sign-in). The system browser, after the
 * relay's post-login redirect, navigates to tiddlydesktop://… which launches this (invisible)
 * activity. The OAuth token itself is finalised by the plugin's relay result-polling — this
 * deep link's only job is to bring the wiki window that started sign-in back to front, so its
 * paused WebView resumes and the poll completes (mirrors the desktop deeplink.js behaviour).
 */
class OAuthRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val origin = runCatching {
            File(filesDir, "collab-oauth-origin").takeIf { it.exists() }?.readText()?.trim()
        }.getOrNull()
        val focused = !origin.isNullOrBlank() && runCatching { WikiLauncher.bringToFront(this, origin) }.getOrDefault(false)
        if (!focused) {
            // Cold start / wiki closed: at least bring the app up.
            runCatching { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        finish()
    }
}
