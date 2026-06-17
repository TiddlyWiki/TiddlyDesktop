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
	folderLiveStateFileFor = require("./wiki-folder-window.js").liveStateFileFor,
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
		// Seed the wiki-list label straight from disk so it shows immediately, without
		// waiting for the wiki to boot. The window's live title extraction refines it
		// afterwards (and matches this value, so there's no flicker).
		this.seedTitleFromDisk(WindowConstructor,info);
		// Flag TiddlyWiki Classic wikis so the list can hide the convert/plugins buttons
		// (both are TW5-only). Read from disk at add/open time.
		this.updateClassicFlag(WindowConstructor,info);
	}
};

// Read a wiki's title from disk at add-time and write it to the wiki-list title config,
// unless we already have a label for this entry (e.g. from a previous session). Folder
// wikis: read $:/SiteTitle / $:/SiteSubtitle tiddler files; single-file wikis: read the
// saved <title>. Best-effort and fully guarded — any failure just leaves the boot-time
// extraction to fill the label in.
WindowList.prototype.seedTitleFromDisk = function(WindowConstructor,info) {
	try {
		var identifier = WindowConstructor.getIdentifierFromInfo(info);
		if($tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/title/" + identifier,"")) { return; }
		var type = (WindowConstructor === WikiFolderWindow) ? "folder" : (WindowConstructor === WikiFileWindow) ? "file" : null;
		this.writeTitleConfig(identifier,this.readWikiTitleFromDisk(type,info.pathname));
	} catch(e) {}
};

// Read a wiki's display title from disk for the given decoded type ("folder"/"file").
WindowList.prototype.readWikiTitleFromDisk = function(type,pathname) {
	if(type === "folder") { return this.readFolderWikiTitle(pathname); }
	if(type === "file") { return this.readSingleFileWikiTitle(pathname); }
	return null;
};

// Write the wiki-list title-config tiddler for an identifier, when we have a title.
WindowList.prototype.writeTitleConfig = function(identifier,title) {
	if(!title) { return; }
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),{title: "$:/TiddlyDesktop/Config/title/" + identifier, text: title},$tw.wiki.getModificationFields()));
};

// Write the wiki-list favicon-config tiddler for an identifier (base64 text + mime
// type), the same shape the live favicon extraction produces. No-op without data.
WindowList.prototype.writeFaviconConfig = function(identifier,text,type) {
	if(!text) { return; }
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),{title: "$:/TiddlyDesktop/Config/favicon/" + identifier, text: text, type: type || "image/x-icon"},$tw.wiki.getModificationFields()));
};

// Ensure a folder wiki's tiddlywiki.info declares the plugins a server wiki needs to
// save: tiddlywiki/filesystem (server-side persistence) and tiddlywiki/tiddlyweb (the
// HTTP sync API + client syncadaptor) — the same set the stock server edition ships.
// Added if missing, preserving any other plugins/fields. No-op if the info file can't
// be read. Call this everywhere a folder wiki is created or converted into.
WindowList.FOLDER_WIKI_PLUGINS = ["tiddlywiki/filesystem","tiddlywiki/tiddlyweb"];
WindowList.prototype.ensureFolderWikiPlugins = function(folderPath) {
	var infoPath = path.resolve(folderPath,"tiddlywiki.info"),
		info;
	try { info = JSON.parse(fs.readFileSync(infoPath,"utf8")); } catch(e) { return; }
	if(!Array.isArray(info.plugins)) { info.plugins = []; }
	var changed = false;
	WindowList.FOLDER_WIKI_PLUGINS.forEach(function(name) {
		if(info.plugins.indexOf(name) === -1) { info.plugins.push(name); changed = true; }
	});
	if(changed) {
		try { fs.writeFileSync(infoPath,JSON.stringify(info,null,4),"utf8"); } catch(e) {}
	}
};

// Recursively delete a directory (the exploded copy of a plugin we're about to reference by
// name instead). Tolerant of the various fs APIs across Node versions; never throws.
function removeDirRecursive(dir) {
	try {
		if(typeof fs.rmSync === "function") { fs.rmSync(dir,{recursive: true, force: true}); return; }
		if(typeof fs.rmdirSync === "function") { fs.rmdirSync(dir,{recursive: true}); return; }
	} catch(e) {}
}

