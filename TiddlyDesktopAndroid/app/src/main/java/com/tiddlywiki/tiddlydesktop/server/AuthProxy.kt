package com.tiddlywiki.tiddlydesktop.server

import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A loopback authentication gate in front of a folder wiki's `tiddlywiki --listen` server.
 *
 * WHY THIS EXISTS
 * ---------------
 * On Android, 127.0.0.1 is NOT private. Any installed app holding the normal, unprompted INTERNET
 * permission can connect to another app's loopback port, and TiddlyWiki's server was started with
 * no credentials at all. So while a folder wiki was open, any app on the device could read every
 * tiddler in it and PUT changes back. Nothing was exposed off-device -- the binding really is
 * loopback -- but on-device it was open to everything.
 *
 * TWO DOORS, BOTH LOCKED
 * ----------------------
 * A proxy alone would not have fixed this: the Node server's own port stays reachable, so anything
 * on the device could simply skip the proxy. So both doors are locked, and they take DIFFERENT
 * keys, neither of which is guessable:
 *
 *   Node's port   HTTP basic credentials, generated per launch, never written to disk. Held only
 *                 by this process, and attached to each request on its way through.
 *   this port     a session cookie, minted below.
 *
 * The WebView cannot hold the Node credentials itself -- anything the page can read, a hostile
 * wiki can exfiltrate -- which is the whole reason for the split. It gets the cookie; the proxy
 * holds the password. This mirrors the desktop app, where the folder-wiki server is likewise
 * started with credentials and reached through a proxy that adds them.
 *
 * HOW A CALLER IS TRUSTED
 * -----------------------
 * The entry [url] carries a token in its query string. The first request presenting it is answered
 * with a redirect that sets an HttpOnly session cookie and drops the token from the address; every
 * later request -- navigations, images, and crucially the syncer's XHRs -- carries that cookie
 * automatically, being same-origin. Basic auth alone could not do this: WebView only reliably
 * surfaces onReceivedHttpAuthRequest for main-frame loads, so the syncer's XHRs would have
 * collected 401s and the wiki would have failed to save while looking perfectly healthy.
 *
 * WHY ONE REQUEST PER CONNECTION
 * ------------------------------
 * Every request must be authenticated and must have the upstream credentials attached, so each one
 * is parsed rather than the socket being spliced. Forcing `Connection: close` upstream is what
 * keeps that honest: the response is then "everything until EOF", so there is no keep-alive
 * bookkeeping and no way for a response boundary to be mis-read. It costs a connection per request
 * on loopback, which is cheap, and buys a proxy small enough to audit by reading.
 */
