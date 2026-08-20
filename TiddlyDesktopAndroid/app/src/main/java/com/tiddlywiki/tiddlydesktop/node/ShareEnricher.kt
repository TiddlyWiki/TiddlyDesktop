package com.tiddlywiki.tiddlydesktop.node

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Turns a shared URL/text into rich metadata (title, description, image, embed, …) so the
 * WikiList can render a nice tiddler from a share template. Runs off the main thread; all network
 * is done natively (the WebView couldn't fetch these cross-origin). Always returns *something*
 * (falls back to a plain link) — never throws.
 *
 * Output JSON: { kind, url, title, description, image, author, siteName, embed, text, selection }
 * kind ∈ youtube | wikipedia | generic | text
 *
 * `text` is always the raw shared payload and `selection` is that payload minus the link. The
 * providers below describe the PAGE; none of them can know what the user highlighted, so neither
 * field is theirs to set — enrich() fills both in afterwards. See selectionOf().
 */
object ShareEnricher {

    private const val TAG = "ShareEnricher"
    private const val UA = "Mozilla/5.0 (Android) TiddlyDesktop"
    private val URL_RE = Regex("""https?://[^\s"'<>]+""")
    private val YT_ID = Regex("""(?:v=|youtu\.be/|/embed/|/shorts/)([A-Za-z0-9_-]{11})""")

    fun enrich(sharedText: String): JSONObject {
        val url = URL_RE.find(sharedText)?.value?.trimEnd('.', ',', ')', ';', '!', '?')
        val o = if (url == null) {
            base("text", "").put("title", firstLine(sharedText))
        } else {
            runCatching {
                when {
                    isYouTube(url) -> youtube(url)
                    isWikipedia(url) -> wikipedia(url)
                    else -> generic(url)
                }
            }.getOrElse { Log.w(TAG, "enrich failed: ${it.message}"); linkFallback(url) }
        }
        // Filled in here, not in the providers: whichever branch ran, and whether or not it managed
        // to fetch anything, the user's own words survive. They used to be dropped outright — every
        // provider built its result with the URL as `text`, so sharing a SELECTION from a page gave
        // a tiddler containing the link and nothing that had been highlighted.
        return o.put("text", sharedText).put("selection", selectionOf(sharedText))
    }

    /**
     * The user's own words: the shared payload with the link taken out.
     *
     * Sharing a selection rather than a whole page is what this is for. Android hands us a single
     * EXTRA_TEXT string whose shape is up to the sharing app, and all three common shapes have to
     * arrive here as the same thing:
     *
     *   the selection alone                 → itself
     *   the selection plus the page link    → the selection (the link, and the dash or blank line
     *                                          an app puts between them, are dropped)
     *   a bare link with a text fragment    → the highlighted words, decoded from `#:~:text=`,
     *                                          which is how Chrome shares a highlight
     *
     * Sharing a plain page gives "", so a template can test for a selection with
     * `<$reveal type="nomatch" text="" default=...>` rather than emitting an empty quote.
     */
    fun selectionOf(sharedText: String): String {
        val stripped = URL_RE.replace(sharedText, "").trim()
            // What pulling the link out leaves behind: the separator an app wrote between the quote
            // and the link, plus the surrounding blank line.
            .trim('\u2014', '\u2013', '-', '|', '\u00b7', '\u2022', ':', ';', ',')
            .trim()
        if (stripped.isNotBlank()) return stripped
        // Nothing but a link — but the link itself may carry the highlight.
        return URL_RE.find(sharedText)?.value?.let { textFragment(it) }.orEmpty()
    }

    /**
     * The highlight carried in a URL text fragment (`#:~:text=...`).
     *
     * The syntax is `[prefix-,]start[,end][,-suffix]`, percent-encoded, repeatable as `&text=`.
     * The prefix/suffix parts only locate the highlight in the page — they are not part of it --
     * so they are dropped, and a start,end range is rejoined with an ellipsis.
     */
    private fun textFragment(url: String): String {
        val raw = url.substringAfter("#:~:text=", "")
        if (raw.isEmpty()) return ""
        val quotes = mutableListOf<String>()
        raw.split("&").forEachIndexed { i, part ->
            // The first piece is the value the regex already consumed; later ones count only if
            // they are further text fragments rather than some other fragment parameter.
            val v = when {
                i == 0 -> part
                part.startsWith("text=") -> part.removePrefix("text=")
                else -> return@forEachIndexed
            }
            val core = v.split(",").filterNot { it.endsWith("-") || it.startsWith("-") }
            if (core.isNotEmpty()) quotes.add(core.joinToString(" \u2026 ") { pctDecode(it) })
        }
        return quotes.joinToString(" \u2026 ").trim()
    }

    /**
     * Percent-decode a URL fragment. NOT URLDecoder.decode alone: that also turns "+" into a space,
     * which is a form-encoding rule and would corrupt a highlight containing a plus sign. Fragments
     * spell a space as %20.
     */
    private fun pctDecode(s: String): String =
        runCatching { java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)

    // ── providers ──────────────────────────────────────────────────────────────────

    private fun isYouTube(url: String) = url.contains("youtube.com/") || url.contains("youtu.be/")

    private fun youtube(url: String): JSONObject {
        val id = YT_ID.find(url)?.groupValues?.get(1)
        val o = base("youtube", url)
        if (id != null) o.put("embed", "https://www.youtube.com/embed/$id")
        runCatching {
            val json = fetch("https://www.youtube.com/oembed?format=json&url=" + enc(url), "application/json")
            if (json != null) {
                val j = JSONObject(json)
                o.put("title", j.optString("title").ifBlank { "YouTube video" })
                o.put("author", j.optString("author_name"))
                o.put("image", j.optString("thumbnail_url"))
            }
        }
        if (o.optString("title").isBlank() || o.optString("title") == url) o.put("title", "YouTube video")
        return o
    }

    private fun isWikipedia(url: String) = Regex("""https?://[a-z-]+\.(m\.)?wikipedia\.org/wiki/""").containsMatchIn(url)

    private fun wikipedia(url: String): JSONObject {
        val m = Regex("""https?://([a-z-]+)\.(?:m\.)?wikipedia\.org/wiki/([^#?]+)""").find(url)
            ?: return generic(url)
        val lang = m.groupValues[1]; val title = m.groupValues[2]
        val o = base("wikipedia", url)
        runCatching {
            val json = fetch("https://$lang.wikipedia.org/api/rest_v1/page/summary/$title", "application/json")
            if (json != null) {
                val j = JSONObject(json)
                o.put("title", j.optString("title").ifBlank { decode(title) })
                o.put("description", j.optString("extract"))
                o.optJSONObject("thumbnail") // noop
                j.optJSONObject("thumbnail")?.let { o.put("image", it.optString("source")) }
                o.put("siteName", "Wikipedia")
            }
        }
        if (o.optString("title").isBlank()) o.put("title", decode(title))
        return o
    }

    private fun generic(url: String): JSONObject {
        val html = fetch(url, "text/html") ?: return linkFallback(url)
        val head = html.take(300_000)
        val o = base("generic", url)
        o.put("title", (og(head, "title") ?: titleTag(head) ?: url))
        og(head, "description")?.let { o.put("description", it) } ?: metaDesc(head)?.let { o.put("description", it) }
        og(head, "image")?.let { o.put("image", absUrl(url, it)) }
        og(head, "site_name")?.let { o.put("siteName", it) }
        return o
    }

    // ── metadata parsing ─────────────────────────────────────────────────────────────

    private fun og(html: String, prop: String): String? {
        // property="og:x" content="..."  OR  content="..." property="og:x" (either attribute order)
        val a = Regex("""<meta[^>]+property=["']og:$prop["'][^>]+content=["']([^"']*)["']""", RegexOption.IGNORE_CASE)
        val b = Regex("""<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:$prop["']""", RegexOption.IGNORE_CASE)
        return (a.find(html)?.groupValues?.get(1) ?: b.find(html)?.groupValues?.get(1))?.let { htmlDecode(it) }?.ifBlank { null }
    }

    private fun titleTag(html: String): String? =
        Regex("""<title[^>]*>([\s\S]*?)</title>""", RegexOption.IGNORE_CASE).find(html)
            ?.groupValues?.get(1)?.let { htmlDecode(it.trim()) }?.ifBlank { null }

    private fun metaDesc(html: String): String? =
        Regex("""<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']""", RegexOption.IGNORE_CASE)
            .find(html)?.groupValues?.get(1)?.let { htmlDecode(it) }?.ifBlank { null }

    // ── helpers ────────────────────────────────────────────────────────────────────

    // `text` and `selection` are placeholders here; enrich() sets them from the shared payload once
    // the provider has run, so a provider cannot overwrite what the user actually shared.
    private fun base(kind: String, url: String) = JSONObject()
        .put("kind", kind).put("url", url).put("text", "").put("selection", "")
        .put("title", "").put("description", "").put("image", "").put("author", "").put("siteName", "").put("embed", "")

    private fun linkFallback(url: String) = base("generic", url).put("title", url)

    private fun fetch(urlStr: String, accept: String): String? = runCatching {
        val c = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 5000; readTimeout = 5000; instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA); setRequestProperty("Accept", accept)
        }
        try {
            if (c.responseCode !in 200..299) return null
            c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }.getOrNull()

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    private fun decode(s: String) = java.net.URLDecoder.decode(s, "UTF-8").replace('_', ' ')
    private fun firstLine(s: String) = s.trim().lineSequence().firstOrNull()?.take(80)?.trim().orEmpty().ifBlank { "Shared note" }

    private fun absUrl(pageUrl: String, ref: String): String = runCatching {
        if (ref.startsWith("http")) ref else URL(URL(pageUrl), ref).toString()
    }.getOrDefault(ref)

    private fun htmlDecode(s: String): String = s
        .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&nbsp;", " ")
        .replace(Regex("""&#(\d+);""")) { runCatching { String(Character.toChars(it.groupValues[1].toInt())) }.getOrDefault(it.value) }
}
