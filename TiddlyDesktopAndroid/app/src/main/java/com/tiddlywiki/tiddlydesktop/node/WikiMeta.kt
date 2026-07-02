package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import java.io.File

/**
 * Extracts live display metadata (SiteTitle, SiteSubtitle, favicon) from a wiki's actual
 * content, so the WikiList rows reflect the current wiki rather than a stale filename.
 *
 * Single-file wikis: string-search the tiddler store for `$:/SiteTitle` / `$:/SiteSubtitle`
 * / `$:/favicon.ico` (the store is single-escaped JSON), with a `<link rel="icon">` head
 * fallback for the favicon (ported from TiddlyDesktop-RS's tiddlywiki_html.rs).
 * Folder wikis: read the `$:/SiteTitle` / `$:/SiteSubtitle` `.tid` files from the SAF tree.
 */
object WikiMeta {

    private const val TAG = "WikiMeta"

    data class Meta(val title: String, val subtitle: String, val favicon: String)

    fun extract(context: Context, path: String, isFolder: Boolean): Meta =
        if (isFolder) extractFolder(context, path) else extractSingleFile(context, path)

    // ── single-file ──────────────────────────────────────────────────────────────

    private fun extractSingleFile(context: Context, path: String): Meta {
        val html = readText(context, path) ?: return Meta("", "", "")
        val title = tiddlerField(html, "\$:/SiteTitle", "text") ?: ""
        val subtitle = tiddlerField(html, "\$:/SiteSubtitle", "text") ?: ""
        val favicon = favicon(html)
        Log.i(TAG, "extracted title='${title.take(40)}' subtitle='${subtitle.take(40)}' favicon=${favicon.isNotEmpty()}")
        return Meta(title.trim(), subtitle.trim(), favicon)
    }

    private fun favicon(html: String): String {
        // 1. <link rel="…icon…" href="data:image…"> in the head.
        val headEnd = html.indexOf("</head>", ignoreCase = true).let { if (it < 0) minOf(html.length, 500_000) else it }
        val head = html.substring(0, headEnd)
        Regex("<link[^>]*>", RegexOption.IGNORE_CASE).findAll(head).forEach { link ->
            val lower = link.value.lowercase()
            if (lower.contains("icon") && lower.contains("href=")) {
                Regex("href=[\"'](data:image[^\"']+)[\"']", RegexOption.IGNORE_CASE)
                    .find(link.value)?.let { return it.groupValues[1] }
            }
        }
        // 2. The $:/favicon.ico tiddler (text = base64), build a data URI.
        val b64 = tiddlerField(html, "\$:/favicon.ico", "text")?.replace(Regex("\\s"), "") ?: ""
        if (b64.isBlank()) return ""
        val type = tiddlerField(html, "\$:/favicon.ico", "type")?.ifBlank { null } ?: "image/x-icon"
        return "data:$type;base64,$b64"
    }

    /**
     * Extract a string field of a tiddler from the (single-escaped JSON) store — the LAST
     * occurrence, which is the most recently saved version. Falls back to the old div store.
     */
    private fun tiddlerField(html: String, title: String, field: String): String? {
        val titlePat = "{\"title\":\"$title\""
        val start = html.lastIndexOf(titlePat)
        if (start >= 0) {
            val block = html.substring(start, minOf(start + 2_000_000, html.length))
            val fp = "\"$field\":\""
            val fs = block.indexOf(fp)
            if (fs >= 0) {
                val rem = block.substring(fs + fp.length)
                val end = firstUnescapedQuote(rem)
                if (end >= 0) return unescapeJson(rem.substring(0, end))
            }
        }
        // Old div store: <div title="…"><pre>text</pre></div> (only carries the text field).
        if (field == "text") {
            Regex("<div[^>]*\\stitle=\"${Regex.escape(title)}\"[^>]*>([\\s\\S]*?)</div>")
                .find(html)?.let { return htmlDecode(it.groupValues[1].removePrefix("\n").trim()) }
        }
        return null
    }

    private fun firstUnescapedQuote(s: String): Int {
        var i = 0
        while (i < s.length) {
            if (s[i] == '"') {
                var backslashes = 0
                var c = i - 1
                while (c >= 0 && s[c] == '\\') { backslashes++; c-- }
                if (backslashes % 2 == 0) return i
            }
            i++
        }
        return -1
    }

    private fun unescapeJson(s: String): String = s
        .replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
        .replace("\\\"", "\"").replace("\\/", "/").replace("\\\\", "\\")

    private fun htmlDecode(s: String): String = s
        .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
        .replace("&#39;", "'").replace("&amp;", "&")

    // ── folder ───────────────────────────────────────────────────────────────────

    private fun extractFolder(context: Context, path: String): Meta {
        if (!path.startsWith("content://")) {
            val tdir = File(path, "tiddlers")
            return Meta(
                tidText(File(tdir, tidFileName("\$:/SiteTitle"))),
                tidText(File(tdir, tidFileName("\$:/SiteSubtitle"))),
                ""
            )
        }
        val root = DocumentFile.fromTreeUri(context, Uri.parse(path)) ?: return Meta("", "", "")
        val tiddlers = root.findFile("tiddlers") ?: return Meta("", "", "")
        fun read(title: String): String {
            val f = tiddlers.findFile(tidFileName(title)) ?: return ""
            val raw = runCatching {
                context.contentResolver.openInputStream(f.uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull() ?: return ""
            return tidBody(raw)
        }
        return Meta(read("\$:/SiteTitle"), read("\$:/SiteSubtitle"), "")
    }

    private fun tidFileName(title: String): String =
        title.replace("\$:/", "\$__").replace("/", "_") + ".tid"

    private fun tidText(file: File): String =
        if (file.exists()) tidBody(file.readText()) else ""

    private fun tidBody(raw: String): String {
        val i = raw.indexOf("\n\n")
        return if (i >= 0) raw.substring(i + 2).trim() else ""
    }

    private fun readText(context: Context, path: String): String? = runCatching {
        if (path.startsWith("content://"))
            context.contentResolver.openInputStream(Uri.parse(path))?.use { it.readBytes().toString(Charsets.UTF_8) }
        else File(path).readText()
    }.getOrNull()
}
