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
			// Generous tolerance: a maximized window doesn't always equal the work area exactly
			// — on Windows it OVERHANGS it by a few px (the invisible resize borders), so a tight
			// tolerance reports "not maximized". Treat "covers the work area (give or take ~40px)"
			// as maximized.
			var tol = 40;
			return Math.abs(win.width - scr.availWidth) <= tol &&
			       Math.abs(win.height - scr.availHeight) <= tol;
		}
	} catch(e) {}
	return !!win.__tdMaximized;
}

// Restore the window after it has LEFT fullscreen: move it back to its original screen and, if
// it was maximized, re-maximize. Consumes win.__tdPreFs so it runs at most once per fullscreen
// cycle (whether triggered by the poll below or by a leave-fullscreen event, if one fires).
function restoreAfterFullscreen(win) {
	var pre = win.__tdPreFs;
	win.__tdPreFs = null;
	win.__tdEnteringFs = false;
	if(!pre) { return; }
	if(!pre.maximized) {
		setTimeout(function() {
			try { win.moveTo(pre.x, pre.y); win.resizeTo(pre.width, pre.height); } catch(e) {}
		}, 80);
		return;
	}
	// Re-maximize. Several things fight us, all timing-sensitive: maximize() is a no-op when the
	// window already fills the work area (so we shrink first to force a real state transition);
	// NW.js may still be settling bounds for a moment after fullscreen ends; and it can re-restore
	// the pre-fullscreen bounds shortly AFTER an early maximize(), un-doing it. So we don't trust
	// a single success: we keep re-asserting until the window reads as maximized on TWO
	// consecutive checks (≈400ms of stability), re-shrinking+maximizing whenever it isn't. Capped.
	win.__tdMaximized = true;
	var tries = 0, stable = 0;
	function remax() {
		if(tries >= 15) { return; }
		tries++;
		try {
			if(win.isFullscreen) { setTimeout(remax, 120); return; }  // still leaving fullscreen
			if(_isMaximized(win)) {
				if(++stable >= 2) { return; }                          // held maximized — done
			} else {
				stable = 0;
				win.moveTo(pre.x, pre.y);
				win.resizeTo(Math.max(640, (pre.width || 1000) - 160), Math.max(480, (pre.height || 700) - 160));
				win.maximize();
			}
		} catch(e) {}
		setTimeout(remax, 200);
	}
	// Initial delay so NW.js has finished tearing down fullscreen before the first attempt.
	setTimeout(remax, 200);
}

// NW.js does not reliably emit a `leave-fullscreen` event on every platform (notably Linux), so
// we cannot depend on it. After entering fullscreen we poll win.isFullscreen; once it has gone
// true (entered) and then false again (left), we run the restore.
function startLeavePoll(win) {
	if(win.__tdFsPoll) { clearInterval(win.__tdFsPoll); }
	var sawFull = false, ticks = 0;
	var id = win.__tdFsPoll = setInterval(function() {
		ticks++;
		try {
			if(win.isFullscreen) { sawFull = true; return; }
			if(sawFull) {
				clearInterval(win.__tdFsPoll); win.__tdFsPoll = null;
				restoreAfterFullscreen(win);
				return;
			}
			// Never reported fullscreen within ~6s → give up polling.
			if(ticks > 40) { clearInterval(win.__tdFsPoll); win.__tdFsPoll = null; }
		} catch(e) { try { clearInterval(win.__tdFsPoll); } catch(_e) {} win.__tdFsPoll = null; }
	}, 150);
	// Don't let this poll keep the window's process alive if the window is closed mid-fullscreen.
	try { if(id && id.unref) { id.unref(); } } catch(e) {}
}

