/*
Class for wiki folder windows
*/

"use strict";

var windowBase = require("../js/window-base.js"),
	hash = require("../js/utils/hash.js"),
	fs = require("fs"),
	path = require("path");

// Path of the per-wiki "live title" file for a given wiki identifier. A folder wiki
// runs in its own process (new_instance), so the backstage can't observe its DOM the
// way it does a single-file wiki's iframe; instead the folder window writes its current
// title here and the backstage watches the file. Exported so window-list.js can clean
// the file up when a wiki is removed from the list.
function titleFileFor(identifier) {
	return path.resolve($tw.desktop.gui.App.dataPath,"FolderWikiTitles",hash.simpleHash(identifier));
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
	// Compute (and pre-create) the file used to mirror this wiki's live title across the
	// process boundary. We pass the exact path to the window so both sides agree even if
	// data-path resolution differs in the new instance, and pre-create it so fs.watch has
	// a stable inode to attach to before the folder window first writes.
	this.titleFile = titleFileFor(this.getIdentifier());
	try {
		fs.mkdirSync(path.dirname(this.titleFile),{recursive: true});
		if(!fs.existsSync(this.titleFile)) { fs.writeFileSync(this.titleFile,""); }
	} catch(e) {}
	// Get the host, port and credentials
	var host = $tw.wiki.getTiddlerText(this.getConfigTitle("host"),""),
		port = $tw.wiki.getTiddlerText(this.getConfigTitle("port"),""),
		credentials = $tw.wiki.getTiddlerText(this.getConfigTitle("credentials"),"users.csv"),
		readers = $tw.wiki.getTiddlerText(this.getConfigTitle("readers"),"(anon)"),
		writers = $tw.wiki.getTiddlerText(this.getConfigTitle("writers"),"(authenticated)");
	// Open the window
	$tw.desktop.gui.Window.open("html/wiki-folder-window.html?pathname=" + encodeURIComponent(this.pathname) + "&host=" + encodeURIComponent(host) + "&port=" + encodeURIComponent(port)
			+ "&credentials=" + encodeURIComponent(credentials) + "&readers=" + encodeURIComponent(readers) + "&writers=" + encodeURIComponent(writers) + "&titleFile=" + encodeURIComponent(this.titleFile),{
		id: hash.simpleHash(this.getIdentifier()),
		show: true,
		new_instance: true,
		icon: "images/app-icon256.png"
	},function(win) {
		self.window_nwjs = win;
		self.window_nwjs.once("loaded",self.onloaded.bind(self));
		self.window_nwjs.on("close",self.onclose.bind(self));		
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
	// Mirror the folder window's live title into the wiki-list title config. The folder
	// window writes its current title to this.titleFile whenever $:/SiteTitle /
	// $:/SiteSubtitle change; we watch that file and react the moment it does — no polling.
	this.readTitleFile();
	try {
		this.titleWatcher = fs.watch(this.titleFile,function() {
			// fs.watch can fire several events per write; coalesce with a short debounce.
			if(self.titleReadTimer) { clearTimeout(self.titleReadTimer); }
			self.titleReadTimer = setTimeout(function() { self.readTitleFile(); },50);
		});
		this.titleWatcher.on("error",function() {});
	} catch(e) {}
};

// Read the live-title file and, if it changed, push it to the wiki-list title config.
WikiFolderWindow.prototype.readTitleFile = function() {
	var title;
	try { title = fs.readFileSync(this.titleFile,"utf8"); } catch(e) { return; }
	if(title && title !== this.wikiTitle) {
		this.wikiTitle = title;
		this.onTitleChange();
	}
};

// Reopen this window
WikiFolderWindow.prototype.reopen = function() {
	$tw.desktop.windowList.openByUrl("backstage://Wiki Folder Warning");
};

// Mark window to be removed from list on close
WikiFolderWindow.prototype.removeFromWikiListOnClose = function() {
	this.mustRemoveFromWikiListOnClose = true;
	$tw.desktop.windowList.openByUrl("backstage://Wiki Folder Warning");
};

// Get the wiki title (kept in sync from the live-title file by readTitleFile)
WikiFolderWindow.prototype.getWikiTitle = function() {
	return this.wikiTitle || "";
};

// Extract the wiki favicon text
WikiFolderWindow.prototype.getWikiFavIconText = function() {
	return "";
};

// Extract the wiki favicon type
WikiFolderWindow.prototype.getWikiFavIconType = function() {
	return "";
};

// Close handler for window
WikiFolderWindow.prototype.onclose = function(event) {
	// Stop watching the live-title file
	if(this.titleReadTimer) { clearTimeout(this.titleReadTimer); this.titleReadTimer = null; }
	if(this.titleWatcher) {
		try { this.titleWatcher.close(); } catch(e) {}
		this.titleWatcher = null;
	}
	// Close the window, remove it from the window list
	this.windowList.handleClose(this);
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
exports.titleFileFor = titleFileFor;