class AuthProxy(
    private val upstreamPort: Int,
    private val upstreamUser: String,
    private val upstreamPassword: String,
    private val port: Int = allocatePort()
) {
    private var serverSocket: ServerSocket? = null
    private val running = AtomicBoolean(false)
    private val workers = Executors.newCachedThreadPool()

    private val token: String = randomToken()
    private val cookieName = "_tdnode_$port"
    private val upstreamAuth: String = "Basic " + base64("$upstreamUser:$upstreamPassword")

    /** The address to hand the WebView. Carries the token once; the redirect below removes it. */
    val url: String get() = "http://127.0.0.1:$port/?$AUTH_PARAM=$token"

    /** The address the page settles on, for callers that need to compare origins. */
    val origin: String get() = "http://127.0.0.1:$port"

    fun isRunning(): Boolean = running.get()

    fun start(): String {
        val sock = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
        serverSocket = sock
        running.set(true)
        Thread {
            while (running.get()) {
                val client = try { sock.accept() } catch (_: Exception) { break }
                workers.submit { handle(client) }
            }
        }.apply { name = "AuthProxy-$port"; isDaemon = true; start() }
        Log.i(TAG, "Auth proxy on $origin -> 127.0.0.1:$upstreamPort")
        return url
    }

    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: Exception) {}
        workers.shutdownNow()
    }

    private fun handle(client: Socket) {
        try {
            client.tcpNoDelay = true
            client.use { c ->
                val input = c.getInputStream()
                val head = readHead(input) ?: return
                when {
                    hasCookie(head.headers) -> forward(c, input, head)
                    presentsToken(head.target) -> sendRedirect(c.getOutputStream(), head.target)
                    else -> {
                        // Deliberately says nothing about a token being what is missing.
                        sendStatus(c.getOutputStream(), "401 Unauthorized")
                        Log.w(TAG, "refused an unauthenticated request on $origin")
                    }
                }
            }
        } catch (_: Exception) {
            try { client.close() } catch (_: Exception) {}
        }
    }

    private class Head(val requestLine: String, val target: String, val headers: List<String>)

    /**
     * Read the request line and headers, stopping at the blank line that ends them.
     *
     * Byte at a time so not one byte of the body is consumed: whatever follows stays in the stream
     * for [forwardBody] to relay by the framing the headers declare.
     */
    private fun readHead(input: InputStream): Head? {
        val buf = ByteArrayOutputStream()
        var matched = 0
        while (buf.size() < MAX_HEAD) {
            val b = input.read()
            if (b < 0) return null
            buf.write(b)
            matched = when {
                b == '\r'.code && (matched == 0 || matched == 2) -> matched + 1
                b == '\n'.code && (matched == 1 || matched == 3) -> matched + 1
                b == '\n'.code && matched == 0 -> 2      // tolerate bare LF
                else -> 0
            }
            if (matched == 4) break
        }
        if (matched != 4) return null
        val lines = String(buf.toByteArray(), Charsets.ISO_8859_1)
            .split("\r\n", "\n")
            .filter { it.isNotEmpty() }
        val requestLine = lines.firstOrNull() ?: return null
        val target = requestLine.split(" ").getOrNull(1) ?: return null
        return Head(requestLine, target, lines.drop(1))
    }

    private fun hasCookie(headers: List<String>): Boolean {
        val line = headers.firstOrNull { it.startsWith("Cookie:", ignoreCase = true) } ?: return false
        return line.substringAfter(':').split(';').map { it.trim() }
            .any { it.startsWith("$cookieName=") && constantTimeEquals(it.substringAfter('='), token) }
    }

    private fun presentsToken(target: String): Boolean {
        val supplied = target.substringAfter('?', "").split('&')
            .firstOrNull { it.startsWith("$AUTH_PARAM=") }?.substringAfter('=') ?: return false
        return constantTimeEquals(supplied, token)
    }

    /** Relay one request upstream with the credentials attached, then its response back. */
    private fun forward(client: Socket, clientIn: InputStream, head: Head) {
        Socket(InetAddress.getByName("127.0.0.1"), upstreamPort).use { upstream ->
            upstream.tcpNoDelay = true
            val upOut = upstream.getOutputStream()

            val rebuilt = StringBuilder().append(head.requestLine).append("\r\n")
            head.headers.forEach { line ->
                val name = line.substringBefore(':').trim().lowercase()
                // Dropped: the client's own Authorization (ours is authoritative), and anything
                // that would keep the connection alive -- "until EOF" is how the response is read.
                if (name !in DROPPED_HEADERS) rebuilt.append(line).append("\r\n")
            }
            rebuilt.append("Authorization: ").append(upstreamAuth).append("\r\n")
            rebuilt.append("Connection: close\r\n\r\n")
            upOut.write(rebuilt.toString().toByteArray(Charsets.ISO_8859_1))
            upOut.flush()

            forwardBody(head.headers, clientIn, upOut)
            upOut.flush()

            // Node closes once it has answered, so the response is everything up to EOF.
            copyUntilEof(upstream.getInputStream(), client.getOutputStream())
        }
    }

    /** Relay the request body using whichever framing the headers declare. */
    private fun forwardBody(headers: List<String>, from: InputStream, to: OutputStream) {
        fun header(name: String): String? = headers
            .firstOrNull { it.startsWith("$name:", ignoreCase = true) }?.substringAfter(':')?.trim()

        if (header("Transfer-Encoding")?.contains("chunked", ignoreCase = true) == true) {
            copyChunked(from, to)
            return
        }
        val length = header("Content-Length")?.toLongOrNull() ?: return
        var remaining = length
        val buf = ByteArray(64 * 1024)
        while (remaining > 0) {
            val n = from.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
            if (n < 0) break
            to.write(buf, 0, n)
            remaining -= n
        }
    }

    /** Copy a chunked body, sizes and all, up to and including the terminating zero-length chunk. */
    private fun copyChunked(from: InputStream, to: OutputStream) {
        while (true) {
            val sizeLine = readLine(from) ?: return
            to.write(sizeLine.toByteArray(Charsets.ISO_8859_1)); to.write(CRLF)
            val size = sizeLine.substringBefore(';').trim().toIntOrNull(16) ?: return
            if (size == 0) {
                // Trailers, then the blank line that ends the body.
                while (true) {
                    val trailer = readLine(from) ?: return
                    to.write(trailer.toByteArray(Charsets.ISO_8859_1)); to.write(CRLF)
                    if (trailer.isEmpty()) return
                }
            }
            var remaining = size
            val buf = ByteArray(minOf(size, 64 * 1024))
            while (remaining > 0) {
                val n = from.read(buf, 0, minOf(buf.size, remaining))
                if (n < 0) return
                to.write(buf, 0, n)
                remaining -= n
            }
            readLine(from)               // the CRLF that closes the chunk
            to.write(CRLF)
        }
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (buf.size() < MAX_HEAD) {
            val b = input.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (b == '\n'.code) return buf.toString("ISO-8859-1").removeSuffix("\r")
            buf.write(b)
        }
        return null
    }

    private fun copyUntilEof(from: InputStream, to: OutputStream) {
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = from.read(buf)
            if (n < 0) break
            to.write(buf, 0, n)
            to.flush()
        }
    }

    /**
     * Set the cookie and send the caller to the same address without the token, so it does not
     * linger in the page's URL, in history, or in a Referer the wiki later sends.
     */
    private fun sendRedirect(out: OutputStream, target: String) {
        val path = target.substringBefore('?').ifEmpty { "/" }
        val rest = target.substringAfter('?', "").split('&')
            .filter { it.isNotEmpty() && !it.startsWith("$AUTH_PARAM=") }.joinToString("&")
        val location = if (rest.isEmpty()) path else "$path?$rest"
        val response = buildString {
            append("HTTP/1.1 302 Found\r\n")
            append("Location: $location\r\n")
            // No Max-Age: a session cookie dies with the WebView, as the token dies with the server.
            append("Set-Cookie: $cookieName=$token; Path=/; HttpOnly; SameSite=Strict\r\n")
            append("Cache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        }
        out.write(response.toByteArray(Charsets.ISO_8859_1))
        out.flush()
    }

    private fun sendStatus(out: OutputStream, status: String) {
        out.write(
            ("HTTP/1.1 $status\r\nContent-Length: 0\r\nCache-Control: no-store\r\n" +
                "Connection: close\r\n\r\n").toByteArray(Charsets.ISO_8859_1)
        )
        out.flush()
    }

    companion object {
        private const val TAG = "AuthProxy"
        private const val AUTH_PARAM = "__tdauth"
        private const val MAX_HEAD = 64 * 1024
        private val CRLF = "\r\n".toByteArray(Charsets.ISO_8859_1)
        private val DROPPED_HEADERS = setOf(
            "authorization", "connection", "keep-alive", "proxy-connection", "upgrade"
        )

        /**
         * Base64 for the credentials header. Hand-rolled because android.util.Base64 cannot run in
         * a JVM unit test and java.util.Base64 needs API 26 while this app supports 24.
         */
        internal fun base64(input: String): String {
            val data = input.toByteArray(Charsets.UTF_8)
            val out = StringBuilder()
            var i = 0
            while (i < data.size) {
                val b0 = data[i].toInt() and 0xff
                val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xff else 0
                val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xff else 0
                out.append(ALPHABET[b0 shr 2])
                out.append(ALPHABET[((b0 and 0x03) shl 4) or (b1 shr 4)])
                out.append(if (i + 1 < data.size) ALPHABET[((b1 and 0x0f) shl 2) or (b2 shr 6)] else '=')
                out.append(if (i + 2 < data.size) ALPHABET[b2 and 0x3f] else '=')
                i += 3
            }
            return out.toString()
        }

        private const val ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        fun allocatePort(): Int =
            ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }

        fun randomToken(): String {
            val bytes = ByteArray(24)
            SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }

        /** Comparison that does not stop at the first mismatch, so a token cannot be walked out. */
        private fun constantTimeEquals(a: String, b: String): Boolean {
            if (a.length != b.length) return false
            var diff = 0
            for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
            return diff == 0
        }
    }
}
