/*
Class for wiki folder windows
*/

(function(){

/*jslint browser: true */
"use strict";

var windowBase = require("../js/window-base.js");

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
	// Get the host, port and credentials
	var host = $tw.wiki.getTiddlerText(this.getConfigTitle("host"),""),
		port = $tw.wiki.getTiddlerText(this.getConfigTitle("port"),""),
		credentials = $tw.wiki.getTiddlerText(this.getConfigTitle("credentials"),"users.csv"),
		readers = $tw.wiki.getTiddlerText(this.getConfigTitle("readers"),"(anon)"),
		writers = $tw.wiki.getTiddlerText(this.getConfigTitle("writers"),"(authenticated)");
	// Open the window
	$tw.desktop.gui.Window.open("html/wiki-folder-window.html?pathname=" + encodeURIComponent(this.pathname) + "&host=" + encodeURIComponent(host) + "&port=" + encodeURIComponent(port)
			+ "&credentials=" + encodeURIComponent(credentials) + "&readers=" + encodeURIComponent(readers) + "&writers=" + encodeURIComponent(writers),{
		id: this.getIdentifier(),
		show: true,
		new_instance: true,
		icon: "images/app_icon.png"
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

// Get the wiki title
WikiFolderWindow.prototype.getWikiTitle = function() {
	return "";
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

})();
