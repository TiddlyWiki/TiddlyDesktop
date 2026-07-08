/*
Base class methods for TiddlyDesktop window objects
*/

"use strict";

// ── screen awareness (multi-monitor) ───────────────────────────────────────────
// Saved geometry uses GLOBAL x/y, so it already encodes which monitor a window was on.
// But a monitor that's since been removed/rearranged would restore it off-screen
// (invisible), so we validate the saved position against the currently connected screens.
var _gui = null;
try { _gui = require("nw.gui"); } catch(e) {}
var _screenInited = false;
function _screens() {
	try {
		if(!_gui || !_gui.Screen) { return []; }
		if(!_screenInited) { try { _gui.Screen.Init(); } catch(e) {} _screenInited = true; }
		return _gui.Screen.screens || [];
	} catch(e) { return []; }
}
// True if the rect shows a meaningful chunk on some connected screen.
function _rectOnAScreen(x, y, w, h) {
	var screens = _screens();
	if(!screens.length) { return true; }   // can't enumerate → trust the saved coords
	for(var i = 0; i < screens.length; i++) {
		var b = screens[i].bounds || screens[i].work_area;
		if(!b) { continue; }
		var ox = Math.max(0, Math.min(x + w, b.x + b.width)  - Math.max(x, b.x));
		var oy = Math.max(0, Math.min(y + h, b.y + b.height) - Math.max(y, b.y));
		if(ox >= 80 && oy >= 40) { return true; }   // enough to grab the title bar
	}
	return false;
}

// The work area (screen minus taskbar/dock) of the screen the rect mostly sits on, or
// null if screens can't be enumerated. A maximized window matches its work area.
function _workAreaFor(x, y, w, h) {
	var screens = _screens(), best = null, bestOverlap = -1;
	for(var i = 0; i < screens.length; i++) {
		var wa = screens[i].work_area || screens[i].bounds;
		if(!wa) { continue; }
		var ox = Math.max(0, Math.min(x + w, wa.x + wa.width)  - Math.max(x, wa.x));
		var oy = Math.max(0, Math.min(y + h, wa.y + wa.height) - Math.max(y, wa.y));
		var ov = ox * oy;
		if(ov > bestOverlap) { bestOverlap = ov; best = wa; }
	}
	return best;
}

