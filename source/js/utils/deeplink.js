/*
Handle incoming `tiddlydesktop://` deep links — currently the OAuth relay's post-login redirect
(tiddlydesktop://auth?state=…).

When the system browser navigates to tiddlydesktop://… the OS launches this app's binary with the
URL. NW.js is single-instance, so a second launch forwards its command line to the already-running
instance via the App "open" event; a cold launch carries the URL in gui.App.argv. Either way we
bring the app back to the front (the window the user was last in, falling back to the backstage
window). The OAuth token itself is finalised by oauth.js's relay result-polling, so the deep link's
job is purely to return focus to the app — that already makes "redirect back to the app" work.
*/

"use strict";

// NOTE: do NOT require("nw.gui") here — that module is only resolvable from the page's main script
// (main.js), not from a require()'d sub-module, so requiring it would throw and abort boot. main.js
// hands us its gui handle via install() instead.
var gui = null;

var _backstageWindow = null;

// Pull a tiddlydesktop:// URL out of an argv entry or a forwarded command-line string.
function extractUrl(s) {
	if(!s) { return null; }
	var m = String(s).match(/tiddlydesktop:\/\/[^\s"']+/i);
	return m ? m[0] : null;
}
exports.extractUrl = extractUrl;

// Bring the app to the foreground: focus the window the user was last in (tracked on
// $tw.desktop.lastFocusedWindow), else the backstage window.
// Try to bring one window to the front. Returns true only if it succeeded — a stale handle
// (the window was closed) throws, so the caller falls through to the next candidate.
function tryFocus(target) {
	var win = target && target.window_nwjs;
	if(!win) { return false; }
	try {
		win.show();
		try { win.restore(); } catch(e) {}   // un-minimise if needed
		win.focus();
		return true;
	} catch(e) { return false; }
}

function focusApp() {
	var desktop = global.$tw && global.$tw.desktop;
	if(desktop) {
		// Prefer the window that started OAuth (opened the browser), then the last-focused window,
		// returning to where sign-in was initiated rather than backstage. Each is tried in turn so
		// a closed/stale handle just falls through.
		if(tryFocus(desktop.oauthOriginWindow)) { return; }
		if(tryFocus(desktop.lastFocusedWindow)) { return; }
	}
	if(_backstageWindow) {
		try { _backstageWindow.show(); } catch(e) {}
		try { _backstageWindow.focus(); } catch(e) {}
	}
}

// Act on a single deep-link URL. Returns true if it was one of ours.
function handleUrl(url) {
	if(!url || String(url).toLowerCase().indexOf("tiddlydesktop://") !== 0) { return false; }
	focusApp();
	return true;
}
exports.handleUrl = handleUrl;

// Wire the running-instance hook. NW.js fires App "open" when another launch of the app (e.g. the
// browser opening tiddlydesktop://) forwards its command line here.
exports.install = function(backstageWindow, guiRef) {
	_backstageWindow = backstageWindow;
	gui = guiRef || gui;
	try {
		if(gui && gui.App) {
			gui.App.on("open", function(args) {
				var url = extractUrl(args);
				if(url) { handleUrl(url); }
			});
		}
	} catch(e) {}
};

// Cold start: the app may have been launched BY the deep link, with the URL among argv. Returns the
// URL if found (the caller removes it from the wiki-open args and handles it once booted).
exports.findColdStartUrl = function(argv) {
	for(var i = 0; i < (argv || []).length; i++) {
		var url = extractUrl(argv[i]);
		if(url) { return url; }
	}
	return null;
};
