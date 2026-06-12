/*
Manage the list of windows
*/

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
			$tw.desktop.utils.wiki.alert("Error: " + err);
		});
	});
};

/*
Create a new empty TiddlyWiki server folder at the given path
*/
WindowList.prototype.createWikiFolderAtPath = function(dest) {
	if(fs.existsSync(dest)) {
		console.error("[TiddlyDesktop] Cannot create wiki folder, path already exists:",dest);
		return;
	}
	fs.mkdirSync(dest);
	fs.writeFileSync(
		path.join(dest,"tiddlywiki.info"),
		JSON.stringify({
			"description": "New TiddlyWiki",
			"plugins": ["tiddlywiki/filesystem","tiddlywiki/server"],
			"themes": ["tiddlywiki/vanilla","tiddlywiki/snowwhite"]
		},null,4),
		"utf8"
	);
	fs.mkdirSync(path.join(dest,"tiddlers"));
	$tw.desktop.windowList.openByUrl("wikifolder://" + dest);
};

/*
Convert a wiki between single-file and folder formats.
sourceUrl: the wiki's current URL (wikifile:// or wikifolder://)
destPath:  absolute filesystem path for the output
callback:  function(err) called on completion
*/
WindowList.prototype.convertWiki = function(sourceUrl, destPath, callback) {
	var self = this;
	var decodedSource = this.decodeUrl(sourceUrl);
	var sourcePath = decodedSource.info.pathname;
	var isFolder   = decodedSource.type === "folder";

	var args;
	if(isFolder) {
		// folder wiki -> single-file wiki
		args = [sourcePath, "--rendertiddler", "$:/core/save/all", destPath, "text/plain"];
	} else {
		// single-file wiki -> folder wiki
		args = ["--load", sourcePath, "--savewikifolder", destPath];
	}

	// boot.js lives in the boot directory
	var bootPath = path.resolve($tw.boot.bootPath, "boot.js");
	if(!fs.existsSync(bootPath)) {
		callback(new Error("Could not find TiddlyWiki boot.js at " + bootPath));
		return;
	}
	var expectedOutput = isFolder ? destPath : path.join(destPath, "tiddlywiki.info");

	console.log("[TiddlyDesktop] convertWiki: in-process boot, args:",JSON.stringify(args));

	// Run the conversion in a throwaway TiddlyWiki instance inside this (Node)
	// process. This avoids spawning the nw binary as a child, which in NW.js
	// flashes a window and crashes on isolate teardown. The desktop's own $tw is
	// untouched — TiddlyWiki()'s instances are independent.
	var settled = false, timer = null, exitTrapped = false;
	var realExit = process.exit;
	function restoreExit() { if(process.exit !== realExit) { process.exit = realExit; } }
	function finish(err) {
		if(settled) { return; }
		settled = true;
		restoreExit();
		if(timer) { clearTimeout(timer); timer = null; }
		// Judge success on the produced artifact, not on how boot returned.
		var ok = !err;
		try { if(!fs.existsSync(expectedOutput)) { ok = false; if(!err) { err = new Error("Conversion produced no output"); } } } catch(_e) {}
		if(ok) {
			// Register the converted wiki in the list by opening it (same path that
			// creating/cloning uses). The original wiki is left untouched.
			var newUrl = isFolder ? "wikifile://" + destPath : "wikifolder://" + destPath;
			console.log("[TiddlyDesktop] convertWiki: opening converted wiki",newUrl);
			self.openByUrl(newUrl);
			callback(null);
		} else {
			callback(err);
		}
	}

	var convTw;
	try {
		convTw = require(bootPath).TiddlyWiki();
	} catch(e) {
		finish(new Error("Could not initialise TiddlyWiki for conversion: " + e.message));
		return;
	}
	convTw.boot.argv = args;

	// TiddlyWiki calls process.exit() on a fatal command error. Trap it so a failed
	// conversion reports back instead of taking down the whole desktop app. Restored
	// in finish() (success, error, or timeout).
	process.exit = function(code) {
		exitTrapped = true;
		finish(code ? new Error("TiddlyWiki aborted the conversion (exit code " + code + ")") : null);
	};

	// Safety net in case boot never calls back.
	timer = setTimeout(function() {
		console.error("[TiddlyDesktop] convertWiki: timed out after 120s");
		finish(new Error("Conversion timed out after 120s"));
	}, 120000);

	try {
		convTw.boot.boot(function() {
			if(!exitTrapped) { finish(null); }
		});
	} catch(e) {
		finish(new Error("Conversion failed: " + e.message));
	}
};

exports.WindowList = WindowList;
