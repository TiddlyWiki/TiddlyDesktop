package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Timestamped backups of a single-file wiki's previous content. Shared by the saver
 * (SingleFileWikiServer) and the PluginChooser (PluginBridge), so both write to the same
 * `<wiki-filename>.backups/` folder next to the wiki (via the granted SAF tree), falling
 * back to app-private storage when no folder access was granted.
 */
object Backups {

    private const val TAG = "Backups"

    /** App-private file holding the user's chosen global backup folder (a SAF tree URI). */
    fun backupFolderUriFile(context: Context): File = File(context.filesDir, "backup-folder.uri")

    private fun globalBackupDir(context: Context): String? =
        backupFolderUriFile(context).takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }

    /**
     * [backupDirUri] is the wiki's own containing folder (backups land next to it). If the user
     * set a global backup folder, it takes precedence. [backupCount] <= 0 keeps them all.
     */
    fun write(context: Context, wikiPath: String, oldBytes: ByteArray, backupDirUri: String?, backupCount: Int) {
        val target = globalBackupDir(context) ?: backupDirUri
        if (!target.isNullOrBlank()) {
            // Direct filesystem path (the norm) writes next to the wiki; content:// is legacy SAF.
            val ok = if (target.startsWith("content://")) writeSaf(context, wikiPath, oldBytes, target, backupCount)
            else writeFileTree(context, wikiPath, oldBytes, target, backupCount)
            if (ok) return
        }
        writeAppPrivate(context, wikiPath, oldBytes, backupCount)
    }

    private fun writeFileTree(context: Context, wikiPath: String, oldBytes: ByteArray, folder: String, count: Int): Boolean =
        runCatching {
            val fileName = fileName(wikiPath); val base = baseName(fileName)
            val dir = File(folder, backupDirName(fileName)).apply { mkdirs() }
            File(dir, "$base-${ts()}.html").writeBytes(oldBytes)
            if (count > 0) {
                dir.listFiles { f -> f.name.startsWith("$base-") }
                    ?.sortedByDescending { it.lastModified() }?.drop(count)?.forEach { it.delete() }
            }
            Log.i(TAG, "Backed up ${oldBytes.size} bytes to $dir")
            true
        }.getOrElse { Log.w(TAG, "file backup failed: ${it.message}"); false }

    private fun writeSaf(context: Context, wikiPath: String, oldBytes: ByteArray, treeUri: String, count: Int): Boolean =
        runCatching {
            val fileName = fileName(wikiPath); val base = baseName(fileName)
            val root = DocumentFile.fromTreeUri(context, Uri.parse(treeUri)) ?: return false
            val dirName = backupDirName(fileName)
            val dir = root.findFile(dirName) ?: root.createDirectory(dirName) ?: return false
            val f = dir.createFile("text/html", "$base-${ts()}.html") ?: return false
            context.contentResolver.openOutputStream(f.uri, "wt")?.use { it.write(oldBytes) }
            if (count > 0) {
                dir.listFiles().filter { it.name?.startsWith("$base-") == true }
                    .sortedByDescending { it.lastModified() }.drop(count).forEach { it.delete() }
            }
            Log.i(TAG, "Backed up ${oldBytes.size} bytes to SAF $dirName/")
            true
        }.getOrElse { Log.w(TAG, "SAF backup failed: ${it.message}"); false }

    private fun writeAppPrivate(context: Context, wikiPath: String, oldBytes: ByteArray, count: Int) {
        val fileName = fileName(wikiPath); val base = baseName(fileName)
        val dir = File(File(context.filesDir, "backups"), md5(wikiPath)).apply { mkdirs() }
        File(dir, "$base-${ts()}.html").writeBytes(oldBytes)
        if (count > 0) {
            dir.listFiles { f -> f.name.startsWith("$base-") }
                ?.sortedByDescending { it.lastModified() }?.drop(count)?.forEach { it.delete() }
        }
        Log.i(TAG, "Backed up ${oldBytes.size} bytes to app storage")
    }

    private fun fileName(path: String): String =
        (Uri.parse(path).lastPathSegment ?: "wiki.html")
            .substringAfterLast('/').substringAfterLast(':').ifBlank { "wiki.html" }

    private fun baseName(fileName: String): String = fileName.substringBeforeLast('.').ifBlank { "wiki" }

    /** Backup folder name for a wiki file, e.g. "mywiki.html" -> "mywiki_backup". */
    fun backupDirName(fileName: String): String = "${baseName(fileName)}_backup"

    private fun ts(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    private fun md5(s: String): String =
        MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
