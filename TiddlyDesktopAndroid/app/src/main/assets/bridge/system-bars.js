/*
 * Reports the current TiddlyWiki palette's background + foreground colors to native so the
 * Android status/navigation bars can be tinted to match (see host/SystemBars.kt). Injected
 * into the WikiList and every wiki window. Re-reports when the palette or theme changes.
 */
(function () {
	if (window.__tdBarsInstalled) return;
	if (typeof TDBars === "undefined") return;

	function ready() {
		return window.$tw && $tw.wiki && $tw.rootWidget && document.body;
	}

	// Resolve any CSS color (hex/name/rgb) to a concrete "rgb(r, g, b)" via the browser.
	function resolveCss(c) {
		try {
			var el = document.createElement("span");
			el.style.color = "";
			el.style.color = c;
			if (!el.style.color) return c; // invalid value
			document.body.appendChild(el);
			var rgb = getComputedStyle(el).color;
			document.body.removeChild(el);
			return rgb || c;
		} catch (e) { return c; }
	}

	function report() {
		try {
			var palTitle = $tw.wiki.getTiddlerText("$:/palette", "");
			var data = $tw.wiki.getTiddlerDataCached(palTitle, {});
			var bg = resolveCss(data.background || "#ffffff");
			var fg = resolveCss(data.foreground || "#000000");
			TDBars.setSystemBarColors(bg, fg);
		} catch (e) {}
	}

	function init() {
		if (!ready()) { setTimeout(init, 300); return; }
		window.__tdBarsInstalled = true;
		report();
		// Re-report on palette/theme change (covers the theme+palette pickers).
		$tw.wiki.addEventListener("change", function (changes) {
			if (changes["$:/palette"] || changes["$:/theme"]) { setTimeout(report, 50); return; }
			// Also when the active palette tiddler's own content changed.
			var pal = $tw.wiki.getTiddlerText("$:/palette", "");
			if (pal && changes[pal]) { setTimeout(report, 50); }
		});
	}

	init();
})();