// After --savewikifolder, every plugin/theme/language the source single-file wiki carried is
// exploded into the new folder. But any of them the FOLDER wiki can resolve by name at boot —
// because it's bundled OR on TIDDLYWIKI_PLUGIN_PATH / _THEME_PATH / _LANGUAGE_PATH — needs no
// private copy: a copy only bloats the folder and silently shadows (freezing) the
// bundled/updatable version. So we prune each resolvable one and reference it by name in
// tiddlywiki.info, leaving only genuinely custom items on disk. TiddlyWiki's own savewikifolder
// only checks the bundled library folder, not the env paths — and we can't patch core here
// (source/tiddlywiki is rebuilt from upstream each build), so we post-process the output.
WindowList.LIBRARY_KINDS = [
	{dir: "plugins",   infoKey: "plugins",   prefix: "$:/plugins/",   pathKey: "pluginsPath",   envKey: "pluginsEnvVar"},
	{dir: "themes",    infoKey: "themes",    prefix: "$:/themes/",    pathKey: "themesPath",    envKey: "themesEnvVar"},
	{dir: "languages", infoKey: "languages", prefix: "$:/languages/", pathKey: "languagesPath", envKey: "languagesEnvVar"}
];
WindowList.prototype.pruneResolvablePluginsFromFolder = function(folderPath) {
	// Needs the Node-boot library helpers (present in this app's $tw); skip quietly otherwise.
	if(typeof $tw.getLibraryItemSearchPaths !== "function" || typeof $tw.findLibraryItem !== "function") { return; }
	var infoPath = path.resolve(folderPath,"tiddlywiki.info"),
		info;
	try { info = JSON.parse(fs.readFileSync(infoPath,"utf8")); } catch(e) { return; }
	var changed = false;
	WindowList.LIBRARY_KINDS.forEach(function(kind) {
		var typeDir = path.resolve(folderPath,kind.dir),
			searchPaths;
		try { searchPaths = $tw.getLibraryItemSearchPaths($tw.config[kind.pathKey],$tw.config[kind.envKey]); } catch(e) { return; }
		// Collect every exploded item (a directory containing a plugin.info) under this kind's dir.
		var pluginDirs = [];
		(function walk(dir) {
			var entries;
			try { entries = fs.readdirSync(dir,{withFileTypes: true}); } catch(e) { return; }
			if(entries.some(function(en) { return en.isFile() && en.name === "plugin.info"; })) {
				pluginDirs.push(dir);   // a plugin folder — don't descend into its own tiddlers
				return;
			}
			entries.forEach(function(en) { if(en.isDirectory()) { walk(path.resolve(dir,en.name)); } });
		}(typeDir));
		pluginDirs.forEach(function(pluginDir) {
			var meta;
			try { meta = JSON.parse(fs.readFileSync(path.resolve(pluginDir,"plugin.info"),"utf8")); } catch(e) { return; }
			var title = meta && meta.title;
			if(!title || title.indexOf(kind.prefix) !== 0) { return; }
			var name = title.slice(kind.prefix.length);
			if(!name) { return; }
			// Resolvable by the folder wiki at boot (bundled or on the env path)?
			var found = null;
			try { found = $tw.findLibraryItem(name,searchPaths); } catch(e) {}
			if(!found) { return; }
			// Reference it by name and drop the private copy.
			if(!Array.isArray(info[kind.infoKey])) { info[kind.infoKey] = []; }
			if(info[kind.infoKey].indexOf(name) === -1) { info[kind.infoKey].push(name); }
			removeDirRecursive(pluginDir);
			changed = true;
		});
	});
	if(changed) {
		try { fs.writeFileSync(infoPath,JSON.stringify(info,null,4),"utf8"); } catch(e) {}
	}
};

// Build a folder wiki's window title the same way TiddlyWiki does ($:/core/wiki/title:
// SiteTitle, then " — SiteSubtitle" when the subtitle is non-empty). Missing tiddler
// files mean the wiki uses the core defaults, so we fall back to those.
WindowList.prototype.readFolderWikiTitle = function(pathname) {
	var tiddlersDir = path.resolve(pathname,"tiddlers"),
		siteTitle = this.readTidFileText(path.resolve(tiddlersDir,"$__SiteTitle.tid"),"My TiddlyWiki"),
		siteSubtitle = this.readTidFileText(path.resolve(tiddlersDir,"$__SiteSubtitle.tid"),"a non-linear personal web notebook");
	if(!siteTitle) { return null; }
	return (siteSubtitle && siteSubtitle.trim().length >= 1) ? (siteTitle + " — " + siteSubtitle) : siteTitle;
};

