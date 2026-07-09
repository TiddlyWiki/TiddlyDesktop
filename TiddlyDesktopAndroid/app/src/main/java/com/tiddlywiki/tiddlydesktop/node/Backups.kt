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

    // Default backup-path template — MUST match the desktop app's $:/TiddlyDesktop/BackupPath
    // default (plugins/tiddlydesktop/config/BackupPath.tid) so both platforms lay backups out the
    // same way. $filename$ expands to the wiki's full filename WITH extension, so this yields
    // "<wiki>.html_backup/" — e.g. "mywiki.html_backup/", not "mywiki_backup/".
    private const val DEFAULT_TEMPLATE = "./\$filename\$_backup/"

    /** App-private file holding the user's chosen global backup folder (a SAF tree URI). */
    fun backupFolderUriFile(context: Context): File = File(context.filesDir, "backup-folder.uri")

    /**
     * App-private file holding the backup-path template ($:/TiddlyDesktop/BackupPath), reported by
     * the WikiList JS via TDHost.setBackupPathTemplate (see MainActivity). Absent => the desktop
     * default above. Persisting it app-wide (like backup-folder.uri) means the :wiki process's
     * saver reads the current value without threading it through every open-wiki intent.
     */
    fun backupPathTemplateFile(context: Context): File = File(context.filesDir, "backup-path-template.txt")

    private fun globalBackupDir(context: Context): String? =
        backupFolderUriFile(context).takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }

    private fun template(context: Context): String =
        backupPathTemplateFile(context).takeIf { it.exists() }?.readText()?.trim()?.ifBlank { null }
            ?: DEFAULT_TEMPLATE

    /**
     * [backupDirUri] is the wiki's own containing folder (backups land next to it). If the user
     * set a global backup folder, it takes precedence. [backupCount] <= 0 keeps them all.
     */
    fun write(context: Context, wikiPath: String, oldBytes: ByteArray, backupDirUri: String?, backupCount: Int) {
        val fileName = fileName(wikiPath); val base = baseName(fileName)
        // An absolute template (e.g. "/storage/emulated/0/mybackups") is honoured as a direct
        // filesystem path, bypassing the wiki's containing folder / SAF tree / app-private base
        // (mirrors desktop, where path.resolve() returns an absolute template unchanged). If the
        // path isn't writable we fall through to app-private storage.
        val absDir = absoluteBackupDir(context, fileName, wikiPath)
        if (absDir != null) {
            if (writeIntoDir(File(absDir), base, oldBytes, backupCount)) return
        } else {
            val target = globalBackupDir(context) ?: backupDirUri
            if (!target.isNullOrBlank()) {
                // Direct filesystem path (the norm) writes next to the wiki; content:// is legacy SAF.
                val ok = if (target.startsWith("content://")) writeSaf(context, wikiPath, oldBytes, target, backupCount)
                else writeFileTree(context, wikiPath, oldBytes, target, backupCount)
                if (ok) return
            }
        }
        writeAppPrivate(context, wikiPath, oldBytes, backupCount)
    }

    /** Write one timestamped backup into [dir], creating it and pruning to [count] (<=0 keeps all). */
    private fun writeIntoDir(dir: File, base: String, oldBytes: ByteArray, count: Int): Boolean =
        runCatching {
            dir.mkdirs()
            File(dir, "$base-${ts()}.html").writeBytes(oldBytes)
            if (count > 0) {
                dir.listFiles { f -> f.name.startsWith("$base-") }
                    ?.sortedByDescending { it.lastModified() }?.drop(count)?.forEach { it.delete() }
            }
            Log.i(TAG, "Backed up ${oldBytes.size} bytes to $dir")
            true
        }.getOrElse { Log.w(TAG, "file backup failed: ${it.message}"); false }

    private fun writeFileTree(context: Context, wikiPath: String, oldBytes: ByteArray, folder: String, count: Int): Boolean {
        val fileName = fileName(wikiPath); val base = baseName(fileName)
        return writeIntoDir(File(folder, backupSubPath(context, fileName, wikiPath)), base, oldBytes, count)
    }

    private fun writeSaf(context: Context, wikiPath: String, oldBytes: ByteArray, treeUri: String, count: Int): Boolean =
        runCatching {
            val fileName = fileName(wikiPath); val base = baseName(fileName)
            val root = DocumentFile.fromTreeUri(context, Uri.parse(treeUri)) ?: return false
            val subPath = backupSubPath(context, fileName, wikiPath)
            val dir = ensureSafDir(root, subPath) ?: return false
            val f = dir.createFile("text/html", "$base-${ts()}.html") ?: return false
            context.contentResolver.openOutputStream(f.uri, "wt")?.use { it.write(oldBytes) }
            if (count > 0) {
                dir.listFiles().filter { it.name?.startsWith("$base-") == true }
                    .sortedByDescending { it.lastModified() }.drop(count).forEach { it.delete() }
            }
            Log.i(TAG, "Backed up ${oldBytes.size} bytes to SAF $subPath/")
            true
        }.getOrElse { Log.w(TAG, "SAF backup failed: ${it.message}"); false }

    private fun writeAppPrivate(context: Context, wikiPath: String, oldBytes: ByteArray, count: Int) {
        val fileName = fileName(wikiPath); val base = baseName(fileName)
        val subPath = backupSubPath(context, fileName, wikiPath)
        writeIntoDir(File(File(File(context.filesDir, "backups"), md5(wikiPath)), subPath), base, oldBytes, count)
    }

    private fun fileName(path: String): String =
        (Uri.parse(path).lastPathSegment ?: "wiki.html")
            .substringAfterLast('/').substringAfterLast(':').ifBlank { "wiki.html" }

    private fun baseName(fileName: String): String = fileName.substringBeforeLast('.').ifBlank { "wiki" }

    /**
     * The backup directory for a wiki, RELATIVE to the target base folder, derived from the
     * template ($:/TiddlyDesktop/BackupPath). Mirrors the desktop app (utils/saving.js
     * backupPathByPath): $filename$ -> the wiki's full filename WITH extension (e.g. "wiki.html"),
     * $filepath$ -> its full path. Supports arbitrary/nested templates like
     * "./test/$filename$123_backup/". Returns a forward-slash sub-path with no leading "./" or "/"
     * and no trailing "/". Public so "reveal backups" (MainActivity) resolves the identical folder.
     */
    fun backupSubPath(context: Context, fileName: String, wikiPath: String): String {
        var s = substitutedTemplate(context, fileName, wikiPath)
        // The template is resolved relative to the target base folder, so drop a leading "./" or
        // "/" and any trailing slash. Blank (a template of just "./") falls back to the default.
        if (s.startsWith("./")) s = s.substring(2)
        s = s.trimStart('/').trimEnd('/')
        return s.ifBlank { "${fileName}_backup" }
    }

    /** The backup-path template with $filename$/$filepath$ substituted, slashes normalised. */
    private fun substitutedTemplate(context: Context, fileName: String, wikiPath: String): String =
        template(context)
            .replace("\$filename\$", fileName, ignoreCase = true)
            .replace("\$filepath\$", wikiPath, ignoreCase = true)
            .replace('\\', '/')
            .trim()

    /**
     * If the substituted template is an ABSOLUTE filesystem path (starts with "/"), return it with
     * any trailing slash trimmed; otherwise null (a relative template nests under a base folder as
     * a [backupSubPath]). Public so "reveal backups" (MainActivity) resolves the identical folder.
     */
    fun absoluteBackupDir(context: Context, fileName: String, wikiPath: String): String? {
        val s = substitutedTemplate(context, fileName, wikiPath)
        return if (s.startsWith("/")) s.trimEnd('/').ifBlank { null } else null
    }

    /** Create (or find) a possibly-nested sub-directory under a SAF tree, segment by segment. */
    private fun ensureSafDir(root: DocumentFile, subPath: String): DocumentFile? {
        var dir = root
        for (seg in subPath.split('/')) {
            if (seg.isBlank()) continue
            dir = dir.findFile(seg)?.takeIf { it.isDirectory } ?: dir.createDirectory(seg) ?: return null
        }
        return dir
    }

    private fun ts(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    private fun md5(s: String): String =
        MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
