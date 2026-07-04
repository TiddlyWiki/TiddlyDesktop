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

    data class Meta(val title: String, val subtitle: String, val favicon: String, val isClassic: Boolean = false)

    fun extract(context: Context, path: String, isFolder: Boolean): Meta =
        if (isFolder) extractFolder(context, path) else extractSingleFile(context, path)

    /** TiddlyWiki Classic (2.x) ships a `#versionArea` placeholder that TiddlyWiki5 never emits. */
    private val CLASSIC_MARKER = Regex("id=[\"']versionArea[\"']", RegexOption.IGNORE_CASE)

    // ── single-file ──────────────────────────────────────────────────────────────

    private fun extractSingleFile(context: Context, path: String): Meta {
        val html = readText(context, path) ?: return Meta("", "", "")
        val title = tiddlerField(html, "\$:/SiteTitle", "text") ?: ""
        val subtitle = tiddlerField(html, "\$:/SiteSubtitle", "text") ?: ""
        val favicon = favicon(html)
        val isClassic = CLASSIC_MARKER.containsMatchIn(html)
        Log.i(TAG, "extracted title='${title.take(40)}' subtitle='${subtitle.take(40)}' favicon=${favicon.isNotEmpty()} classic=$isClassic")
        return Meta(title.trim(), subtitle.trim(), favicon, isClassic)
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
        // Old div store (TiddlyWiki 5.1.22 and earlier): the tiddler is
        //   <div ATTRS><pre>HTML-encoded text</pre></div>
        // (or without the <pre> in even older saves). The text lives in the optional <pre>; other
        // fields — e.g. the favicon's "type" — live in the div's attributes. The previous code
        // returned the raw inner HTML, so SiteTitle/SiteSubtitle came back wrapped in "<pre>…</pre>"
        // and the favicon base64 was unusable.
        // Require whitespace before title= so a rendered body div (data-tiddler-title="…") can't
        // be mistaken for the storeArea div.
        val div = Regex(
            "<div([^>]*\\stitle=\"${Regex.escape(title)}\"[^>]*)>([\\s\\S]*?)</div>",
            RegexOption.IGNORE_CASE
        ).find(html) ?: return null
        if (field == "text") {
            var inner = div.groupValues[2].trim()
            Regex("^<pre>([\\s\\S]*?)</pre>$", RegexOption.IGNORE_CASE).find(inner)?.let { inner = it.groupValues[1] }
            return htmlDecode(inner)
        }
        return Regex("\\b${Regex.escape(field)}=\"([^\"]*)\"", RegexOption.IGNORE_CASE)
            .find(div.groupValues[1])?.let { htmlDecode(it.groupValues[1]) }
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