// Toggle the native fullscreen state of an nw.js Window. Entering snapshots the window's
// current bounds, the screen it's on, and its maximized state — because NW.js native
// fullscreen otherwise drops back to default bounds on leave, and on multi-monitor it can
// move the window to the primary screen and leave it there. The restore runs when the window
// leaves fullscreen, detected by polling (startLeavePoll) since NW.js's leave-fullscreen event
// is unreliable across platforms.
function toggle(win_nwjs) {
	try {
		if(win_nwjs.isFullscreen) {
			win_nwjs.leaveFullscreen();
		} else {
			win_nwjs.__tdPreFs = {
				x:         win_nwjs.x,
				y:         win_nwjs.y,
				width:     win_nwjs.width,
				height:    win_nwjs.height,
				maximized: _isMaximized(win_nwjs)
			};
			// On some platforms entering fullscreen on a maximized window auto-un-maximizes it,
			// firing an `unmaximize` event; this flag tells that handler (in install) the
			// un-maximize was caused by us entering fullscreen, so it records "was maximized" on
			// the snapshot rather than treating it as the user un-maximizing. (Maximized detection
			// primarily comes from _isMaximized above; this is just a belt-and-suspenders for
			// platforms that do fire the event. Cleared after the transition window.)
			win_nwjs.__tdEnteringFs = true;
			setTimeout(function() { try { win_nwjs.__tdEnteringFs = false; } catch(e) {} }, 1500);
			win_nwjs.enterFullscreen();
			startLeavePoll(win_nwjs);
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
	try { win_nwjs.on("maximize", function() { win_nwjs.__tdMaximized = true; }); } catch(e) {}
	try {
		win_nwjs.on("unmaximize", function() {
			// If this un-maximize was caused by entering fullscreen (see toggle), it proves the
			// window WAS maximized — record that on the pending snapshot so we re-maximize on
			// leave, and DON'T treat it as the user choosing to un-maximize.
			if(win_nwjs.__tdEnteringFs) {
				if(win_nwjs.__tdPreFs) { win_nwjs.__tdPreFs.maximized = true; }
			} else {
				win_nwjs.__tdMaximized = false;
			}
		});
	} catch(e) {}
	// Backup only: if a real leave-fullscreen event DOES fire on this platform, run the same
	// restore. It's a no-op if the poll already handled it (restoreAfterFullscreen consumes the
	// snapshot), so the two can't double-run.
	try {
		win_nwjs.on("leave-fullscreen", function() {
			restoreAfterFullscreen(win_nwjs);
		});
	} catch(e) {}
	// Route the wiki document's OWN fullscreen request to the native toggle.
	//
	// The wiki iframe carries allow="fullscreen *" (so embedded YouTube/Vimeo players can go
	// fullscreen). A side effect is that TiddlyWiki's core tm-full-screen handler
	// (rootwidget.js) can now actually HTML5-fullscreen the WIKI document — which fights the
	// native-window fullscreen this module manages: the window flashes fullscreen and then
	// drops straight back to normal, losing the maximized state. (F11 is unaffected because it
	// calls toggle() directly and never goes through requestFullscreen.) Overriding the wiki
	// documentElement's requestFullscreen here makes the core handler — and any other caller —
	// drive the native window instead. toggle() decides enter vs. leave from win.isFullscreen,
	// so it is correct in both directions. Embedded players are in SEPARATE documents, so their
	// own requestFullscreen is untouched and still works.
	try {
		var de = doc.documentElement;
		if(de && !de.__tdFsRerouted) {
			de.__tdFsRerouted = true;
			["requestFullscreen", "webkitRequestFullscreen", "mozRequestFullScreen", "msRequestFullscreen"].forEach(function(m) {
				if(typeof de[m] === "function") {
					de[m] = function() {
						toggle(win_nwjs);
						return (typeof Promise !== "undefined") ? Promise.resolve() : undefined;
					};
				}
			});
		}
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
	// NOTE: the fullscreen page-control button is handled via the requestFullscreen override
	// above, NOT by adding a tm-full-screen listener on the rootWidget. A second listener would
	// double-toggle: a single-file wiki carries its OWN embedded TiddlyWiki whose version we do
	// not control, and if its Widget.addEventListener uses the array form (multiple handlers per
	// type) our listener would run ALONGSIDE the core one — core enters native fullscreen via
	// requestFullscreen→override, ours leaves it — so the window just flashes fullscreen. The
	// override is version-independent (it intercepts the one requestFullscreen call the core
	// handler always makes) and produces exactly one toggle. The getRootWidget argument is kept
	// for backward compatibility but is no longer used.
};
