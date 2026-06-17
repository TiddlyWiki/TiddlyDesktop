/*
Native window fullscreen for TiddlyDesktop wiki windows.

Runs IN the wiki window's OWN process (folder: wiki-folder-main.js; single-file:
wiki-file-fullscreen.js; backstage: main.js). F11 and the wiki's fullscreen button both call
toggle(), which simply enters/leaves native fullscreen.

Maximize handling: NW.js does NOT preserve the maximized state across native fullscreen (and on
Linux emits no maximize/fullscreen events), so a separate "monitor" — a timer loop started once at
install — watches win.isFullscreen and, when the window leaves fullscreen having been maximized
before, re-maximizes it.

Why a standalone monitor instead of doing it inside toggle(): for single-file wikis the fullscreen
BUTTON runs our handler inside TiddlyWiki's synchronous widget dispatch (in the nwdisable iframe).
Under NW.js --mixed-context, a setTimeout scheduled from THAT call stack never fires and window
reads are skewed — so any "wait then re-maximize" logic started from the button path silently dies.
F11 works because it runs in a clean DOM-event context. The monitor is started at install time in
the clean host context, so its timers fire reliably; toggle() then only needs to issue the
enter/leave command (which works from any context), and the monitor does the rest.
*/

"use strict";

// Schedule fn on the wiki window's OWN timer queue. The single-file in-context loader hands us
// win.__tdHostSetTimeout (the host window's bound setTimeout); folder/backstage windows leave it
// unset and the ambient setTimeout is already correct.
function later(win, fn, ms) {
	try { (win.__tdHostSetTimeout || setTimeout)(fn, ms); } catch(e) { try { setTimeout(fn, ms); } catch(_e) {} }
}

// Is the window currently maximized, judged by bounds vs the work area (NW has no getter). Generous
// tolerance (Windows maximized windows overhang the work area by the invisible resize borders).
function isMaximized(win) {
	try {
		var scr = win.window && win.window.screen;
		if(scr && scr.availWidth) {
			var tol = 40;
			return Math.abs(win.width - scr.availWidth) <= tol && Math.abs(win.height - scr.availHeight) <= tol;
		}
	} catch(e) {}
	return false;
}

// Start the fullscreen monitor once per window (in the clean install context). It continuously
// tracks whether the (windowed) window is maximized, and when the window LEAVES fullscreen having
// been maximized beforehand, re-maximizes it. The window returns to its normal bounds on leaving,
// so a plain maximize() is a clean transition.
function startMonitor(win) {
	if(win.__tdMonitor) { return; }
	win.__tdMonitor = true;
	var prevFs = false, maxBeforeFs = false;
	(function tick() {
		try {
			var fs = !!win.isFullscreen;
			if(prevFs && !fs && maxBeforeFs) {
				// Just left fullscreen and had been maximized → re-maximize (twice, to beat any late
				// bounds change the WM applies right after leaving).
				try { win.maximize(); } catch(e) {}
				later(win, function() { try { win.maximize(); } catch(e) {} }, 250);
			}
			if(!fs) { maxBeforeFs = isMaximized(win); }  // remember the windowed maximized state
			prevFs = fs;
		} catch(e) {}
		later(win, tick, 150);
	})();
}

function toggle(win) {
	try {
		// Debounce: the fullscreen button can dispatch tm-full-screen more than once per click.
		var now = Date.now();
		if(now - (win.__tdLastToggle || 0) < 400) { return; }
		win.__tdLastToggle = now;
		// Just flip fullscreen — the monitor handles re-maximizing on leave. Both enterFullscreen and
		// leaveFullscreen work from any call context; only timers/reads are context-sensitive, and
		// those live in the monitor.
		if(win.isFullscreen) { win.leaveFullscreen(); }
		else { win.enterFullscreen(); }
	} catch(e) {}
}
exports.toggle = toggle;

/*
Wire fullscreen for a wiki window. Idempotent: window-level wiring (host F11 + the monitor) happens
once per window; per-document wiring (F11 in the wiki document, button reroute) is redone each call
so a single-file iframe that reloads gets re-wired onto its fresh document.
  win_nwjs       - the nw.js Window to toggle (must be THIS process's own handle)
  doc            - the document the wiki content lives in (folder: the window's document; single-file:
                   the iframe's document) — F11 is bound here
  getRootWidget  - optional function returning the wiki's $tw.rootWidget (it may still be booting, so
                   we retry); used to reroute the fullscreen page-control button
*/
exports.install = function(win_nwjs, doc, getRootWidget) {
	// Window-level wiring (once): host-document F11 and the fullscreen monitor. Done in this (clean)
	// install context so the monitor's timers fire reliably.
	if(!win_nwjs.__tdFsWired) {
		win_nwjs.__tdFsWired = true;
		try {
			var host = win_nwjs.window && win_nwjs.window.document;
			if(host) { host.addEventListener("keydown", makeOnKey(win_nwjs), true); }
		} catch(e) {}
		startMonitor(win_nwjs);
	}
	// Per-document: F11 inside the wiki document when it's separate from the host (single-file iframe;
	// for folder wikis doc IS the host document, already bound above).
	try {
		var hostDoc = win_nwjs.window && win_nwjs.window.document;
		if(doc && doc !== hostDoc) { doc.addEventListener("keydown", makeOnKey(win_nwjs), true); }
	} catch(e) {}
	// Button: REPLACE the wiki's core tm-full-screen handler with our toggle. The embedded TiddlyWiki
	// keeps handlers in an array per type, so we replace rather than addEventListener (which would
	// append and leave the core's HTML5-fullscreen handler running alongside ours). The core registers
	// during boot, so re-apply for a few seconds to end up the last writer.
	if(typeof getRootWidget === "function") {
		var rerouteHandler = function() { toggle(win_nwjs); return false; };
		var applies = 0;
		(function applyReroute() {
			var rw = null;
			try { rw = getRootWidget(); } catch(e) {}
			var listeners = rw && rw.eventListeners;
			var existing = listeners && listeners["tm-full-screen"];
			if(existing !== undefined && existing !== null) {
				if(Array.isArray(existing)) { listeners["tm-full-screen"] = [rerouteHandler]; }
				else if(typeof existing === "function") { listeners["tm-full-screen"] = rerouteHandler; }
				if(++applies < 8) { setTimeout(applyReroute, 400); }
			} else {
				setTimeout(applyReroute, 150);  // rootWidget/handler not booted yet
			}
		})();
	}
};

function makeOnKey(win_nwjs) {
	return function(e) {
		if(e.key === "F11" || e.keyCode === 122) {
			e.preventDefault();
			e.stopPropagation();
			toggle(win_nwjs);
		}
	};
}
