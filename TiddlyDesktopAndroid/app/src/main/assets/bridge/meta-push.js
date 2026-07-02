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

	function push() {
		try {
			TDMeta.setMeta(
				$tw.wiki.getTiddlerText("$:/SiteTitle", ""),
				$tw.wiki.getTiddlerText("$:/SiteSubtitle", ""),
				faviconData()
			);
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