// Read the text field of a .tid file (the body after the blank line that separates the
// header fields from the text). Returns defaultValue if the file can't be read.
WindowList.prototype.readTidFileText = function(filepath,defaultValue) {
	var content;
	try {
		content = fs.readFileSync(filepath,"utf8");
	} catch(e) {
		return defaultValue;
	}
	content = content.replace(/\r\n/g,"\n");
	var idx = content.indexOf("\n\n");
	return idx === -1 ? "" : content.slice(idx + 2).replace(/\n+$/,"");
};

// Extract a single-file wiki's title from its saved <title> element. The element lives
// in <head> at the very top of the file, so we only read the first 64KB rather than the
// whole (potentially huge) wiki. TiddlyWiki writes <title>{{$:/core/wiki/title}}</title>
// at save time, so this is exactly the value the iframe later reports.
WindowList.prototype.readSingleFileWikiTitle = function(pathname) {
	var head = this.readFileHead(pathname);
	if(!head) { return null; }
	var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
	if(!m) { return null; }
	return this.decodeHtmlEntities(m[1]).trim() || null;
};

// Read the first 64KB of a file as text (the <head> of a single-file wiki lives there).
WindowList.prototype.readFileHead = function(pathname) {
	var fd,
		bytes = 0,
		buf = Buffer.alloc(65536);
	try {
		fd = fs.openSync(pathname,"r");
		bytes = fs.readSync(fd,buf,0,buf.length,0);
	} catch(e) {
		if(fd !== undefined) { try { fs.closeSync(fd); } catch(e2) {} }
		return null;
	}
	try { fs.closeSync(fd); } catch(e) {}
	return buf.toString("utf8",0,bytes);
};

// A single-file wiki is TiddlyWiki Classic (not TW5) when its <head> lacks the
// tiddlywiki-version meta that every TW5 file declares. Classic wikis can't be converted
// (the converter uses TW5's boot) and have no folder format, so the convert/plugins
// buttons are hidden for them. An unreadable file is treated as not-Classic (the convert
// path already errors gracefully).
WindowList.prototype.isSingleFileClassic = function(pathname) {
	var head = this.readFileHead(pathname);
	if(!head) { return false; }
	return !(/<meta[^>]+name=["']tiddlywiki-version["']/i).test(head);
};

// Set/clear the per-wiki "this is a Classic wiki" flag the wiki list reads. Only
// single-file wikis can be Classic (folder wikis are always TW5).
WindowList.prototype.updateClassicFlag = function(WindowConstructor,info) {
	if(WindowConstructor !== WikiFileWindow) { return; }
	try {
		var configTitle = "$:/TiddlyDesktop/Config/classic/" + WindowConstructor.getIdentifierFromInfo(info);
		if(this.isSingleFileClassic(info.pathname)) {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: configTitle, text: "yes"}));
		} else {
			$tw.wiki.deleteTiddler(configTitle);
		}
	} catch(e) {}
};

