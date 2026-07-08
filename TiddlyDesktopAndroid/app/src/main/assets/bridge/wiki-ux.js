/*
 * Runs inside each wiki window. Routes TiddlyWiki's print + fullscreen buttons to native:
 *  - tm-print calls window.print()  -> Android PrintManager
 *  - tm-full-screen calls the DOM Fullscreen API directly (which does nothing useful in a
 *    WebView). We neutralise that API so TW's own handler is a no-op, and drive Android
 *    immersive mode (hide status + nav bars) from our own tm-full-screen listener instead.
 * (Import uses the WebView file chooser and export uses the download listener, both native.)
 */
(function () {
	if (window.__tdWikiUx || typeof TDWikiUX === "undefined") { return; }
	window.__tdWikiUx = true;

	window.print = function () { try { TDWikiUX.print(); } catch (e) {} };

	// Make the DOM Fullscreen API a no-op so TiddlyWiki's tm-full-screen handler can't fight us.
	try {
		var noop = function () { return (window.Promise ? Promise.resolve() : undefined); };
		var de = document.documentElement;
		if (de) {
			de.requestFullscreen = noop; de.webkitRequestFullscreen = noop;
			de.mozRequestFullScreen = noop; de.msRequestFullscreen = noop;
		}
		document.exitFullscreen = noop; document.webkitExitFullscreen = noop;
	} catch (e) {}

	function whenReady(fn) {
		if (window.$tw && $tw.rootWidget) { fn(); } else { setTimeout(function () { whenReady(fn); }, 200); }
	}
	whenReady(function () {
		var on = false;
		$tw.rootWidget.addEventListener("tm-full-screen", function (event) {
			try {
				var p = event.param;
				if (p === "enter") { on = true; }
				else if (p === "exit") { on = false; }
				else { on = !on; }
				TDWikiUX.setFullscreen(on);
			} catch (e) {}
			return false;
		});
	});
})();
