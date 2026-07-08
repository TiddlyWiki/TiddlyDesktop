package com.tiddlywiki.tiddlydesktop.host

import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract

/**
 * Converts a SAF picker result (tree or document URI) into an absolute filesystem path so Node.js
 * can serve the wiki directly — no `content://` mirror. Only on-device volumes exposed by the
 * platform's external-storage document provider are resolvable; cloud/USB/network providers have no
 * filesystem path and return null (the caller rejects those).
 *
 *   content://com.android.externalstorage.documents/tree/primary%3ATiddlyWiki%2Fmywiki
 *       -> /storage/emulated/0/TiddlyWiki/mywiki
 *   content://…/document/ABCD-1234%3AFoo   ->  /storage/ABCD-1234/Foo   (SD card)
 *   …/document/raw%3A/storage/emulated/0/x ->  /storage/emulated/0/x    (already a raw path)
 */
object SafPaths {

    private const val EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents"

    /** Absolute path for [uri], or null if it isn't an on-device external-storage location. */
    fun toFilePath(uri: Uri): String? {
        if (uri.authority != EXTERNAL_STORAGE_AUTHORITY) return null
        val docId = runCatching {
            if (DocumentsContract.isTreeUri(uri)) DocumentsContract.getTreeDocumentId(uri)
            else DocumentsContract.getDocumentId(uri)
        }.getOrNull() ?: return null
        val parts = docId.split(":", limit = 2)
        val volume = parts[0]
        val rel = parts.getOrElse(1) { "" }
        // A "raw:" document id is already an absolute path.
        if (volume == "raw") return rel.ifBlank { null }
        val base = if (volume.equals("primary", ignoreCase = true))
            Environment.getExternalStorageDirectory().absolutePath
        else
            "/storage/$volume"
        return if (rel.isEmpty()) base else "$base/$rel"
    }

    /**
     * Inverse of [toFilePath]: an external-storage *document* URI for an absolute path, so a folder
     * can be handed to the system file manager (ACTION_VIEW). Null for paths outside `/storage`.
     */
    fun documentUri(path: String): Uri? {
        val primary = Environment.getExternalStorageDirectory().absolutePath
        val docId = when {
            path == primary -> "primary:"
            path.startsWith("$primary/") -> "primary:${path.removePrefix("$primary/")}"
            path.startsWith("/storage/") -> {
                val rest = path.removePrefix("/storage/")
                val slash = rest.indexOf('/')
                if (slash < 0) "$rest:" else "${rest.substring(0, slash)}:${rest.substring(slash + 1)}"
            }
            else -> return null
        }
        return runCatching {
            DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE_AUTHORITY, docId)
        }.getOrNull()
    }
}
