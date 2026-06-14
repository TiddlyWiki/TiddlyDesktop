/*
Base class methods for TiddlyDesktop window objects
*/

"use strict";

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

	// Merge any saved geometry into an nw.js Window.open options object.
	proto.applyGeometryToOpenOptions = function(options) {
		var g = this.loadGeometry();
		if(g) {
			if(isFinite(g.x)) { options.x = g.x; }
			if(isFinite(g.y)) { options.y = g.y; }
			if(isFinite(g.width)) { options.width = g.width; }
			if(isFinite(g.height)) { options.height = g.height; }
		}
		return options;
	};

	// Persist the window's current position and size. Skipped while fullscreen or
	// maximized, so the stored x/y/width/height stay the "normal" (restore) bounds —
	// the maximized state is recorded separately as a flag (see saveMaximizedFlag).
	proto.saveGeometry = function() {
		var win = this.window_nwjs;
		if(!win) { return; }
		try {
			if(win.isFullscreen) { return; }
			if(win.__tdMaximized) { return; }
			var prev = this.loadGeometry() || {};
			var g = {x: win.x, y: win.y, width: win.width, height: win.height, maximized: false};
			if(!isFinite(g.width) || !isFinite(g.height) || g.width < 1 || g.height < 1) { return; }
			// Preserve a maximized flag set by saveMaximizedFlag if the window is, right now,
			// genuinely maximized but __tdMaximized hasn't been observed yet (defensive).
			void prev;
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
		try { win.on("maximize",function() { win.__tdMaximized = true; self.saveMaximizedFlag(true); }); } catch(e) {}
		try { win.on("unmaximize",function() { win.__tdMaximized = false; self.saveMaximizedFlag(false); schedule(); }); } catch(e) {}
	};

}
