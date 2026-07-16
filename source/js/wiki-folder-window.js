/*
Class for wiki folder windows
*/

"use strict";

var windowBase = require("../js/window-base.js"),
	hash = require("../js/utils/hash.js"),
	spellcheck = require("../js/utils/spellcheck.js"),
	fs = require("fs"),
	path = require("path");

// Path of the per-wiki "live state" file for a given wiki identifier. A folder wiki runs
// in its own process (new_instance), so the backstage can't observe its DOM the way it
// does a single-file wiki's iframe; instead the folder window writes its current title
// and favicon here (as a small JSON payload) and the backstage watches the file. Exported
// so window-list.js can clean the file up when a wiki is removed from the list.
function liveStateFileFor(identifier) {
	return path.resolve($tw.desktop.gui.App.dataPath,"FolderWikiState",hash.simpleHash(identifier));
}

// Constructor
function WikiFolderWindow(options) {
	var self = this;
	options = options || {};
	// Save the options
	this.windowList = options.windowList;
	this.info = options.info || {};
	this.pathname = options.info.pathname;
	this.mustQuitOnClose = options.mustQuitOnClose;
	// Save the wiki list tiddler
	this.saveWikiListTiddler();
	// Compute (and pre-create) the file used to mirror this wiki's live title and favicon
	// across the process boundary. We pass the exact path to the window so both sides agree
	// even if data-path resolution differs in the new instance, and pre-create it so
	// fs.watch has a stable inode to attach to before the folder window first writes.
	this.stateFile = liveStateFileFor(this.getIdentifier());
	try {
		fs.mkdirSync(path.dirname(this.stateFile),{recursive: true});
		if(!fs.existsSync(this.stateFile)) { fs.writeFileSync(this.stateFile,""); }
	} catch(e) {}
	// Get the host, port, credentials and other --listen server options
	var host = $tw.wiki.getTiddlerText(this.getConfigTitle("host"),""),
		port = $tw.wiki.getTiddlerText(this.getConfigTitle("port"),""),
		credentials = $tw.wiki.getTiddlerText(this.getConfigTitle("credentials"),"users.csv"),
		readers = $tw.wiki.getTiddlerText(this.getConfigTitle("readers"),"(anon)"),
		writers = $tw.wiki.getTiddlerText(this.getConfigTitle("writers"),"(authenticated)"),
		pathPrefix = $tw.wiki.getTiddlerText(this.getConfigTitle("path-prefix"),""),
		rootTiddler = $tw.wiki.getTiddlerText(this.getConfigTitle("root-tiddler"),""),
		anonUsername = $tw.wiki.getTiddlerText(this.getConfigTitle("anon-username"),""),
		gzip = $tw.wiki.getTiddlerText(this.getConfigTitle("gzip"),"no");
	// Open the window
	$tw.desktop.gui.Window.open("html/wiki-folder-window.html?pathname=" + encodeURIComponent(this.pathname) + "&host=" + encodeURIComponent(host) + "&port=" + encodeURIComponent(port)
			+ "&credentials=" + encodeURIComponent(credentials) + "&readers=" + encodeURIComponent(readers) + "&writers=" + encodeURIComponent(writers)
			+ "&pathprefix=" + encodeURIComponent(pathPrefix) + "&roottiddler=" + encodeURIComponent(rootTiddler) + "&anonusername=" + encodeURIComponent(anonUsername) + "&gzip=" + encodeURIComponent(gzip)
			+ "&spellcheck=" + encodeURIComponent(spellcheck.isEnabled($tw) ? "yes" : "no")
			+ "&spellcheck-lang=" + encodeURIComponent(spellcheck.getLanguage($tw))
			+ "&stateFile=" + encodeURIComponent(this.stateFile),this.applyGeometryToOpenOptions({
		id: hash.simpleHash(this.getIdentifier()),
		show: true,
		new_instance: true,
		icon: "images/app-icon256.png"
	}),function(win) {
		self.window_nwjs = win;
		self.window_nwjs.once("loaded",self.onloaded.bind(self));
		self.window_nwjs.on("close",self.onclose.bind(self));
		self.trackGeometry();
		self.restoreMaximizedState();
	});
}

// Static method for getting the identifier for the specified info
WikiFolderWindow.getIdentifierFromInfo = function(info) {
	return "wikifolder://" + info.pathname;
};

