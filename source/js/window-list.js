/*
Manage the list of windows
*/

(function(){

/*jslint browser: true */
"use strict";

var fs = require("fs"),
	path = require("path"),
	http = require("http"),
	https = require("https");

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
			info: {},
			type: null
		};
	if(url.indexOf("file://") === 0) {
		if(url.charAt(7) === "/" && process.platform.substr(0,3) === "win") {
			result.info.pathname = url.substr(8);
		} else {
			result.info.pathname = url.substr(7);
		}
		if($tw.utils.isDirectory(result.info.pathname)) {
			result.WindowConstructor = WikiFolderWindow;
			result.type = "folder";
		} else {
			result.WindowConstructor = WikiFileWindow;
			result.type = "file";
		}
	} else if(url.indexOf("wikifile://") === 0) {
		result.WindowConstructor = WikiFileWindow;
		result.info.pathname = url.substr(11);
		result.type = "file";
	} else if(url.indexOf("wikifolder://") === 0) {
		result.WindowConstructor = WikiFolderWindow;
		result.info.pathname = url.substr(13);
		result.type = "folder";
	} else if(url.indexOf("backstage://") === 0) {
		result.WindowConstructor = BackstageWindow;
		result.info.tiddler = url.substr(12);
		result.type = "backstage";
	} else if(url.indexOf("http://") === 0) {
		result.info.url = url;
		result.type = "http";
	} else if(url.indexOf("https://") === 0) {
		result.info.url = url;
		result.type = "https";
	}
	return result;
};

WindowList.prototype.openByUrl = function(url,options) {
	options = options || {};
	var decodedUrl = this.decodeUrl(url);
	this.open(decodedUrl.WindowConstructor,decodedUrl.info,options);
};

WindowList.prototype.openByPathname = function(pathname,options) {
	options = options || {};
	var WindowConstructor,
		info = {
			pathname: pathname
		};
	if($tw.utils.isDirectory(pathname)) {
		WindowConstructor = WikiFolderWindow;
	} else {
		WindowConstructor = WikiFileWindow;
	}
	this.open(WindowConstructor,info,options);
};

WindowList.prototype.open = function(WindowConstructor,info,options) {
	options = options || {};
	// Check if the window is already open
	var w = this.find(WindowConstructor,info);
	if(w) {
		// If so, just focus it
		w.reopen(options);
	} else {
		// Construct the window and save it
		w = new WindowConstructor({
			windowList: this,
			info: info,
			mustQuitOnClose: options.mustQuitOnClose
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
	// Remove from the wiki list if required
	if(removeFromWikiListOnClose) {
		var wikiListTiddlerTitle = w.getIdentifier();
		$tw.wiki.deleteTiddler(wikiListTiddlerTitle);
	}
	// Remove the window from the list
	for(var t=this.windows.length-1; t>=0; t--) {
		if(this.windows[t] === w) {
			this.windows.splice(t,1);
		}
	}
	// Close the window
	w.window_nwjs.close(true);
	// Close the backstage window if there are no windows left
	if(this.windows.length === 0) {
		this.backstageWindow_nwjs.close(true);
	}
};

WindowList.prototype.revealByUrl = function(url) {
	var decodedUrl = this.decodeUrl(url),
		getPathnameFromInfo = decodedUrl.WindowConstructor.getPathnameFromInfo;
	if(getPathnameFromInfo) {
		$tw.desktop.gui.Shell.showItemInFolder(getPathnameFromInfo(decodedUrl.info));
	}
};

WindowList.prototype.revealBackupsByUrl = function(url) {
	var decodedUrl = this.decodeUrl(url),
		hasBackups = decodedUrl.WindowConstructor.hasBackups,
		getPathnameFromInfo = decodedUrl.WindowConstructor.getPathnameFromInfo;
	if(hasBackups && hasBackups() && getPathnameFromInfo) {
		var pathname = $tw.desktop.utils.saving.backupPathByPath(getPathnameFromInfo(decodedUrl.info));
		if(!fs.existsSync(pathname)) {
			$tw.utils.createDirectory(pathname);
		}
		$tw.desktop.gui.Shell.openItem(pathname);
	}
};

/*
Clone an existing wiki file or folder
source: URL of source (wikifolder://,wikifile://,http(s)://)
dest: path of destination file or folder
*/
WindowList.prototype.cloneToPath = function(source,dest) {
	var decodedSource = this.decodeUrl(source);
	if(decodedSource.type === "folder") {
		this.cloneFolderToPath(decodedSource.info.pathname,dest);
	} else if(decodedSource.type === "file") {
		this.cloneFileToPath(decodedSource.info.pathname,dest);
	} else if(decodedSource.type === "http" || decodedSource.type === "https") {
		this.cloneWebToPath(decodedSource.info.url,dest);
	} else {
		console.log("Cannot clone",source,dest);
	}
};

/*
Clone an existing wiki folder
source: path to wiki folder
dest: path of destination folder
*/
WindowList.prototype.cloneFolderToPath = function(source,dest) {
	$tw.utils.copyDirectory(source,dest);
	$tw.desktop.windowList.openByUrl("wikifolder://" + dest);
};


/*
Clone an existing wiki file
source: path to wiki file
dest: path of destination file
*/
WindowList.prototype.cloneFileToPath = function(source,dest) {
	fs.writeFileSync(dest,fs.readFileSync(source,"utf8"),"utf8");
	$tw.desktop.windowList.openByUrl("wikifile://" + dest);
};


/*
Clone a wiki file from the web
source: URL of wiki file
dest: path of destination file
*/
WindowList.prototype.cloneWebToPath = function(source,dest) {
	var protocol = source.substr(0,5) === "https" ? https : http,
		file = fs.createWriteStream(dest);
	protocol.get(source,function(response) {
		var stream = response.pipe(file);
		stream.on("finish",function() {
			$tw.desktop.windowList.openByUrl("wikifile://" + dest);
		});
		stream.on("error",function(err) {
			$tw.desktop.utils.alert("Error: " + err);
		});
	});
};

exports.WindowList = WindowList;

})();
