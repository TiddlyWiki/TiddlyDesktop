package com.tiddlywiki.tiddlydesktop.host

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * All-Files-Access gate. TiddlyDesktop serves wiki files/folders straight off shared storage
 * (no SAF mirror), which on Android 11+ requires the "All files access" special permission
 * (MANAGE_EXTERNAL_STORAGE), granted by the user via a Settings toggle. On Android 10 and below
 * the equivalent is the WRITE_EXTERNAL_STORAGE runtime permission (+ requestLegacyExternalStorage
 * in the manifest).
 */
object StorageAccess {

    /** True when the app can read/write shared storage directly by path. */
    fun isGranted(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        }

    /**
     * Intent that opens the "All files access" toggle for this app (Android 11+). Falls back to
     * the app-details screen if the per-app screen is unavailable on the device.
     */
    fun settingsIntent(context: Context): Intent {
        val pkg = "package:${context.packageName}"
        return Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse(pkg))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
