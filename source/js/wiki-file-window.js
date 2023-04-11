/*
Class for wiki file windows
*/

(function(){

/*jslint browser: true */
"use strict";

var windowBase = require("../js/window-base.js"),
	hash = require("../js/utils/hash.js"),
	fs = require("fs");

// Constructor
function WikiFileWindow(options) {
	var self = this;
	options = options || {};
	// Save the options
	this.windowList = options.windowList;
	this.info = options.info || {};
	this.pathname = options.info.pathname;
	this.mustQuitOnClose = options.mustQuitOnClose;
	// Open the window
console.log("Opening window with id",this.getIdentifier());
	$tw.desktop.gui.Window.open("html/wiki-file-window.html",{
		id: hash.simpleHash(this.getIdentifier()),
		show: true,
		icon: "images/app_icon.png"
	},function(win) {
		self.window_nwjs = win;
		self.window_nwjs.once("loaded",self.onloaded.bind(self));
		self.window_nwjs.on("close",self.onclose.bind(self));
	});
}

// Static method for getting the identifier for the specified info
WikiFileWindow.getIdentifierFromInfo = function(info) {
	return "wikifile://" + info.pathname;
};

// Static method for getting the path for the specified info
WikiFileWindow.getPathnameFromInfo = function(info) {
	return info.pathname;
};

// Static method to indicate that this window generates backups
WikiFileWindow.hasBackups = function() {
	return true;
};

windowBase.addBaseMethods(WikiFileWindow.prototype);

// Returns true if the provided parameters are the same as the ones used to create this window
WikiFileWindow.prototype.matchInfo = function(info) {
	return info.pathname === this.pathname;
};

// The identifier for wiki file windows is the prefix `wikifile://` plus the pathname of the file
WikiFileWindow.prototype.getIdentifier = function() {
	return WikiFileWindow.getIdentifierFromInfo({pathname: this.pathname});
};

// Load handler for window
WikiFileWindow.prototype.onloaded = function(event) {
	this.window_nwjs.window.$tw = $tw;
	// Show dev tools on F12
	$tw.desktop.utils.devtools.trapDevTools(this.window_nwjs,this.window_nwjs.window.document);
	// Add menu
	$tw.desktop.utils.menu.createMenuBar(this.window_nwjs);
	// Load the iframe, escaping specific characters that are troublesome in URLs
	this.iframe = this.window_nwjs.window.document.getElementById("tid-main-wiki-file-viewer");
	this.iframe.src = "file://" + this.pathname.replace(/[#]/g,function(s) {return encodeURIComponent(s);});
	this.iframe.onload = this.onloadiframe.bind(this);
	// Show dev tools
	// this.window_nwjs.showDevTools(this.iframe);
	// Save the wiki list tiddler
	this.saveWikiListTiddler();
	// Show the window
	this.window_nwjs.show();
	this.window_nwjs.focus();
};

// Load handler for iframe
WikiFileWindow.prototype.onloadiframe = function() {
	var self = this;
	// Get the mutation observer prototype for the window
	var MutationObserver = this.window_nwjs.window.MutationObserver;
	// Enable saving
	var areBackupsEnabledFn = function() {
			return $tw.wiki.getTiddlerText(self.getConfigTitle("disable-backups"),"no") !== "yes";
		},
		loadFileTextFn = function() {
			return 	fs.readFileSync(self.pathname,"utf8");
		};
	$tw.desktop.utils.saving.enableSaving(this.iframe.contentDocument,areBackupsEnabledFn,loadFileTextFn);
	// Trap links
	$tw.desktop.utils.links.trapLinks(this.iframe.contentDocument);
	// Observe mutations of the title element of the iframe
	this.titleObserver = new MutationObserver(this.extractIframeTitle.bind(this));
	var iframeTitleNode = this.iframe.contentDocument.getElementsByTagName("title")[0];
	this.extractIframeTitle();
	this.titleObserver.observe(iframeTitleNode,{attributes: true, childList: true, characterData: true});
	// Observe mutations of the favicon element of the iframe
	var faviconLink = this.iframe.contentDocument.getElementById("faviconLink");
	this.favIconObserver = new MutationObserver(this.extractIframeFavicon.bind(this));
	this.extractIframeFavicon();
	if(faviconLink) {
		this.favIconObserver.observe(faviconLink,{attributes: true, childList: true, characterData: true});		
	}
};

// Reopen this window
WikiFileWindow.prototype.reopen = function() {
	this.window_nwjs.focus();
};

// Extract the iframe title
WikiFileWindow.prototype.extractIframeTitle = function() {
	this.wikiTitle = this.iframe.contentDocument.title;
	this.window_nwjs.window.document.title = this.wikiTitle;
	this.onTitleChange();
};

// Get the wiki title
WikiFileWindow.prototype.getWikiTitle = function() {
	return this.wikiTitle;
};

// Extract the iframe favicon
WikiFileWindow.prototype.extractIframeFavicon = function() {
	var faviconLink = this.iframe.contentDocument.getElementById("faviconLink");
	if(faviconLink) {
		// data URIs look like "data:<type>;base64,<text>"
		var faviconDataUri = faviconLink.getAttribute("href"),
			posColon = faviconDataUri.indexOf(":"),
			posSemiColon = faviconDataUri.indexOf(";"),
			posComma = faviconDataUri.indexOf(",");
		this.wikiFavIconType = faviconDataUri.substring(posColon+1,posSemiColon),
		this.wikiFavIconText = faviconDataUri.substring(posComma+1);
		this.onFavIconChange();	
	} else {
		this.wikiFavIconText = "";
		this.wikiFavIconType = "";
	}
};

// Extract the wiki favicon text
WikiFileWindow.prototype.getWikiFavIconText = function() {
	return this.wikiFavIconText;
};

// Extract the wiki favicon type
WikiFileWindow.prototype.getWikiFavIconType = function() {
	return this.wikiFavIconType;
};

// Close handler for window
WikiFileWindow.prototype.onclose = function(event) {
	// Check the hosted wiki is happy to close
	var onbeforeunload = this.iframe.contentWindow.onbeforeunload;
	if(onbeforeunload) {
		var msg = onbeforeunload({});
		if(msg && !this.window_nwjs.window.confirm(msg + "\n\nAre you sure you wish to close this wiki?")) {
			return false;
		}				
	}
	// Delete the mutation observers for the title and the favicon
	this.titleObserver.disconnect();
	this.favIconObserver.disconnect();
	// Close the window, remove it from the window list
	this.windowList.handleClose(this,this.mustRemoveFromWikiListOnClose);
};

// Save a tiddler to the backstage wiki describing this wiki file
WikiFileWindow.prototype.saveWikiListTiddler = function() {
	var fields = {
		title: this.getIdentifier(),
		tags: ["wikilist","wikifile"],
		text: ""
	}
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),fields,$tw.wiki.getModificationFields()))
};

exports.WikiFileWindow = WikiFileWindow;

})();
