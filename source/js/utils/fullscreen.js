/*
Native window fullscreen for TiddlyDesktop wiki windows.

TiddlyWiki's own fullscreen (the tm-full-screen page-control button / shortcut) uses the
HTML5 *document* Fullscreen API. In NW.js that doesn't give a real windowed-fullscreen,
and inside a single-file wiki's `nwdisable` iframe (which has no `allowfullscreen`) it is
blocked outright. So we toggle the native NW.js window instead, and bind F11 to it.
*/

"use strict";

// Is the window currently maximized? NW.js has no synchronous getter, and the
// maximize/unmaximize events miss a window that was ALREADY maximized when tracking
// started (e.g. restored maximized on open). So detect it directly: a maximized window
// fills its screen's work area. Uses the window's own DOM screen (the display it's on),
// with the event-tracked flag as a fallback.
function _isMaximized(win) {
	try {
		var scr = win.window && win.window.screen;
		if(scr && scr.availWidth) {
			var tol = 12;
			return Math.abs(win.width - scr.availWidth) <= tol &&
			       Math.abs(win.height - scr.availHeight) <= tol;
		}
	} catch(e) {}
	return !!win.__tdMaximized;
}

// Toggle the native fullscreen state of an nw.js Window. Entering stores the current
// maximized state (so leaving can restore it — NW.js otherwise drops back to normal
// bounds). The actual re-maximize happens on the leave-fullscreen event (wired in
// install()), which fires when the transition has settled — including an Esc-exit.
function toggle(win_nwjs) {
	try {
		if(win_nwjs.isFullscreen) {
			win_nwjs.leaveFullscreen();
		} else {
			win_nwjs.__tdMaxBeforeFs = _isMaximized(win_nwjs);
			win_nwjs.enterFullscreen();
		}
	} catch(e) {}
}
exports.toggle = toggle;

/*
Wire fullscreen for a wiki window.
  win_nwjs       - the nw.js Window to toggle
  doc            - the document where the wiki content lives (folder wiki: the window's
                   document; single-file wiki: the iframe's document) — F11 is bound here
  getRootWidget  - optional function returning that wiki's $tw.rootWidget (it may still be
                   booting, so we retry); used to reroute the fullscreen button
*/
exports.install = function(win_nwjs, doc, getRootWidget) {
	// Track maximized state on this (local) window handle so toggle() can restore it
	// after leaving fullscreen. For folder wikis this handle lives in the wiki's own
	// process, distinct from the backstage-side handle window-base tracks, so we must
	// observe the events here too.
	try { win_nwjs.on("maximize",   function() { win_nwjs.__tdMaximized = true;  }); } catch(e) {}
	try { win_nwjs.on("unmaximize", function() { win_nwjs.__tdMaximized = false; }); } catch(e) {}
	// Restore the pre-fullscreen maximized state once the leave-fullscreen transition has
	// settled (more reliable than a timer, and also covers exiting fullscreen via Esc).
	try {
		win_nwjs.on("leave-fullscreen", function() {
			if(win_nwjs.__tdMaxBeforeFs) {
				win_nwjs.__tdMaxBeforeFs = false;
				setTimeout(function() { try { win_nwjs.maximize(); } catch(e) {} }, 30);
			}
		});
	} catch(e) {}
	function onKey(e) {
		if(e.key === "F11" || e.keyCode === 122) {
			e.preventDefault();
			e.stopPropagation();
			toggle(win_nwjs);
		}
	}
	try { doc.addEventListener("keydown", onKey, true); } catch(e) {}
	// Also bind the host window's document once (in single-file wikis focus may be on the
	// host chrome, e.g. the find bar). Guarded so iframe reloads don't stack duplicates.
	try {
		var host = win_nwjs.window && win_nwjs.window.document;
		if(host && host !== doc && !win_nwjs.window.__tdFullscreenKeyBound) {
			win_nwjs.window.__tdFullscreenKeyBound = true;
			host.addEventListener("keydown", onKey, true);
		}
	} catch(e) {}
	// Reroute the fullscreen page-control button. The rootWidget stores ONE handler per
	// message type, so adding ours overrides TiddlyWiki's HTML5-document handler. The wiki
	// may still be booting, so retry until its rootWidget appears (then give up quietly —
	// F11 still works regardless).
	if(typeof getRootWidget === "function") {
		var tries = 0;
		(function bind() {
			var rw = null;
			try { rw = getRootWidget(); } catch(e) {}
			if(rw && typeof rw.addEventListener === "function") {
				rw.addEventListener("tm-full-screen", function() { toggle(win_nwjs); return false; });
			} else if(++tries < 100) {
				setTimeout(bind, 100);
			}
		}());
	}
};
