/*
 * Runs inside each wiki window. Uses TiddlyWiki's own change events to push this wiki's
 * SiteTitle / SiteSubtitle / favicon to the WikiList (via the TDMeta bridge -> a broadcast
 * to the main process), so the list updates instantly and without re-reading files.
 */
(function () {
	if (window.__tdMetaPush) { return; }
	window.__tdMetaPush = true;
	if (typeof TDMeta === "undefined") { return; }

	function ready() { return window.$tw && $tw.wiki && $tw.rootWidget; }

	function faviconData() {
		try {
			var t = $tw.wiki.getTiddler("$:/favicon.ico");
			if (!t || !t.fields.text) { return ""; }
			var type = t.fields.type || "image/x-icon";
			return "data:" + type + ";base64," + String(t.fields.text).replace(/\s/g, "");
		} catch (e) { return ""; }
	}

	// Render SiteTitle/SiteSubtitle to plain text here, in the wiki's own context — the same thing
	// TiddlyWiki does for document.title (which the desktop app reads directly). So wikitext markup
	// like @@color:blue;My Wiki@@ (and transclusions) resolve, instead of the row showing raw source.
	function renderPlain(title) {
		try {
			var t = $tw.wiki.getTiddler(title);
			if (!t || !t.fields.text) { return ""; }
			return $tw.wiki.renderTiddler("text/plain", title).trim();
		} catch (e) {
			return $tw.wiki.getTiddlerText(title, "");
		}
	}

	function push() {
		try {
			TDMeta.setMeta(renderPlain("$:/SiteTitle"), renderPlain("$:/SiteSubtitle"), faviconData());
		} catch (e) {}
	}

	function init() {
		if (!ready()) { setTimeout(init, 300); return; }
		push();
		$tw.wiki.addEventListener("change", function (ch) {
			if (ch["$:/SiteTitle"] || ch["$:/SiteSubtitle"] || ch["$:/favicon.ico"]) {
				setTimeout(push, 60);
			}
		});
	}
	init();
})();
