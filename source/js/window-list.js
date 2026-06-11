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
	var childProcess = require("child_process");
	var decodedSource = this.decodeUrl(sourceUrl);
	var sourcePath = decodedSource.info.pathname;
	var isFolder   = decodedSource.type === "folder";

	// tiddlywiki.js lives one directory above the boot directory
	var twJsPath = path.resolve($tw.boot.bootPath, "..", "tiddlywiki.js");
	if(!fs.existsSync(twJsPath)) {
		callback(new Error("Could not find tiddlywiki.js at " + twJsPath));
		return;
	}

	var args;
	if(isFolder) {
		// folder wiki -> single-file wiki
		args = [sourcePath, "--rendertiddler", "$:/core/save/all", destPath, "text/plain"];
	} else {
		// single-file wiki -> folder wiki
		args = ["--load", sourcePath, "--savewikifolder", destPath];
	}

	console.log("[TiddlyDesktop] convertWiki: forking",twJsPath,"args:",JSON.stringify(args),"execPath:",process.execPath);

	// Guard against the callback firing twice (e.g. an "error" followed by "exit").
	var settled = false,
		timer = null;
	function finish(err) {
		if(settled) { return; }
		settled = true;
		if(timer) { clearTimeout(timer); timer = null; }
		callback(err);
	}

	var proc;
	try {
		// Run tiddlywiki.js as a Node child. In NW.js fork() routes the child into
		// Node mode via its IPC channel; execPath is the nw binary.
		proc = childProcess.fork(twJsPath, args, {silent: true, cwd: path.dirname(twJsPath)});
	} catch(e) {
		finish(new Error("Could not start TiddlyWiki conversion process: " + e.message));
		return;
	}
	var stderr = "", stdout = "";
	if(proc.stderr) {
		proc.stderr.on("data", function(data) { stderr += data.toString(); console.log("[TiddlyDesktop] convert stderr:",data.toString()); });
	}
	if(proc.stdout) {
		proc.stdout.on("data", function(data) { stdout += data.toString(); console.log("[TiddlyDesktop] convert stdout:",data.toString()); });
	}
	// Safety net: if the child never reports exit or error (e.g. it failed to enter
	// Node mode), don't hang silently — kill it and surface a diagnosable error.
	// The expected artifact of a successful conversion. We judge success on this
	// rather than on the child's exit code: NW.js runs tiddlywiki.js correctly as a
	// Node child (the conversion really happens), but the nw process then crashes
	// during isolate teardown and exits with a non-zero / null code. So a clean
	// exit code is NOT a reliable success signal — the produced file/folder is.
	var expectedOutput = isFolder ? destPath : path.join(destPath, "tiddlywiki.info");
	function conversionSucceeded() {
		try { return fs.existsSync(expectedOutput); } catch(_e) { return false; }
	}
	function completeOrFail(reason) {
		if(conversionSucceeded()) {
			// Add the converted wiki to the wiki list by opening it — the same path
			// creating or cloning a wiki uses (the window's saveWikiListTiddler
			// registers the list entry, which is how list entries are persisted).
			// The original wiki is left untouched, both on disk and in the list.
			var newUrl = isFolder ? "wikifile://" + destPath : "wikifolder://" + destPath;
			console.log("[TiddlyDesktop] convertWiki: opening converted wiki",newUrl);
			self.openByUrl(newUrl);
			finish(null);
		} else {
			finish(new Error(reason + (stderr ? ": " + stderr.slice(0, 300) : "")));
		}
	}

	timer = setTimeout(function() {
		console.error("[TiddlyDesktop] convertWiki: timed out after 120s, killing child");
		try { proc.kill(); } catch(_e) {}
		completeOrFail("Conversion timed out after 120s");
	}, 120000);
	// Fires if the process could not be spawned at all (bad executable, etc.).
	proc.on("error", function(err) {
		console.error("[TiddlyDesktop] convertWiki: spawn error",err);
		// The child can still have produced the output before an error/teardown crash.
		completeOrFail("TiddlyWiki conversion process error: " + err.message);
	});
	proc.on("exit", function(code) {
		console.log("[TiddlyDesktop] convertWiki: child exited with code",code,"output exists:",conversionSucceeded());
		completeOrFail("TiddlyWiki exited with code " + code + " and produced no output");
	});
};

exports.WindowList = WindowList;
