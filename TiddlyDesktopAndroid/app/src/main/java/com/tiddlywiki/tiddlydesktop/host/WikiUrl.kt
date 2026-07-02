package com.tiddlywiki.tiddlydesktop.host

import android.util.Base64

/**
 * The classic TiddlyDesktop WikiList identifies each wiki by a URL tiddler title:
 * `wikifile://<path>` (single-file) or `wikifolder://<path>`.
 *
 * On Android a wiki's "path" is usually a SAF `content://` URI, which contains characters
 * that are awkward inside a tiddler title (also a filename on disk in the folder wiki). So
 * we base64url-encode the path into the URL and decode it back natively.
 *
 *   encode("content://…/foo.html", false) -> "wikifile://Y29udGVudDov…"
 *   decode(url) -> DecodedUrl(path="content://…/foo.html", isFolder=false)
 */
object WikiUrl {
    private const val FILE = "wikifile://"
    private const val FOLDER = "wikifolder://"
    private const val B64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    data class Decoded(val path: String, val isFolder: Boolean)

    fun encode(path: String, isFolder: Boolean): String {
        val scheme = if (isFolder) FOLDER else FILE
        return scheme + Base64.encodeToString(path.toByteArray(Charsets.UTF_8), B64)
    }

    fun decode(url: String): Decoded? {
        val (scheme, isFolder) = when {
            url.startsWith(FOLDER) -> FOLDER to true
            url.startsWith(FILE) -> FILE to false
            else -> return null
        }
        val encoded = url.substring(scheme.length)
        return runCatching {
            Decoded(String(Base64.decode(encoded, B64), Charsets.UTF_8), isFolder)
        }.getOrNull()
    }
}
