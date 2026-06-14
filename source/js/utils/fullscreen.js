/*
Native window fullscreen for TiddlyDesktop wiki windows.

TiddlyWiki's own fullscreen (the tm-full-screen page-control button / shortcut) uses the
HTML5 *document* Fullscreen API. In NW.js that doesn't give a real windowed-fullscreen,
and inside a single-file wiki's `nwdisable` iframe (which has no `allowfullscreen`) it is
blocked outright. So we toggle the native NW.js window instead, and bind F11 to it.
*/

"use strict";

// Toggle the native fullscreen state of an nw.js Window. Leaving fullscreen restores
// the maximized state the window had before going fullscreen (NW.js otherwise drops
// back to normal bounds). The pre-fullscreen maximized state is read from __tdMaximized,
// kept current by the maximize/unmaximize listeners in install().
function toggle(win_nwjs) {
	try {
		if(win_nwjs.isFullscreen) {
			var wasMaximized = win_nwjs.__tdMaxBeforeFs;
			win_nwjs.leaveFullscreen();
			win_nwjs.__tdMaxBeforeFs = false;
			// leaveFullscreen needs a tick to settle before maximize takes effect.
			if(wasMaximized) { setTimeout(function() { try { win_nwjs.maximize(); } catch(e) {} }, 60); }
		} else {
			win_nwjs.__tdMaxBeforeFs = !!win_nwjs.__tdMaximized;
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
