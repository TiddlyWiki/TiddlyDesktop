package com.tiddlywiki.tiddlydesktop.server

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import com.tiddlywiki.tiddlydesktop.node.Backups
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPOutputStream

/**
 * A minimal loopback HTTP server for a single-file TiddlyWiki, so viewing and saving need
 * no Node.js. Modelled on TiddlyDesktop-RS's WikiHttpServer (single-file path).
 *
 * How saving works: we serve the wiki over http://127.0.0.1 and advertise `Dav`/`Allow: PUT`
 * on OPTIONS, which makes TiddlyWiki's built-in `put` saver activate and PUT the whole
 * document back to `/`. We stream that body to the wiki file. No custom saver is injected.
 *
 * The wiki path may be a `content://` SAF URI or a plain filesystem path.
 *
 * Not yet handled (TODO): serving external-attachment relative files (`/_relative/...`),
 * HTTP Range requests for large media, and SAF backups. Single-file wikis with only
 * embedded (data:) content work fully.
 */
class SingleFileWikiServer(
    private val context: Context,
    private val wikiPath: String,
    private val backupsEnabled: Boolean = true,
    private val backupCount: Int = 20,
    /** SAF tree of the wiki's containing folder; when set, backups go to its .backups/ dir. */
    private val backupDirUri: String? = null,
    private val port: Int = allocatePort()
) {
    private val uri: Uri = Uri.parse(wikiPath)
    private val isContent: Boolean = wikiPath.startsWith("content://")

    private var serverSocket: ServerSocket? = null
    private val running = AtomicBoolean(false)
    private val workers = Executors.newCachedThreadPool()

    // Cheap same-origin guard: any app can reach 127.0.0.1, so gate writes behind a
    // random token handed to the page as an HttpOnly cookie on the initial GET.
    private val sessionToken: String = randomToken()
    private val cookieName = "_tdwiki_$port"

    val url: String get() = "http://127.0.0.1:$port/"
    fun isRunning(): Boolean = running.get()

    fun start(): String {
        val sock = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
        serverSocket = sock
        running.set(true)
        Thread {
            while (running.get()) {
                val client = try {
                    sock.accept()
                } catch (_: Exception) {
                    break
                }
                workers.submit { handleConnection(client) }
            }
        }.apply { name = "SingleFileWiki-$port"; isDaemon = true; start() }
        Log.i(TAG, "Serving single-file wiki at $url ($wikiPath)")
        return url
    }

    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: Exception) {}
        workers.shutdownNow()
    }

    // ── connection handling ─────────────────────────────────────────────────────

    private fun handleConnection(socket: Socket) {
        try {
            socket.use { s ->
                s.tcpNoDelay = true
                s.soTimeout = 30_000
                val input = BufferedInputStream(s.getInputStream(), 8192)
                val output = BufferedOutputStream(s.getOutputStream(), 1 shl 16)

                val headerText = readHeaders(input) ?: return
                val lines = headerText.split("\r\n")
                val requestLine = lines.firstOrNull()?.split(" ") ?: return
                if (requestLine.size < 2) { sendError(output, 400, "Bad Request"); return }
                val method = requestLine[0]
                val path = requestLine[1].substringBefore('?')

                val headers = HashMap<String, String>()
                for (i in 1 until lines.size) {
                    val line = lines[i]
                    val c = line.indexOf(':')
                    if (c > 0) headers[line.substring(0, c).trim().lowercase()] =
                        line.substring(c + 1).trim()
                }

                // Public routes: initial load (GET/HEAD /) and the saver's OPTIONS probe.
                val isPublic = (method == "GET" && path == "/") ||
                    (method == "HEAD" && path == "/") || method == "OPTIONS"
                if (!isPublic && !hasValidCookie(headers)) {
                    sendError(output, 403, "Forbidden"); return
                }

                when {
                    method == "GET" && path == "/" -> serveWiki(output, headers)
                    method == "HEAD" && path == "/" -> sendSimple(output, 200, "OK")
                    method == "OPTIONS" -> serveOptions(output)
                    method == "PUT" && path == "/" -> saveWiki(input, output, headers)
                    method == "GET" && path == "/_source" -> serveRawSource(output)
                    (method == "GET" || method == "HEAD") && path.startsWith("/attachments/") ->
                        serveAttachment(output, Uri.decode(path.removePrefix("/attachments/")), headers, method == "HEAD")
                    else -> sendError(output, 404, "Not Found")
                }
                output.flush()
            }
        } catch (_: java.net.SocketException) {
            // client went away — normal
        } catch (e: Exception) {
            Log.e(TAG, "connection error: ${e.message}", e)
        }
    }

    /** Read up to and including the blank line that ends the request headers. */
    private fun readHeaders(input: InputStream): String? {
        val buf = ByteArrayOutputStream(1024)
        var state = 0 // matches \r\n\r\n
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString(Charsets.UTF_8.name())
            buf.write(b)
            state = when {
                b == '\r'.code && (state == 0 || state == 2) -> state + 1
                b == '\n'.code && state == 1 -> 2
                b == '\n'.code && state == 3 -> return buf.toString(Charsets.UTF_8.name())
                else -> 0
            }
        }
    }

    // ── routes ──────────────────────────────────────────────────────────────────

    private fun serveWiki(output: OutputStream, reqHeaders: Map<String, String>) {
        val wikiBytes = readWikiBytes()

        // Inject minimal media-controls CSS right after <head>. Kept ephemeral (never
        // saved — TiddlyWiki rebuilds its HTML from the tiddler store, not the DOM).
        val headIdx = indexOfTag(wikiBytes, "<head>")
        val injection = if (headIdx >= 0) MEDIA_CSS.toByteArray(Charsets.UTF_8) else ByteArray(0)
        val insertPos = if (headIdx >= 0) headIdx + 6 else -1

        val acceptsGzip = reqHeaders["accept-encoding"]?.contains("gzip") == true
        val setCookie = "Set-Cookie: $cookieName=$sessionToken; Path=/; HttpOnly; SameSite=Strict"

        if (acceptsGzip) {
            val body = ByteArrayOutputStream(wikiBytes.size / 4)
            GZIPOutputStream(body).use { gz ->
                if (insertPos >= 0) {
                    gz.write(wikiBytes, 0, insertPos)
                    gz.write(injection)
                    gz.write(wikiBytes, insertPos, wikiBytes.size - insertPos)
                } else gz.write(wikiBytes)
            }
            val gzipped = body.toByteArray()
            output.write((
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/html; charset=utf-8\r\n" +
                "Content-Encoding: gzip\r\n" +
                "Content-Length: ${gzipped.size}\r\n" +
                "Vary: Accept-Encoding\r\n" +
                "$setCookie\r\n" +
                "Connection: close\r\n\r\n"
            ).toByteArray())
            output.write(gzipped)
        } else {
            val total = wikiBytes.size + injection.size
            output.write((
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/html; charset=utf-8\r\n" +
                "Content-Length: $total\r\n" +
                "$setCookie\r\n" +
                "Connection: close\r\n\r\n"
            ).toByteArray())
            if (insertPos >= 0) {
                output.write(wikiBytes, 0, insertPos)
                output.write(injection)
                output.write(wikiBytes, insertPos, wikiBytes.size - insertPos)
            } else output.write(wikiBytes)
        }
    }

    /**
     * The `Dav`/`Allow: PUT` headers are what make TiddlyWiki's built-in `put` saver
     * detect the server as writable (see put.js: it reads `dav` / `allow` on OPTIONS).
     */
    private fun serveOptions(output: OutputStream) {
        output.write((
            "HTTP/1.1 200 OK\r\n" +
            "Allow: OPTIONS, GET, HEAD, PUT\r\n" +
            "Dav: 1\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, HEAD, PUT, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type, If-Match, X-Requested-With\r\n" +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n\r\n"
        ).toByteArray())
    }

    /**
     * Raw wiki file bytes with NO media-CSS injection (authenticated). Classic TiddlyWiki's
     * `saveChanges` reads the current file as a template and swaps in the store, so it must see the
     * clean file — serving the injected version would bake the ephemeral media CSS into every save.
     */
    private fun serveRawSource(output: OutputStream) {
        val bytes = runCatching { readWikiBytes() }.getOrNull() ?: ByteArray(0)
        output.write((
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/html; charset=UTF-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        ).toByteArray())
        output.write(bytes)
    }

    private fun saveWiki(input: InputStream, output: OutputStream, headers: Map<String, String>) {
        try {
            // Snapshot the version we're about to replace (read into memory before overwrite).
            val oldBytes = if (backupsEnabled) runCatching { readWikiBytes() }.getOrNull() else null

            val contentLength = headers["content-length"]?.toLongOrNull() ?: -1L
            var written = 0L
            openWikiOutput().use { os ->
                val buf = ByteArray(1 shl 16)
                if (contentLength >= 0) {
                    var remaining = contentLength
                    while (remaining > 0) {
                        val read = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                        if (read == -1) break
                        os.write(buf, 0, read); written += read; remaining -= read
                    }
                } else {
                    while (true) {
                        val read = input.read(buf)
                        if (read == -1) break
                        os.write(buf, 0, read); written += read
                    }
                }
                os.flush()
            }
            Log.i(TAG, "Saved wiki: $written bytes")
            // Respond immediately; back up off the response path.
            sendSimple(output, 200, "OK", body = "Saved")
            if (oldBytes != null) workers.submit { runCatching { writeBackup(oldBytes) } }
        } catch (e: Exception) {
            Log.e(TAG, "save failed: ${e.message}", e)
            sendError(output, 500, "Save failed: ${e.message}")
        }
    }

    /**
     * Serve an external-attachment file from the wiki's `attachments/` folder, with HTTP Range
     * (206) support so large audio/video attachments can seek. Seeking uses O(1) file-descriptor
     * positioning (InputStream.skip is O(n) for SAF streams).
     */
    private fun serveAttachment(output: OutputStream, name: String, headers: Map<String, String>, headOnly: Boolean) {
        // Subfolders under attachments/ are allowed ("sub/dir/file.png"); reject anything that could
        // escape the folder — an absolute/empty/"."/".." segment (covers leading, trailing and double slashes).
        if (name.isBlank() || name.split('/').any { it.isEmpty() || it == "." || it == ".." }) { sendError(output, 404, "Not Found"); return }
        val target = resolveAttachment(name)
        if (target == null) { sendError(output, 404, "Not Found"); return }
        val (fileUri, total) = target
        val mime = mimeFor(name)

        var start = 0L; var end = total - 1; var partial = false
        headers["range"]?.let { rh ->
            Regex("""bytes=(\d*)-(\d*)""").find(rh)?.let { m ->
                val s = m.groupValues[1]; val e = m.groupValues[2]
                when {
                    s.isNotEmpty() -> { start = s.toLong(); if (e.isNotEmpty()) end = e.toLong() }
                    e.isNotEmpty() -> start = (total - e.toLong()).coerceAtLeast(0) // suffix range
                }
                end = end.coerceAtMost(total - 1)
                if (start > end || start >= total) {
                    output.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\n" +
                        "Accept-Ranges: bytes\r\nConnection: close\r\n\r\n").toByteArray())
                    return
                }
                partial = true
            }
        }

        val len = end - start + 1
        val head = StringBuilder()
            .append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
            .append("Content-Type: $mime\r\n")
            .append("Accept-Ranges: bytes\r\n")
            .append("Content-Length: $len\r\n")
            .apply { if (partial) append("Content-Range: bytes $start-$end/$total\r\n") }
            .append("Cache-Control: no-cache\r\n")
            .append("Connection: close\r\n\r\n")
        output.write(head.toString().toByteArray())
        if (headOnly) return

        openAttachmentStream(fileUri, start).use { ins ->
            val buf = ByteArray(1 shl 16); var remaining = len
            while (remaining > 0) {
                val r = ins.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                if (r == -1) break
                output.write(buf, 0, r); remaining -= r
            }
        }
    }

    /**
     * Locate an attachment in `<containing folder>/attachments/<name>`, where `name` may include
     * subfolder segments ("sub/dir/file.png"); returns (uri, length). Caller has already rejected
     * traversal segments.
     */
    private fun resolveAttachment(name: String): Pair<Uri, Long>? = runCatching {
        val folder = backupDirUri?.ifBlank { null } ?: return null
        if (folder.startsWith("content://")) {
            val root = DocumentFile.fromTreeUri(context, Uri.parse(folder)) ?: return null
            // Walk each path segment so subfolders resolve (SAF has no path-based lookup).
            var f = root.findFile("attachments") ?: return null
            for (seg in name.split('/')) { f = f.findFile(seg) ?: return null }
            if (!f.isFile) return null
            f.uri to f.length()
        } else {
            val base = File(folder, "attachments")
            val f = File(base, name)
            // Belt-and-braces: ensure the resolved path stays inside the attachments folder.
            if (!f.canonicalPath.startsWith(base.canonicalPath + File.separator)) return null
            if (!f.isFile) return null
            Uri.fromFile(f) to f.length()
        }
    }.getOrNull()

    private fun openAttachmentStream(fileUri: Uri, start: Long): InputStream {
        if (fileUri.scheme == "file") {
            val fis = java.io.FileInputStream(fileUri.path!!)
            if (start > 0) fis.channel.position(start)
            return fis
        }
        val pfd = context.contentResolver.openFileDescriptor(fileUri, "r")
            ?: throw IOException("cannot open $fileUri")
        val ins = ParcelFileDescriptor.AutoCloseInputStream(pfd)
        if (start > 0) ins.channel.position(start)
        return ins
    }

    private fun mimeFor(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    // ── wiki I/O (content:// vs file) ────────────────────────────────────────────

    private fun readWikiBytes(): ByteArray =
        if (isContent) {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw IOException("cannot read $uri")
        } else {
            File(wikiPath).readBytes()
        }

    private fun openWikiOutput(): OutputStream =
        if (isContent) {
            // "wt" = write+truncate; required so a shorter save doesn't leave trailing bytes.
            context.contentResolver.openOutputStream(uri, "wt")
                ?: throw IOException("cannot write $uri")
        } else {
            FileOutputStream(File(wikiPath))
        }

    /** Save a timestamped backup of the pre-save content (shared with the PluginChooser). */
    private fun writeBackup(oldBytes: ByteArray) =
        Backups.write(context, wikiPath, oldBytes, backupDirUri, backupCount)

    // ── small helpers ────────────────────────────────────────────────────────────

    private fun hasValidCookie(headers: Map<String, String>): Boolean {
        val cookie = headers["cookie"] ?: return false
        return cookie.split(";").any { it.trim() == "$cookieName=$sessionToken" }
    }

    private fun sendSimple(output: OutputStream, code: Int, status: String, body: String = "") {
        val bytes = body.toByteArray()
        output.write((
            "HTTP/1.1 $code $status\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n\r\n"
        ).toByteArray())
        if (bytes.isNotEmpty()) output.write(bytes)
    }

    private fun sendError(output: OutputStream, code: Int, message: String) =
        sendSimple(output, code, message, body = message)

    /** Case-insensitive ASCII search for a tag; returns byte offset or -1. */
    private fun indexOfTag(data: ByteArray, tag: String): Int {
        val needle = tag.lowercase().toByteArray(Charsets.US_ASCII)
        val limit = data.size - needle.size
        var i = 0
        while (i <= limit) {
            var j = 0
            while (j < needle.size) {
                val b = data[i + j].toInt() and 0xFF
                val lower = if (b in 65..90) b + 32 else b
                if (lower != needle[j].toInt()) break
                j++
            }
            if (j == needle.size) return i
            i++
        }
        return -1
    }

    private fun randomToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val TAG = "SingleFileWikiServer"

        // Single-file servers: 39000-39999 (Node folder servers use 38000-38999).
        private val nextPort = AtomicInteger(39000)

        fun allocatePort(): Int {
            repeat(1000) {
                val p = nextPort.getAndUpdate { if (it >= 39999) 39000 else it + 1 }
                try {
                    ServerSocket(p, 1, InetAddress.getByName("127.0.0.1")).use { return p }
                } catch (_: Exception) { /* busy */ }
            }
            error("No free port in 39000-39999")
        }

        private const val MEDIA_CSS =
            "<style id=\"td-media-controls\">" +
            "video{max-width:100%;height:auto;object-fit:contain;border-radius:4px;background:#000;}" +
            "audio{max-width:100%;width:100%;box-sizing:border-box;}" +
            "</style>"
    }
}