// Minimal HTML entity decode for titles read out of a saved wiki's <title> element.
WindowList.prototype.decodeHtmlEntities = function(s) {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g,function(_,h) { return String.fromCodePoint(parseInt(h,16)); })
		.replace(/&#(\d+);/g,function(_,d) { return String.fromCodePoint(parseInt(d,10)); })
		.replace(/&mdash;/g,"—")
		.replace(/&ndash;/g,"–")
		.replace(/&nbsp;/g," ")
		.replace(/&quot;/g,'"')
		.replace(/&apos;/g,"'")
		.replace(/&lt;/g,"<")
		.replace(/&gt;/g,">")
		.replace(/&amp;/g,"&");
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
	// Find the open window for this url, if any.
	var decodedUrl = this.decodeUrl(url),
		w = decodedUrl.WindowConstructor && this.find(decodedUrl.WindowConstructor,decodedUrl.info);
	if(w) {
		// Mark for removal, then close the window first — exactly like single-file wikis.
		w.removeFromWikiListOnClose();
		if(w instanceof WikiFolderWindow) {
			// A folder wiki runs in its own process (new_instance), so closing its window
			// doesn't fire a close event back to the backstage — which is why these used to
			// stay in the list once opened. Run its close handler ourselves: it tears down
			// the live-state watcher, then handleClose closes the window and removes the
			// wiki-list entry (the same end result as a single-file wiki's own close event).
			w.onclose();
		} else {
			// Single-file: closing fires the window's own close handler, which honours the
			// remove-on-close flag (and may still prompt via onbeforeunload).
			w.window_nwjs.close();
		}
	} else {
		// No open window. The wiki-list entry's tiddler is titled by this url (it is
		// the row's currentTiddler), so delete it directly. This is robust for URL
		// wikis (http/https) and any malformed entry, whose scheme decodeUrl can't map
		// to a window constructor — previously removeByInfo() dereferenced a null
		// constructor and threw, leaving the entry unremovable.
		$tw.wiki.deleteTiddler(url);
		this.cleanupRemovedWiki(url);
	}
};

// Remove the per-wiki artifacts tied to a wiki-list entry that's being deleted: the
// cached title/favicon config tiddlers, and (for folder wikis) the live-state file the
// folder window writes to. Safe for any entry type — single-file/URL wikis simply have
// no state file, and a missing path is ignored.
WindowList.prototype.cleanupRemovedWiki = function(identifier) {
	$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/title/" + identifier);
	$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/favicon/" + identifier);
	$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/geometry/" + identifier);
	$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/classic/" + identifier);
	try {
		var stateFile = folderLiveStateFileFor(identifier);
		if(fs.existsSync(stateFile)) { fs.unlinkSync(stateFile); }
	} catch(e) {}
};

WindowList.prototype.removeByInfo = function(WindowConstructor,info) {
	var wikiListTiddlerTitle = WindowConstructor.getIdentifierFromInfo(info);
	$tw.wiki.deleteTiddler(wikiListTiddlerTitle);
	this.cleanupRemovedWiki(wikiListTiddlerTitle);
};

WindowList.prototype.handleClose = function(w,removeFromWikiListOnClose) {
	// Idempotent: a folder wiki's removal runs this directly (its window's close event
	// never reaches the backstage), while single-file wikis run it from their own close
	// handler — so guard against handling the same window twice.
	if(w._closeHandled) { return; }
	w._closeHandled = true;
	// Remove from the wiki list if required
	if(removeFromWikiListOnClose) {
		var wikiListTiddlerTitle = w.getIdentifier();
		$tw.wiki.deleteTiddler(wikiListTiddlerTitle);
		this.cleanupRemovedWiki(wikiListTiddlerTitle);
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
		this.cloneFileToPath(decodedSource.info.pathname,this.ensureWikiFileExtension(dest));
	} else if(decodedSource.type === "http" || decodedSource.type === "https") {
		this.cloneWebToPath(decodedSource.info.url,this.ensureWikiFileExtension(dest));
	} else {
		console.log("Cannot clone",source,dest);
	}
};

// A single-file wiki must be saved with a .html / .htm extension; without one it is
// written as an unrecognised file that opens to an unresponsive window. If the chosen
// path doesn't already end in .html or .htm, append .html (this also covers a name with
// some other extension, which TiddlyDesktop can't open as a wiki either).
WindowList.prototype.ensureWikiFileExtension = function(dest) {
	return (/\.html?$/i).test(String(dest)) ? dest : dest + ".html";
};

