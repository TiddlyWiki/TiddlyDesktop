package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.security.MessageDigest

/**
 * M3: SAF folder-wiki mirroring.
 *
 * Node.js cannot read `content://` SAF trees, so a folder wiki selected via the SAF tree
 * picker is copied to a local directory that Node can serve, and changes are written back
 * to SAF on save. This is a first, simple implementation: a full copy in, and a
 * copy-back-on-demand.
 *
 * TODO: incremental / watched sync (only changed tiddler files), and conflict handling.
 * For now [copyIn] runs before the Node server starts; [copyBack] can be called after
 * saves (e.g. from a periodic timer or a save hook) to persist changes to SAF.
 */
object SafMirror {

    private const val TAG = "SafMirror"

    /** Local mirror dir for a given SAF tree URI: {filesDir}/wiki-mirrors/{hash}. */
    fun localDir(context: Context, treeUri: String): File {
        val hash = md5(treeUri)
        return File(File(context.filesDir, "wiki-mirrors"), hash)
    }

    /** Copy the SAF tree into a local dir Node can serve. Returns the local dir. */
    fun copyIn(context: Context, treeUri: String): File {
        val root = DocumentFile.fromTreeUri(context, Uri.parse(treeUri))
            ?: error("cannot open SAF tree: $treeUri")
        val dest = localDir(context, treeUri)
        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()
        copyTree(context, root, dest)
        Log.i(TAG, "Mirrored SAF folder wiki -> ${dest.absolutePath}")
        return dest
    }

    /**
     * Write files changed since [since] (epoch millis; 0 = everything) from the local mirror
     * back into the SAF tree, and delete SAF entries that no longer exist locally (so tiddler
     * deletions in the wiki propagate to the user's folder). Returns the timestamp to pass as
     * [since] next time.
     */
    fun copyBack(context: Context, treeUri: String, since: Long = 0L): Long {
        val now = System.currentTimeMillis()
        val root = DocumentFile.fromTreeUri(context, Uri.parse(treeUri)) ?: return now
        val src = localDir(context, treeUri)
        if (!src.exists()) return now
        val n = writeTree(context, src, root, since, prune = true)
        if (n > 0) Log.i(TAG, "Synced $n change(s) back to SAF: $treeUri")
        return now
    }

    private fun copyTree(context: Context, dir: DocumentFile, dest: File) {
        for (child in dir.listFiles()) {
            val name = child.name ?: continue
            val out = File(dest, name)
            if (child.isDirectory) {
                out.mkdirs()
                copyTree(context, child, out)
            } else {
                runCatching {
                    context.contentResolver.openInputStream(child.uri)?.use { input ->
                        out.outputStream().use { input.copyTo(it) }
                    }
                }.onFailure { Log.w(TAG, "copyIn failed for $name: ${it.message}") }
            }
        }
    }

    /** Copy a SAF tree's contents into a specific local dir (replacing it). */
    fun importTreeTo(context: Context, treeUri: String, dest: File): Boolean {
        val root = DocumentFile.fromTreeUri(context, Uri.parse(treeUri)) ?: return false
        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()
        return runCatching { copyTree(context, root, dest); true }
            .getOrElse { Log.e(TAG, "importTreeTo failed: ${it.message}"); false }
    }

    /** Write a local folder's contents into a SAF tree (for convert/clone destinations). */
    fun exportFolderToTree(context: Context, localFolder: File, destTreeUri: String): Boolean {
        val root = DocumentFile.fromTreeUri(context, Uri.parse(destTreeUri)) ?: return false
        return try { writeTree(context, localFolder, root, 0L, prune = false); true }
        catch (e: Exception) { Log.e(TAG, "exportFolderToTree failed: ${e.message}"); false }
    }

    /**
     * Reconcile [dir] (local) into [dest] (SAF): copy files changed since [since], and — when
     * [prune] — delete SAF entries with no local counterpart. Lists each SAF dir once (name ->
     * DocumentFile) so lookups + prune are O(n) instead of findFile's O(n²).
     */
    private fun writeTree(context: Context, dir: File, dest: DocumentFile, since: Long, prune: Boolean): Int {
        var count = 0
        val destByName = dest.listFiles().mapNotNull { c -> c.name?.let { it to c } }.toMap()
        val localNames = HashSet<String>()
        for (file in dir.listFiles() ?: return 0) {
            if (file.name.startsWith(".")) continue
            localNames.add(file.name)
            if (file.isDirectory) {
                val sub = destByName[file.name]?.takeIf { it.isDirectory }
                    ?: dest.createDirectory(file.name) ?: continue
                count += writeTree(context, file, sub, since, prune)
            } else {
                if (file.lastModified() < since) continue // unchanged since last sync
                val target = destByName[file.name] ?: createExactFile(dest, file.name)
                if (target == null) {
                    Log.w(TAG, "could not create SAF file ${file.name} in ${dest.uri}")
                    continue
                }
                runCatching {
                    context.contentResolver.openOutputStream(target.uri, "wt")?.use { os ->
                        file.inputStream().use { it.copyTo(os) }
                    }
                    count++
                }.onFailure { Log.w(TAG, "copyBack failed for ${file.name}: ${it.message}") }
            }
        }
        if (prune) {
            for ((name, child) in destByName) {
                if (name.startsWith(".") || name in localNames) continue
                runCatching { if (child.delete()) count++ }
                    .onFailure { Log.w(TAG, "prune failed for $name: ${it.message}") }
            }
        }
        return count
    }

    /**
     * Create a SAF file whose name is exactly [name]. SAF's createFile derives an extension from
     * the MIME type and, when the requested name's extension isn't one it recognises, can append
     * or alter it — e.g. "tiddlywiki.info" becoming "tiddlywiki.info.bin". A wiki folder is
     * unusable without a file called exactly "tiddlywiki.info", so we create with a neutral type
     * and, if the provider changed the name, rename it back. Returns null only if creation fails
     * outright.
     */
    private fun createExactFile(dir: DocumentFile, name: String): DocumentFile? {
        val created = dir.createFile("application/octet-stream", name) ?: return null
        if (created.name != name) {
            runCatching { created.renameTo(name) }
                .onFailure { Log.w(TAG, "renameTo($name) failed: ${it.message}") }
        }
        return created
    }

    private fun md5(s: String): String =
        MessageDigest.getInstance("MD5").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }
}
