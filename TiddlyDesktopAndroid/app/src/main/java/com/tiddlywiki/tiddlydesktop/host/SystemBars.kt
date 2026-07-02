package com.tiddlywiki.tiddlydesktop.host

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.view.View
import androidx.core.view.WindowCompat

/**
 * Colors the status/navigation bars from a wiki's palette. The bar backgrounds are set to
 * the palette background; icons (which Android only renders light OR dark) are set to
 * whichever contrasts, since arbitrary foreground tinting isn't possible.
 *
 * Because the activities pad their content by the system-bar insets (edge-to-edge on
 * Android 15+), setting the root view's background color fills the inset strips — so the
 * bar areas take the palette background without needing separate colored views.
 */
object SystemBars {

    /** @param bgCss/[fgCss] CSS colors resolved by JS (e.g. "rgb(30,30,30)" or "#1e1e1e"). */
    fun apply(activity: Activity, root: View, bgCss: String, fgCss: String) {
        val bg = parseColor(bgCss) ?: return
        activity.runOnUiThread {
            root.setBackgroundColor(bg)
            val window = activity.window
            // Android 15+ draws a translucent scrim behind the (transparent) bars for
            // contrast, which keeps them looking dark. Disable it so our color shows.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT < 35) {
                window.statusBarColor = bg
                window.navigationBarColor = bg
            }
            // Light background -> dark icons, and vice-versa (the "contrast" fallback, since
            // Android can't tint bar icons to an arbitrary foreground color).
            val lightBars = isLight(bg)
            WindowCompat.getInsetsController(window, root).apply {
                isAppearanceLightStatusBars = lightBars
                isAppearanceLightNavigationBars = lightBars
            }
        }
    }

    private fun isLight(color: Int): Boolean {
        val r = Color.red(color); val g = Color.green(color); val b = Color.blue(color)
        val luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
        return luminance > 0.5
    }

    /** Parse "#rgb"/"#rrggbb"/"#rrggbbaa" or "rgb(...)"/"rgba(...)". */
    private fun parseColor(css: String): Int? {
        val c = css.trim()
        if (c.startsWith("rgb")) {
            val nums = c.substringAfter('(').substringBefore(')').split(',')
            if (nums.size < 3) return null
            return runCatching {
                val r = nums[0].trim().toFloat().toInt().coerceIn(0, 255)
                val g = nums[1].trim().toFloat().toInt().coerceIn(0, 255)
                val b = nums[2].trim().toFloat().toInt().coerceIn(0, 255)
                Color.rgb(r, g, b)
            }.getOrNull()
        }
        return runCatching { Color.parseColor(if (c.startsWith("#")) c else "#$c") }.getOrNull()
    }
}
