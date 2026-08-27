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
 * document back to `/`. That body is buffered in full and then written over the wiki file — via a
 * temp file + rename where the destination allows it, see [saveWiki]. No custom saver is injected.
 *
 * The wiki path may be a `content://` SAF URI or a plain filesystem path.
 *
 * External attachments are served from the wiki's sibling `attachments/` folder, with HTTP Range
 * support so large audio/video can seek, and backups go through [Backups] for both filesystem and
 * SAF destinations.
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

    /**
     * The address for the WebView. Carries the session token once, because the very first request
     * cannot present a cookie it has not been given yet; serveWiki() sets the cookie, and every
     * request after this one is admitted on that instead.
     */
    val url: String get() = "http://127.0.0.1:$port/?$AUTH_PARAM=$sessionToken"
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
                val target = requestLine[1]
                val path = target.substringBefore('?')

                val headers = HashMap<String, String>()
                for (i in 1 until lines.size) {
                    val line = lines[i]
                    val c = line.indexOf(':')
                    if (c > 0) headers[line.substring(0, c).trim().lowercase()] =
                        line.substring(c + 1).trim()
                }

                /*
                Loading the wiki used to be a public route, which meant any app on the device could
                GET / and read the whole wiki -- every tiddler of it -- because on Android 127.0.0.1
                is reachable by anything holding the normal INTERNET permission. Only writes were
                gated. The bootstrap problem that made it public is real (no cookie exists yet on the
                first request), so it is solved the way the folder-wiki proxy solves it: the entry URL
                carries the token once, and the response mints the cookie.

                OPTIONS stays open deliberately. It is the saver's capability probe, it discloses
                nothing but "PUT is allowed here", and gating it risks breaking saving for no real
                gain -- a caller that cannot authenticate cannot PUT anyway.
                */
                val isPublic = method == "OPTIONS"
                if (!isPublic && !hasValidCookie(headers) && !presentsToken(target)) {
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
                "Content-Security-Policy: $CSP\r\n" +
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
                "Content-Security-Policy: $CSP\r\n" +
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
            "Content-Security-Policy: $CSP\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        ).toByteArray())
        output.write(bytes)
    }

    /**
     * Replace the wiki file with the PUT body.
     *
     * The body is buffered in full before anything on disk is touched, and — for a plain filesystem
     * path — written to a sibling temp file that is renamed over the original. Streaming straight
     * into the wiki file, as this used to, opens a window in which the user's entire wiki is a
     * truncated prefix of the new one: a dropped connection, a killed process or a full disk part
     * way through leaves exactly that, and the response still said "Saved". A wiki is a single file
     * holding everything the user has written, so that window is not an acceptable one to leave
     * open.
     *
     * A short body (fewer bytes than Content-Length announced) is now a failed save rather than a
     * silent truncation, for the same reason.
     *
     * A `content://` destination cannot be renamed into place — SAF has no such operation — so it
     * keeps the direct write, but still only after the whole body has arrived, which closes the
     * network half of the window.
     */
    private fun saveWiki(input: InputStream, output: OutputStream, headers: Map<String, String>) {
        try {
            val contentLength = headers["content-length"]?.toLongOrNull() ?: -1L
            val body = ByteArrayOutputStream(if (contentLength in 0..MAX_BODY) contentLength.toInt() else 1 shl 20)
            val buf = ByteArray(1 shl 16)
            if (contentLength >= 0) {
                var remaining = contentLength
                while (remaining > 0) {
                    val read = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                    if (read == -1) break
                    body.write(buf, 0, read); remaining -= read
                }
                if (remaining > 0) {
                    Log.e(TAG, "save aborted: body ended $remaining bytes early; wiki left untouched")
                    sendError(output, 400, "Incomplete request body")
                    return
                }
            } else {
                while (true) {
                    val read = input.read(buf)
                    if (read == -1) break
                    body.write(buf, 0, read)
                }
            }
            val newBytes = body.toByteArray()

            // Snapshot the version we're about to replace (read into memory before overwrite).
            val oldBytes = if (backupsEnabled) runCatching { readWikiBytes() }.getOrNull() else null

            writeWikiAtomically(newBytes)
            Log.i(TAG, "Saved wiki: ${newBytes.size} bytes")
            // Respond immediately; back up off the response path.
            sendSimple(output, 200, "OK", body = "Saved")
            if (oldBytes != null) workers.submit { runCatching { writeBackup(oldBytes) } }
        } catch (e: Exception) {
            Log.e(TAG, "save failed: ${e.message}", e)
            sendError(output, 500, "Save failed: ${e.message}")
        }
    }

    /** Write [bytes] over the wiki, via a temp file + rename wherever the destination allows it. */
    private fun writeWikiAtomically(bytes: ByteArray) {
        if (isContent) {
            // "wt" = write+truncate; required so a shorter save doesn't leave trailing bytes.
            openWikiOutput().use { it.write(bytes); it.flush() }
            return
        }
        // canonicalFile, not absoluteFile: a rename replaces whatever is at the destination, so a
        // wiki that is a symlink would have the LINK overwritten with a regular file and the real
        // wiki left frozen at its previous contents. Resolving first follows the link the way a
        // plain write did, and puts the temp file beside the real target — same directory, so the
        // rename stays within one filesystem, which is what makes it atomic.
        val target = runCatching { File(wikiPath).canonicalFile }.getOrElse { File(wikiPath).absoluteFile }
        val temp = File(target.parentFile ?: target, "${target.name}.tdsave")
        try {
            FileOutputStream(temp).use { os ->
                os.write(bytes)
                os.flush()
                // Force the bytes out before the rename, so a power loss cannot leave a renamed
                // file whose contents never reached the disk.
                os.fd.sync()
            }
            if (!temp.renameTo(target)) {
                // Same-directory renames effectively always succeed; if one does not, fall back to
                // a direct write rather than leaving the save undone.
                FileOutputStream(target).use { it.write(bytes); it.flush() }
                temp.delete()
            }
        } catch (e: Exception) {
            temp.delete()
            throw e
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

    /** Does this request line carry the entry token? Compared without an early exit. */
    private fun presentsToken(target: String): Boolean {
        val supplied = target.substringAfter('?', "").split('&')
            .firstOrNull { it.startsWith("$AUTH_PARAM=") }?.substringAfter('=') ?: return false
        if (supplied.length != sessionToken.length) return false
        var diff = 0
        for (i in supplied.indices) diff = diff or (supplied[i].code xor sessionToken[i].code)
        return diff == 0
    }

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
        /**
         * Content-Security-Policy for the wiki document.
         *
         * The only measure that constrains what a wiki can send OUT rather than what it can read,
         * and it exists only because the wiki is served: a file:// document cannot be given
         * response headers. Mirrors the desktop policy in source/js/utils/wiki-server.js; keep the
         * two in step.
         *
         *   connect-src  'self' only -- this is the point of the exercise. It stops a tiddler
         *                beaconing to an arbitrary host with fetch/XHR/WebSocket/sendBeacon. It
         *                does NOT break collaboration: the collab plugin's traffic goes through
         *                CollabBridge, which makes the request from the app rather than the page
         *                and is governed by its own scheme checks. Unlike desktop there is no
         *                separate attachment origin to allow -- attachments are served from this
         *                same server.
         *   object-src   'none'. Nothing legitimate embeds plugins.
         *   base-uri     'none'. Stops a <base> tag silently repointing every relative URL.
         *   form-action  'none'. TiddlyWiki does not submit forms, and a form POST is otherwise a
         *                tidy exfiltration channel that connect-src does not cover.
         *   script-src   must keep 'unsafe-eval' and 'unsafe-inline': TiddlyWiki compiles filters
         *                and widgets at runtime and ships inline scripts. A wiki is executable
         *                content by design, so this is not being used to contain its script.
         *   img/media/   left open. Wikis legitimately reference remote media, and one that wants
         *   font         to leak through an <img> query string still can. Closing it would break
         *                real wikis for a partial gain.
         *   frame-src    left open, and it must ALSO name data: and blob: explicitly. A bare `*`
         *                matches only network schemes -- CSP excludes data:, blob: and filesystem:
         *                from the wildcard -- and TiddlyWiki renders every text/html tiddler as an
         *                iframe whose src is `data:text/html;charset=utf-8,...`. Without them such
         *                a tiddler renders as an empty frame with a CSP violation, which is a plain
         *                regression rather than a security gain: the frame is sandboxed by the
         *                parser and carries content the wiki could equally have rendered inline.
         */
        const val CSP =
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
            "style-src 'self' 'unsafe-inline' data:; " +
            "img-src * data: blob:; " +
            "media-src * data: blob:; " +
            "font-src * data:; " +
            "frame-src * data: blob:; " +
            "connect-src 'self'; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "form-action 'none'"


        /** Query parameter carrying the session token on the very first load. */
        private const val AUTH_PARAM = "__tdauth"

        /** Upper bound on the pre-sized save buffer; a larger body simply grows the stream. */
        private const val MAX_BODY = 256L * 1024 * 1024

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
