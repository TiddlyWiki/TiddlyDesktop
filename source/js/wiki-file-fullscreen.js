/*
Runs IN the single-file wiki window's OWN context (loaded by a <script> in wiki-file-window.html),
NOT in the backstage process.

Native fullscreen must be handled here, in the window's own process, so that win.isFullscreen and
timers are reliable — exactly like folder wikis, which run their fullscreen in their own process
(wiki-folder-main.js). Driving it from backstage does not work because those signals are not
observable across the process boundary. (NW.js on Linux emits no maximize/fullscreen events at all,
so fullscreen.js relies on polling win.isFullscreen, not on events.)

Everything else about the single-file window (saving, find bar, embeds, links, …) is still set up
from backstage in wiki-file-window.js; only fullscreen needs to live here.
*/

"use strict";

(function() {
	var gui, fullscreen;
	try {
		gui = require("nw.gui");
		fullscreen = require("../js/utils/fullscreen.js");
	} catch(e) {
		try { console.error("[TiddlyDesktop] in-window fullscreen unavailable:", e); } catch(_e) {}
		return;
	}
	var win = gui.Window.get();
	var iframe = document.getElementById("tid-main-wiki-file-viewer");
	if(!iframe) { return; }

	// Hand fullscreen.js THIS window's own setTimeout, captured here in the clean host context.
	// fullscreen.js's monitor loop uses it so its timers fire reliably: under NW.js --mixed-context a
	// setTimeout scheduled from inside the iframe's widget dispatch (the button's call stack) never
	// fires, but this captured host setTimeout does.
	try { win.__tdHostSetTimeout = window.setTimeout.bind(window); } catch(e) {}

	function getRootWidget() {
		try {
			var cw = iframe.contentWindow;
			return cw && cw.$tw && cw.$tw.rootWidget;
		} catch(e) { return null; }
	}

	function install() {
		var idoc;
		try { idoc = iframe.contentDocument; } catch(e) { return; }
		if(!idoc) { return; }
		// install() is idempotent for window-level wiring and re-does the per-document wiring (F11 on
		// the iframe document, button reroute) for whatever document is currently loaded.
		fullscreen.install(win, idoc, getRootWidget);
	}

	// The iframe's src is set later by backstage (WikiFileWindow.onloaded); re-wire on each load so
	// the F11 binding and button reroute attach to the freshly-loaded wiki document.
	iframe.addEventListener("load", install);
	install();  // in case the wiki is already loaded
})();
