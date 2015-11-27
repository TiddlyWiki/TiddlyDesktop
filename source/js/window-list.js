/*
Manage the list of windows
*/

(function(){

/*jslint browser: true */
"use strict";

var WikiFileWindow = require("./wiki-file-window.js").WikiFileWindow,
	WikiFolderWindow = require("./wiki-folder-window.js").WikiFolderWindow,
	BackstageWindow = require("./backstage-window.js").BackstageWindow;

function WindowList(options) {
	options = options || {};
	this.backstageWindow_nwjs = options.backstageWindow_nwjs;
	this.windows = [];
}

WindowList.prototype.decodeUrl = function(url) {
	// Decode the URL to figure out the constructor and parameters
	var result = {
			WindowConstructor: null,
			info: {}
		};
	if(url.indexOf("file://") === 0) {
		if(url.charAt(7) === "/" && process.platform.substr(0,3) === "win") {
			result.info.pathname = url.substr(8);
		} else {
			result.info.pathname = url.substr(7);
		}
		if($tw.utils.isDirectory(result.info.pathname)) {
			result.WindowConstructor = WikiFolderWindow;
		} else {
			result.WindowConstructor = WikiFileWindow;
		}
	} else if(url.indexOf("wikifile://") === 0) {
		result.WindowConstructor = WikiFileWindow;
		result.info.pathname = url.substr(11);
	} else if(url.indexOf("wikifolder://") === 0) {
		result.WindowConstructor = WikiFolderWindow;
		result.info.pathname = url.substr(13);
	} else if(url.indexOf("backstage://") === 0) {
		result.WindowConstructor = BackstageWindow;
		result.info.tiddler = url.substr(12);
	}
	return result;
};

WindowList.prototype.openByUrl = function(url) {
	var decodedUrl = this.decodeUrl(url);
	this.open(decodedUrl.WindowConstructor,decodedUrl.info);
};

WindowList.prototype.openByPathname = function(pathname) {
	var WindowConstructor,
		info = {
			pathname: pathname
		};
	if($tw.utils.isDirectory(pathname)) {
		WindowConstructor = WikiFolderWindow;
	} else {
		WindowConstructor = WikiFileWindow;
	}
	this.open(WindowConstructor,info);
};

WindowList.prototype.open = function(WindowConstructor,info) {
	// Check if the window is already open
	var w = this.find(WindowConstructor,info);
	if(w) {
		// If so, just focus it
		try {
			w.window_nwjs.focus();
		} catch(e) {
			console.log("WARNING: Focusing wiki window failed");
		}
	} else {
		// Construct the window and save it
		w = new WindowConstructor({
			windowList: this,
			info: info
		});
		this.windows.push(w);		
	}
};

WindowList.prototype.find = function(WindowConstructor,info) {
	// Check if the window is already open
	var w;
	this.windows.forEach(function(win) {
		if((win instanceof WindowConstructor) && win.matchInfo(info)) {
			w = win;
		}
	});
	return w;
};

WindowList.prototype.removeByUrl = function(url) {
	// Find the window corresponding to this url
	var decodedUrl = this.decodeUrl(url),
		w = this.find(decodedUrl.WindowConstructor,decodedUrl.info);
	if(w) {
		// Close the window and remove it from the list
		w.removeFromWikiListOnClose();
		w.window_nwjs.close();
	} else {
		this.removeByInfo(decodedUrl.WindowConstructor,decodedUrl.info);
	}
};

WindowList.prototype.removeByInfo = function(WindowConstructor,info) {
	var wikiListTiddlerTitle = WindowConstructor.getIdentifierFromInfo(info);
	$tw.wiki.deleteTiddler(wikiListTiddlerTitle);
};

WindowList.prototype.handleClose = function(w,removeFromWikiListOnClose) {
	// Save the position/layout of the window
	w.saveWindowConfigData("layout",w.getWindowLayout());
	// Remove from the wiki list if required
	if(removeFromWikiListOnClose) {
		var wikiListTiddlerTitle = w.getIdentifier();
		$tw.wiki.deleteTiddler(wikiListTiddlerTitle);
	}
	// Close the window
	w.window_nwjs.close(true);
	// Remove the window from the list
	for(var t=this.windows.length-1; t>=0; t--) {
		if(this.windows[t] === w) {
			this.windows.splice(t,1);
		}
	}
	// Quit if there are no windows left
	if(this.windows.length === 0) {
		$tw.desktop.gui.App.quit();
	}
};

WindowList.prototype.revealByUrl = function(url) {
	var decodedUrl = this.decodeUrl(url),
		getPathnameFromInfo = decodedUrl.WindowConstructor.getPathnameFromInfo;
	if(getPathnameFromInfo) {
		$tw.desktop.gui.Shell.showItemInFolder(getPathnameFromInfo(decodedUrl.info));
	}
};

exports.WindowList = WindowList;

})();
