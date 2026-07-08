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
 * Output JSON: { kind, url, title, description, image, author, siteName, embed, text }
 * kind ∈ youtube | wikipedia | generic | text
 */
object ShareEnricher {

    private const val TAG = "ShareEnricher"
    private const val UA = "Mozilla/5.0 (Android) TiddlyDesktop"
    private val URL_RE = Regex("""https?://[^\s"'<>]+""")
    private val YT_ID = Regex("""(?:v=|youtu\.be/|/embed/|/shorts/)([A-Za-z0-9_-]{11})""")

    fun enrich(sharedText: String): JSONObject {
        val url = URL_RE.find(sharedText)?.value?.trimEnd('.', ',', ')', ';', '!', '?')
        if (url == null) {
            return base("text", "", sharedText).put("title", firstLine(sharedText))
        }
        return runCatching {
            when {
                isYouTube(url) -> youtube(url)
                isWikipedia(url) -> wikipedia(url)
                else -> generic(url)
            }
        }.getOrElse { Log.w(TAG, "enrich failed: ${it.message}"); linkFallback(url) }
    }

    // ── providers ──────────────────────────────────────────────────────────────────

    private fun isYouTube(url: String) = url.contains("youtube.com/") || url.contains("youtu.be/")

    private fun youtube(url: String): JSONObject {
        val id = YT_ID.find(url)?.groupValues?.get(1)
        val o = base("youtube", url, url)
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
        val o = base("wikipedia", url, url)
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
        val o = base("generic", url, url)
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

    private fun base(kind: String, url: String, text: String) = JSONObject()
        .put("kind", kind).put("url", url).put("text", text)
        .put("title", "").put("description", "").put("image", "").put("author", "").put("siteName", "").put("embed", "")

    private fun linkFallback(url: String) = base("generic", url, url).put("title", url)

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