// Static method for getting the path for the specified info
WikiFolderWindow.getPathnameFromInfo = function(info) {
	return info.pathname;
};

windowBase.addBaseMethods(WikiFolderWindow.prototype);

// Returns true if the provided parameters are the same as the ones used to create this window
WikiFolderWindow.prototype.matchInfo = function(info) {
	return info.pathname === this.pathname;
};

// The identifier for wiki file windows is the prefix `wikifolder://` plus the pathname of the file
WikiFolderWindow.prototype.getIdentifier = function() {
	return "wikifolder://" + this.pathname;
};

// Load handler for window
WikiFolderWindow.prototype.onloaded = function(event) {
	var self = this;
	// Mirror the folder window's live title and favicon into the wiki-list config. The
	// folder window writes them to this.stateFile whenever they change ($:/SiteTitle /
	// $:/SiteSubtitle / $:/favicon.ico); we watch that file and react immediately — no polling.
	this.readStateFile();
	try {
		this.stateWatcher = fs.watch(this.stateFile,function() {
			// fs.watch can fire several events per write; coalesce with a short debounce.
			if(self.stateReadTimer) { clearTimeout(self.stateReadTimer); }
			self.stateReadTimer = setTimeout(function() { self.readStateFile(); },50);
		});
		this.stateWatcher.on("error",function() {});
	} catch(e) {}
};

// Read the live-state file and push any changed title/favicon to the wiki-list config.
WikiFolderWindow.prototype.readStateFile = function() {
	var raw, state;
	try { raw = fs.readFileSync(this.stateFile,"utf8"); } catch(e) { return; }
	if(!raw) { return; }
	try { state = JSON.parse(raw); } catch(e) { return; }
	if(state.title && state.title !== this.wikiTitle) {
		this.wikiTitle = state.title;
		this.onTitleChange();
	}
	// Favicon is a {type, text} pair; only update when either side actually changes. With
	// no favicon, clear the config so the wiki list shows the missing-favicon placeholder
	// rather than a stale/broken thumbnail.
	var favText = state.faviconText || "",
		favType = state.faviconType || "";
	if(favText) {
		if(favText !== this.wikiFavIconText || favType !== this.wikiFavIconType) {
			this.wikiFavIconText = favText;
			this.wikiFavIconType = favType;
			this.onFavIconChange();
		}
	} else {
		this.clearFavIcon();
	}
};

// Reopen this window — just focus it, like single-file wikis (a closed folder wiki is
// re-opened by window-list.open() constructing a fresh window, so this only runs for an
// already-open one).
WikiFolderWindow.prototype.reopen = function() {
	try { this.window_nwjs.focus(); } catch(e) {}
};

// removeFromWikiListOnClose() is inherited from window-base (just sets the flag); the
// close handler below honours it, so removing a folder wiki works like a single-file one.

// Get the wiki title (kept in sync from the live-state file by readStateFile)
WikiFolderWindow.prototype.getWikiTitle = function() {
	return this.wikiTitle || "";
};

// Get the wiki favicon text (kept in sync from the live-state file by readStateFile)
WikiFolderWindow.prototype.getWikiFavIconText = function() {
	return this.wikiFavIconText || "";
};

// Get the wiki favicon type (kept in sync from the live-state file by readStateFile)
WikiFolderWindow.prototype.getWikiFavIconType = function() {
	return this.wikiFavIconType || "";
};

// Close handler for window
WikiFolderWindow.prototype.onclose = function(event) {
	// Stop watching the live-state file
	if(this.stateReadTimer) { clearTimeout(this.stateReadTimer); this.stateReadTimer = null; }
	if(this.stateWatcher) {
		try { this.stateWatcher.close(); } catch(e) {}
		this.stateWatcher = null;
	}
	// Close the window, removing it from the wiki list if it was marked for removal
	// (same as single-file wikis).
	this.windowList.handleClose(this,this.mustRemoveFromWikiListOnClose);
};

// Save a tiddler to the backstage wiki describing this wiki file
WikiFolderWindow.prototype.saveWikiListTiddler = function() {
	var fields = {
		title: this.getIdentifier(),
		tags: ["wikilist","wikifolder"],
		text: ""
	}
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),fields,$tw.wiki.getModificationFields()))
};

exports.WikiFolderWindow = WikiFolderWindow;
exports.liveStateFileFor = liveStateFileFor;
