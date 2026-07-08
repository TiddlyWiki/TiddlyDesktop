/*
 * Runs inside each wiki window.
 *  - tm-open-window opens the tiddler in a native child Activity (same :wiki process) via TDWindow.
 *    TiddlyWiki's own handler uses window.open, which can't share this WebView's $tw and on Android
 *    causes stray navigation ("Open with") — so we neutralise its popup path.
 *  - A child window (window.__tdFocusTiddler set) has already opened the tiddler via its permalink;
 *    here we just style it as a single-tiddler window (hide the sidebar/topbar chrome).
 */
(function () {
	if (window.__tdOpenWindow) { return; }
	window.__tdOpenWindow = true;

	// Neutralise TiddlyWiki's window.open popup ("" url / "external-*" name); pass real calls through.
	try {
		var _open = window.open ? window.open.bind(window) : null;
		window.open = function (url, name, features) {
			if (!url || (name && /^external-/.test(String(name)))) { return null; }
			try { return _open ? _open(url, name, features) : null; } catch (e) { return null; }
		};
	} catch (e) {}

	function whenReady(fn) {
		if (window.$tw && $tw.rootWidget && $tw.wiki) { fn(); } else { setTimeout(function () { whenReady(fn); }, 200); }
	}

	whenReady(function () {
		if (typeof TDWindow !== "undefined") {
			$tw.rootWidget.addEventListener("tm-open-window", function (event) {
				try {
					var title = event.param || event.tiddlerTitle;
					if (title) { TDWindow.openTiddler(title); }
				} catch (e) {}
				return false;
			});
		}
		var focus = window.__tdFocusTiddler;
		if (focus) {
			try {
				var css = document.createElement("style");
				css.textContent =
					".tc-sidebar-scrollable,.tc-topbar,.tc-sidebar-header{display:none!important;}" +
					".tc-story-river{width:auto!important;max-width:960px;margin:0 auto!important;padding:0.5em;}" +
					".tc-page-container{margin:0!important;}";
				document.head.appendChild(css);
				document.title = focus;
			} catch (e) {}
		}
	});
})();