/*
Clone an existing wiki folder
source: path to wiki folder
dest: path of destination folder
*/
WindowList.prototype.cloneFolderToPath = function(source,dest) {
	$tw.utils.copyDirectory(source,dest);
	// The clone is a folder wiki — make sure it can save even if the source's info was
	// incomplete.
	try { this.ensureFolderWikiPlugins(dest); } catch(e) {}
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
			"plugins": WindowList.FOLDER_WIKI_PLUGINS.slice(),
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

	// folder -> single-file: the output is a wiki file, so it needs a .html/.htm extension.
	if(isFolder) { destPath = this.ensureWikiFileExtension(destPath); }

	var args;
	if(isFolder) {
		// folder wiki -> single-file wiki. Strip the server-only plugins first: a
		// single-file wiki has no server, and tiddlywiki/tiddlyweb's client syncadaptor
		// would otherwise activate and try to sync to a server that isn't there. (server
		// is included for folder wikis created by older builds.)
		args = [sourcePath,
			"--deletetiddlers", "[[$:/plugins/tiddlywiki/filesystem]] [[$:/plugins/tiddlywiki/tiddlyweb]] [[$:/plugins/tiddlywiki/server]]",
			"--rendertiddler", "$:/core/save/all", destPath, "text/plain"];
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
			// Carry the wiki's title across the conversion. We read $:/SiteTitle /
			// $:/SiteSubtitle from the (still-present) source — single-file via its
			// <title>, folder via its tiddler files — and seed the new entry's label
			// up-front, so the converted wiki shows its real title immediately and
			// independently of how the conversion laid the output out on disk. This gives
			// both directions (single->folder and folder->single) the same guarantee.
			try { self.writeTitleConfig(newUrl,self.readWikiTitleFromDisk(decodedSource.type,sourcePath)); } catch(_e) {}
			// Carry the favicon too. We read $:/favicon.ico from the just-loaded conversion
			// instance, which holds it as a clean tiddler (base64 text + mime type) for
			// both source forms — folders store it as a binary file + .meta, single-files
			// embed it in the store area, but convTw normalises both. This matters most for
			// folder destinations, whose windows don't extract a favicon live.
			try {
				var faviconTiddler = convTw && convTw.wiki && convTw.wiki.getTiddler("$:/favicon.ico");
				if(faviconTiddler) { self.writeFaviconConfig(newUrl,faviconTiddler.fields.text,faviconTiddler.fields.type); }
			} catch(_e) {}
			// When converting TO a folder, the (browser) single-file source has no server
			// plugins, so savewikifolder's generated tiddlywiki.info lacks tiddlywiki/filesystem
			// and tiddlywiki/tiddlyweb — without which the folder wiki can't run its server or
			// save to disk. Add them so the converted folder is immediately usable.
			if(!isFolder) {
				try { self.ensureFolderWikiPlugins(destPath); } catch(_e) {}
				// Don't keep private copies of plugins the folder wiki can resolve by name
				// (bundled or on TIDDLYWIKI_PLUGIN_PATH etc.) — reference them in tiddlywiki.info
				// instead, leaving only genuinely custom plugins in the folder.
				try { self.pruneResolvablePluginsFromFolder(destPath); } catch(_e) {}
			}
			console.log("[TiddlyDesktop] convertWiki: opening converted wiki",newUrl);
			self.openByUrl(newUrl);
			callback(null);
		} else {
			callback(err);
		}
		// Tear down the throwaway conversion instance so it leaves nothing running in the main
		// process. Conversion is IN-PROCESS — it never spawns a child nw/TiddlyDesktop process —
		// so the only thing it could leave is an in-memory handle such as the filesystem syncer's
		// timer; stop it and drop the reference so repeated conversions don't accumulate timers.
		try {
			if(convTw && convTw.syncer && convTw.syncer.taskTimerId) {
				clearTimeout(convTw.syncer.taskTimerId);
				convTw.syncer.taskTimerId = null;
			}
		} catch(_e) {}
		convTw = null;
	}

	var convTw;
	try {
		// Build an isolated boot seed (NOT the desktop's own $tw) and set the
		// conversion args BEFORE TiddlyWiki(). In NW.js both $tw.browser and $tw.node
		// are set, so readBrowserTiddlers is false and the NODE boot path runs *during*
		// the TiddlyWiki() call — it reads $tw.boot.argv.length, which throws
		// "Cannot read properties of undefined (reading 'length')" unless argv already
		// exists. suppressBoot stops the browser auto-boot so we drive boot() ourselves
		// (below) for a completion callback; TiddlyWiki() then parses argv in place.
		convTw = require(path.resolve($tw.boot.bootPath,"bootprefix.js")).bootprefix();
		convTw.boot = convTw.boot || {};
		convTw.boot.suppressBoot = true;
		convTw.boot.argv = args;
		require(bootPath).TiddlyWiki(convTw);
	} catch(e) {
		finish(new Error("Could not initialise TiddlyWiki for conversion: " + e.message));
		return;
	}

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
