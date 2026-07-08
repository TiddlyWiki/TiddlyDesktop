package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.net.Uri
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Create / convert / clone operations for wikis, run via one-shot Node commands and SAF I/O.
 * All methods block and should be called off the UI thread.
 *
 * Ports the Node command patterns from TiddlyDesktop-RS (node_bridge.rs):
 *   file -> folder : tiddlywiki --load <file> --savewikifolder <folder>
 *   folder -> file : tiddlywiki <folder> --output <o> --render $:/core/save/all wiki.html text/plain
 *   template       : download the template URL (e.g. tiddlywiki.com/empty.html)
 */
object WikiOps {

    private const val TAG = "WikiOps"
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()

    /** Download a template/wiki URL into [destFileUri] (SAF). */
    fun cloneFromUrl(context: Context, url: String, destFileUri: String): Boolean {
        return try {
            http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                if (!resp.isSuccessful) { Log.e(TAG, "download $url -> HTTP ${resp.code}"); return false }
                val bytes = resp.body?.bytes() ?: return false
                writeBytes(context, destFileUri, bytes)
            }
        } catch (e: Exception) { Log.e(TAG, "cloneFromUrl failed: ${e.message}"); false }
    }

    /** Copy an existing single-file wiki ([sourcePath]: content:// or file) to [destFileUri]. */
    fun cloneFile(context: Context, sourcePath: String, destFileUri: String): Boolean {
        val bytes = readBytes(context, sourcePath) ?: return false
        return writeBytes(context, destFileUri, bytes)
    }

    /** Copy an existing folder wiki ([sourcePath]) into [destFolder] (both absolute paths). */
    fun cloneFolder(context: Context, sourcePath: String, destFolder: String): Boolean = try {
        val dest = File(destFolder).apply { mkdirs() }
        File(sourcePath).copyRecursively(dest, overwrite = true); true
    } catch (e: Exception) { Log.e(TAG, "cloneFolder failed: ${e.message}"); false }

    /** Convert a single-file wiki ([sourcePath]) into a folder wiki at [destFolder]. */
    fun fileToFolder(context: Context, sourcePath: String, destFolder: String): Boolean {
        val bytes = readBytes(context, sourcePath) ?: return false
        val work = File(NodeEnvironment.workDir(context), "f2f-${System.currentTimeMillis()}")
        val src = File(work, "source.html"); val out = File(work, "output")
        out.mkdirs(); src.parentFile?.mkdirs(); src.writeBytes(bytes)
        val code = NodeEnvironment.runNodeBlocking(context, listOf(
            "--load", src.absolutePath,
            "--deletetiddlers", "[prefix[\$:/temp/tiddlydesktop]]",
            "--savewikifolder", out.absolutePath
        ))
        var ok = code == 0 && File(out, "tiddlywiki.info").exists()
        if (ok) {
            ensureServerPlugins(File(out, "tiddlywiki.info"))
            // The conversion only counts as done if the folder (incl. tiddlywiki.info) actually
            // lands in the user's destination — otherwise the "wiki" they open is empty.
            ok = runCatching {
                out.copyRecursively(File(destFolder).apply { mkdirs() }, overwrite = true); true
            }.getOrElse { Log.e(TAG, "fileToFolder copy failed: ${it.message}"); false }
        }
        // Carry an external-attachments folder across the conversion (mirrors desktop convertWiki):
        // both wiki forms keep attachments in a sibling "attachments/" dir referenced relatively as
        // "./attachments/<name>", so the conversion just copies that directory — here from beside
        // the source .html into the new folder. On-device paths only (content:// has no fs parent).
        if (ok && !sourcePath.startsWith("content://")) {
            runCatching {
                val srcAttach = File(sourcePath).parentFile?.let { File(it, "attachments") }
                if (srcAttach != null && srcAttach.isDirectory)
                    srcAttach.copyRecursively(File(File(destFolder), "attachments"), overwrite = true)
            }.onFailure { Log.w(TAG, "fileToFolder attachments copy: ${it.message}") }
        }
        work.deleteRecursively()
        return ok
    }

    /** Convert a folder wiki ([sourcePath]) into a single file at [destFileUri]. */
    fun folderToFile(context: Context, sourcePath: String, destFileUri: String): Boolean {
        val local = File(sourcePath)
        val work = File(NodeEnvironment.workDir(context), "f2file-${System.currentTimeMillis()}")
        val out = File(work, "output"); out.mkdirs()
        val code = NodeEnvironment.runNodeBlocking(context, listOf(
            local.absolutePath, "--output", out.absolutePath,
            "--render", "\$:/core/save/all", "wiki.html", "text/plain"
        ))
        val result = File(out, "wiki.html")
        val ok = code == 0 && result.exists() && writeBytes(context, destFileUri, result.readBytes())
        // Carry the external-attachments folder across (mirrors desktop convertWiki): copy the
        // folder wiki's attachments/ next to the produced .html so its relative "./attachments/<name>"
        // references keep resolving. On-device destinations only (content:// has no fs parent).
        if (ok && !destFileUri.startsWith("content://")) {
            runCatching {
                val srcAttach = File(local, "attachments")
                val dstParent = File(destFileUri).parentFile
                if (srcAttach.isDirectory && dstParent != null)
                    srcAttach.copyRecursively(File(dstParent, "attachments"), overwrite = true)
            }.onFailure { Log.w(TAG, "folderToFile attachments copy: ${it.message}") }
        }
        work.deleteRecursively()
        return ok
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    private fun readBytes(context: Context, path: String): ByteArray? = try {
        if (path.startsWith("content://"))
            context.contentResolver.openInputStream(Uri.parse(path))?.use { it.readBytes() }
        else File(path).readBytes()
    } catch (e: Exception) { Log.e(TAG, "read $path failed: ${e.message}"); null }

    private fun writeBytes(context: Context, path: String, bytes: ByteArray): Boolean = try {
        val f = File(path); f.parentFile?.mkdirs(); f.writeBytes(bytes)
        true
    } catch (e: Exception) { Log.e(TAG, "write $path failed: ${e.message}"); false }

    /** Ensure a converted folder wiki has tiddlyweb + filesystem plugins so it serves properly. */
    private fun ensureServerPlugins(infoFile: File) {
        try {
            val info = JSONObject(infoFile.readText())
            val plugins = info.optJSONArray("plugins") ?: org.json.JSONArray().also { info.put("plugins", it) }
            val have = (0 until plugins.length()).map { plugins.getString(it) }.toSet()
            listOf("tiddlywiki/tiddlyweb", "tiddlywiki/filesystem").forEach {
                if (it !in have) plugins.put(it)
            }
            infoFile.writeText(info.toString(2))
        } catch (e: Exception) { Log.w(TAG, "ensureServerPlugins: ${e.message}") }
    }
}