exports.addBaseMethods = function(proto) {

	proto.getConfigTitle = function(type,identifier) {
		identifier = identifier || this.getIdentifier();
		return "$:/TiddlyDesktop/Config/" + type + "/" + identifier;
	}

	proto.removeFromWikiListOnClose = function() {
		this.mustRemoveFromWikiListOnClose = true;
	};

	proto.onTitleChange = function() {
		var fields = {
			title: this.getConfigTitle("title"),
			text: this.getWikiTitle()
		}
		$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),fields,$tw.wiki.getModificationFields))
	};

	proto.onFavIconChange = function() {
		var fields = {
			title: this.getConfigTitle("favicon"),
			text: this.getWikiFavIconText(),
			type: this.getWikiFavIconType(),
		}
		$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),fields,$tw.wiki.getModificationFields))
	};

	// Remove the favicon config so the wiki list falls back to its missing-favicon
	// placeholder. Used when a wiki has no real favicon — writing an empty/garbage config
	// instead leaves a broken thumbnail (the tiddler exists, so it isn't "missing").
	proto.clearFavIcon = function() {
		this.wikiFavIconText = "";
		this.wikiFavIconType = "";
		$tw.wiki.deleteTiddler(this.getConfigTitle("favicon"));
	};

	// ── window position / size persistence ─────────────────────────────────────
	// Saved per wiki in the backstage wiki (so it survives restarts) and applied when
	// the window is (re)opened. Works for both window types: x/y/width/height and the
	// move/resize events are frame-level, so they're available even for folder windows
	// (which run in a separate process).

	// Read the saved geometry for this wiki, or null if none / invalid.
	proto.loadGeometry = function() {
		try {
			var text = $tw.wiki.getTiddlerText(this.getConfigTitle("geometry"),"");
			if(!text) { return null; }
			var g = JSON.parse(text);
			if(g && isFinite(g.width) && isFinite(g.height) && g.width > 0 && g.height > 0) { return g; }
		} catch(e) {}
		return null;
	};

	// Merge any saved geometry into an nw.js Window.open options object. The window's
	// position is restored only if it still lands on a connected screen — the global x/y
	// place it back on the same monitor, and an unplugged monitor falls back to the OS
	// default (NW.js centres it) instead of opening off-screen.
	proto.applyGeometryToOpenOptions = function(options) {
		var g = this.loadGeometry();
		if(g) {
			if(isFinite(g.width)) { options.width = g.width; }
			if(isFinite(g.height)) { options.height = g.height; }
			var w = isFinite(g.width) ? g.width : 800, h = isFinite(g.height) ? g.height : 600;
			if(isFinite(g.x) && isFinite(g.y) && _rectOnAScreen(g.x, g.y, w, h)) {
				options.x = g.x;
				options.y = g.y;
			}
		}
		return options;
	};

	// Is the window maximized right now? Judged from its bounds vs the screen work area,
	// NOT from NW.js maximize/unmaximize events — those are never emitted on Linux, so an
	// event-driven flag gets stuck "maximized" once set and the window can never be
	// remembered as restored again. A maximized window fills the work area and sits at its
	// origin; tolerance covers WM frames / invisible resize borders.
	// Returns true (maximized), false (not), or null (can't tell). Judged by SIZE only — a
	// maximized window fills the work area. We deliberately do NOT compare x/y: global window
	// coordinates are unreliable on some window managers (and not exposed at all on Wayland),
	// so a position check would read a genuinely-maximized window as "restored" and lose the
	// state. Prefer the window's own screen metrics (reliable in-process and on Wayland), then
	// fall back to the nw.gui Screen work area.
	proto._maximizedState = function() {
		var win = this.window_nwjs;
		if(!win) { return null; }
		try {
			var w = win.width, h = win.height;
			if(!isFinite(w) || !isFinite(h) || w < 1 || h < 1) { return null; }
			var availW = null, availH = null;
			try {
				var scr = win.window && win.window.screen;
				if(scr && scr.availWidth) { availW = scr.availWidth; availH = scr.availHeight; }
			} catch(e) {}
			if(availW === null) {
				var wa = _workAreaFor(win.x, win.y, w, h);
				if(wa) { availW = wa.width; availH = wa.height; }
			}
			if(availW === null) { return null; }   // can't measure → unknown
			var tol = 40;
			return (Math.abs(w - availW) <= tol && Math.abs(h - availH) <= tol);
		} catch(e) {}
		return null;
	};

	// Persist the window's current position and size. While the window is maximized we keep
	// the previously-stored normal (restore) bounds untouched and only flag maximized=true;
	// when it isn't, we store the live bounds with maximized=false. The maximized state is
	// recomputed from the bounds on every save (see _maximizedState) so it stays correct on
	// platforms that emit no maximize/unmaximize events. Skipped while fullscreen.
	proto.saveGeometry = function() {
		var win = this.window_nwjs;
		if(!win) { return; }
		try {
			if(win.isFullscreen) { return; }
			// Don't persist transitional bounds while a programmatic maximize is still settling
			// (see restoreMaximizedState) — otherwise the restore bounds would be captured as
			// "not maximized" and clobber the flag we just restored.
			if(win.__tdGeomSettleUntil && Date.now() < win.__tdGeomSettleUntil) { return; }
			var maximized = this._maximizedState();
			// When the screen can't be measured, trust the event-driven flag rather than guess —
			// never downgrade a known-maximized window to "restored" on an unreadable sample.
			if(maximized === null) { maximized = !!win.__tdMaximized; }
			win.__tdMaximized = maximized;
			if(maximized) {
				// Don't overwrite the normal bounds with the maximized ones — just flag it, so
				// restore-on-reopen has real bounds to fall back to after un-maximizing. If no
				// normal bounds were ever saved (window was maximized from first launch), seed
				// them with the current bounds so loadGeometry stays valid and restore works.
				var prev = this.loadGeometry() || {};
				if(!isFinite(prev.width) || !isFinite(prev.height) || prev.width < 1 || prev.height < 1) {
					prev.x = win.x; prev.y = win.y; prev.width = win.width; prev.height = win.height;
				}
				prev.maximized = true;
				$tw.wiki.addTiddler(new $tw.Tiddler({title: this.getConfigTitle("geometry"),text: JSON.stringify(prev)}));
				return;
			}
			var g = {x: win.x, y: win.y, width: win.width, height: win.height, maximized: false};
			if(!isFinite(g.width) || !isFinite(g.height) || g.width < 1 || g.height < 1) { return; }
			$tw.wiki.addTiddler(new $tw.Tiddler({title: this.getConfigTitle("geometry"),text: JSON.stringify(g)}));
		} catch(e) {}
	};

	// Persist ONLY the maximized flag, keeping the saved normal bounds untouched.
	proto.saveMaximizedFlag = function(flag) {
		try {
			var g = this.loadGeometry() || {};
			g.maximized = !!flag;
			$tw.wiki.addTiddler(new $tw.Tiddler({title: this.getConfigTitle("geometry"),text: JSON.stringify(g)}));
		} catch(e) {}
	};

	// After the window has opened, re-maximize it if it was maximized last time.
	proto.restoreMaximizedState = function() {
		var win = this.window_nwjs;
		if(!win) { return; }
		var g = this.loadGeometry();
		if(g && g.maximized) {
			win.__tdMaximized = true;
			// Suppress geometry saves briefly: a resize/move fired during the maximize
			// transition (while the window is still at its restore bounds) must not overwrite
			// the maximized flag with a "restored" sample before the WM finishes maximizing.
			win.__tdGeomSettleUntil = Date.now() + 1500;
			try { win.maximize(); } catch(e) {}
		}
	};

	// Track move/resize/maximize (debounced for move/resize) and persist. Call once
	// after the window has opened. NW.js exposes maximize/unmaximize as frame-level
	// events, so this works for folder windows (separate process) too.
	proto.trackGeometry = function() {
		var self = this, win = this.window_nwjs, timer = null;
		if(!win || !win.on) { return; }
		function schedule() {
			if(timer) { clearTimeout(timer); }
			timer = setTimeout(function() { timer = null; self.saveGeometry(); },400);
		}
		try { win.on("move",schedule); } catch(e) {}
		try { win.on("resize",schedule); } catch(e) {}
		// Remember the window the user is in, so a tiddlydesktop:// deep link (OAuth return)
		// re-focuses it. The focus event is frame-level, so this works for folder windows
		// (separate process) too.
		try { win.on("focus",function() { try { $tw.desktop.lastFocusedWindow = self; } catch(e) {} }); } catch(e) {}
		try { win.on("maximize",function() { win.__tdMaximized = true; self.saveMaximizedFlag(true); }); } catch(e) {}
		try { win.on("unmaximize",function() { win.__tdMaximized = false; self.saveMaximizedFlag(false); schedule(); }); } catch(e) {}
		// Track minimized state so a deep-link return can un-minimise WITHOUT un-maximising
		// (restore() does both, so it must only be used on a genuinely minimised window).
		try { win.on("minimize",function() { win.__tdMinimized = true; }); } catch(e) {}
		try { win.on("restore",function() { win.__tdMinimized = false; }); } catch(e) {}
	};

}
