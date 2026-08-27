/*
Class for wiki folder windows
*/

"use strict";

var windowBase = require("../js/window-base.js"),
	hash = require("../js/utils/hash.js"),
	spellcheck = require("../js/utils/spellcheck.js"),
	wikiServer = require("../js/utils/wiki-server.js"),
	fs = require("fs"),
	path = require("path");

/*
Path of the per-wiki "live state" file for a given wiki identifier.

Kept only so window-list.js can delete files left behind by earlier versions; nothing writes it
now. A folder wiki used to open with `new_instance: true`, giving it its own app instance, which
meant the backstage could not observe its DOM and had to watch this file for the wiki's title and
favicon. See the constructor for why that isolation is gone.
*/
function liveStateFileFor(identifier) {
	return path.resolve($tw.desktop.gui.App.dataPath,"FolderWikiState",hash.simpleHash(identifier));
}

// Constructor
function WikiFolderWindow(options) {
	var self = this;
	options = options || {};
	this.windowList = options.windowList;
	this.info = options.info || {};
	this.pathname = options.info.pathname;
	this.mustQuitOnClose = options.mustQuitOnClose;
	this.saveWikiListTiddler();
	// The user's optional LAN sharing. A SEPARATE binding from the one this window uses:
	// different port, its own principals and the user's own path-prefix, so sharing a wiki on
	// the network can never expose the shell path or the internal credential.
	this.lanOptions = {
		host: $tw.wiki.getTiddlerText(this.getConfigTitle("host"),""),
		port: $tw.wiki.getTiddlerText(this.getConfigTitle("port"),""),
		credentials: $tw.wiki.getTiddlerText(this.getConfigTitle("credentials"),""),
		readers: $tw.wiki.getTiddlerText(this.getConfigTitle("readers"),"(anon)"),
		writers: $tw.wiki.getTiddlerText(this.getConfigTitle("writers"),"(authenticated)"),
		pathPrefix: $tw.wiki.getTiddlerText(this.getConfigTitle("path-prefix"),""),
		rootTiddler: $tw.wiki.getTiddlerText(this.getConfigTitle("root-tiddler"),""),
		anonUsername: $tw.wiki.getTiddlerText(this.getConfigTitle("anon-username"),""),
		gzip: $tw.wiki.getTiddlerText(this.getConfigTitle("gzip"),"no")
	};
	/*
	Served over loopback HTTP like a single-file wiki: the shell keeps Node (its path matches the
	manifest's node-remote) and the wiki, served at the origin root, does not. See
	utils/wiki-server.js and docs/security-model.md.

	`new_instance: true` is deliberately gone. It existed because a folder wiki booted TiddlyWiki
	— UI and all — into its own page, which had to be isolated from the rest of the app. The shell
	now runs only a node-only TiddlyWiki SERVER, and the wiki renders in a sandboxed iframe with
	its own renderer process, so that isolation buys nothing.

	It cost a good deal, though. A separate app instance has its own browser process, so the
	window did not report closing back to the backstage (window-list.js had to invoke onclose by
	hand), the title and favicon had to be mirrored through a file on disk, and quitApp's
	terminate-the-browser-process backstop could not reach it. Sharing the instance retires all
	three.
	*/
	if(this.isUnsandboxed()) {
		this.openUnsandboxed();
		return;
	}
	wikiServer.start({
		appDir: path.resolve(__dirname,".."),
		wikiDir: this.pathname,
		wikiFile: "",
		identifier: this.getIdentifier()
	},function(err,handle) {
		if(err || !handle) {
			console.error("[TiddlyDesktop] could not start the wiki server:",err && err.message);
			$tw.desktop.utils.wiki.alert("Could not open this wiki: its local server failed to start. " + ((err && err.message) || ""));
			// No window will ever exist for this entry — drop it from the window list, or the wiki
			// stays unopenable for the rest of the session. See handleOpenFailure.
			self.windowList.handleOpenFailure(self);
			return;
		}
		self.server = handle;
		$tw.desktop.gui.Window.open(handle.shellUrlFor("html/wiki-folder-shell.html"),self.applyGeometryToOpenOptions({
			id: hash.simpleHash(self.getIdentifier()),
			show: true,
			icon: "images/app-icon256.png"
		}),function(win) {
			self.window_nwjs = win;
			self.window_nwjs.once("loaded",self.onloaded.bind(self));
			self.window_nwjs.on("close",self.onclose.bind(self));
			self.trackGeometry();
			self.restoreMaximizedState();
		});
	});
}

/*
Escape hatch: run this wiki the old way — TiddlyWiki booted straight into the window, with full
Node available to the wiki's own JavaScript.

Off by default, and deliberately per wiki. Sandboxing a folder wiki is a compatibility break: its
code could previously require() anything, and a wiki that shells out or uses a node module has no
other way to keep working. Making that reachable is the point; making it the default is not.

The flag lives in the BACKSTAGE config, never in the wiki, for the same reason trusted paths do —
a wiki that could set its own flag would grant itself Node.
*/
WikiFolderWindow.prototype.isUnsandboxed = function() {
	// Trimmed: the value may have been written by a checkbox, by hand, or by a tool that left a
	// trailing newline, and "yes\n" must not read as "not enabled".
	return String($tw.wiki.getTiddlerText(this.getConfigTitle("unsandboxed"),"no")).trim() === "yes";
};

/*
The pre-sandbox boot path, kept verbatim for the escape hatch: html/wiki-folder-window.html boots
TiddlyWiki in-page via wiki-folder-main.js, in its own app instance, with the live-state file
carrying the title and favicon back because the backstage cannot see into another instance.

Those files are not dead code; this is what they are for now.
*/
WikiFolderWindow.prototype.openUnsandboxed = function() {
	var self = this;
	console.warn("[TiddlyDesktop] opening " + this.getIdentifier() + " UNSANDBOXED: its scripts run with full Node access");
	this.stateFile = liveStateFileFor(this.getIdentifier());
	try {
		fs.mkdirSync(path.dirname(this.stateFile),{recursive: true});
		if(!fs.existsSync(this.stateFile)) { fs.writeFileSync(this.stateFile,""); }
	} catch(e) {}
	var lan = this.lanOptions;
	$tw.desktop.gui.Window.open("html/wiki-folder-window.html?pathname=" + encodeURIComponent(this.pathname)
			+ "&host=" + encodeURIComponent(lan.host) + "&port=" + encodeURIComponent(lan.port)
			+ "&credentials=" + encodeURIComponent(lan.credentials) + "&readers=" + encodeURIComponent(lan.readers)
			+ "&writers=" + encodeURIComponent(lan.writers) + "&pathprefix=" + encodeURIComponent(lan.pathPrefix)
			+ "&roottiddler=" + encodeURIComponent(lan.rootTiddler) + "&anonusername=" + encodeURIComponent(lan.anonUsername)
			+ "&gzip=" + encodeURIComponent(lan.gzip)
			+ "&spellcheck=" + encodeURIComponent(spellcheck.isEnabled($tw) ? "yes" : "no")
			+ "&stateFile=" + encodeURIComponent(this.stateFile),this.applyGeometryToOpenOptions({
		id: hash.simpleHash(this.getIdentifier()),
		show: true,
		new_instance: true,
		icon: "images/app-icon256.png"
	}),function(win) {
		self.window_nwjs = win;
		self.window_nwjs.once("loaded",self.onloadedUnsandboxed.bind(self));
		self.window_nwjs.on("close",self.onclose.bind(self));
		self.trackGeometry();
		self.restoreMaximizedState();
	});
};

// Load handler for the unsandboxed path: watch the live-state file, since the window runs in its
// own app instance and its DOM is not reachable from here.
WikiFolderWindow.prototype.onloadedUnsandboxed = function() {
	var self = this;
	this.readStateFile();
	try {
		this.stateWatcher = fs.watch(this.stateFile,function() {
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

// The identifier for wiki folder windows is the prefix `wikifolder://` plus the pathname
WikiFolderWindow.prototype.getIdentifier = function() {
	return "wikifolder://" + this.pathname;
};

// Load handler for window
WikiFolderWindow.prototype.onloaded = function(event) {
	var self = this;
	this.window_nwjs.window.$tw = $tw;
	$tw.desktop.utils.devtools.trapDevTools(this.window_nwjs,this.window_nwjs.window.document);
	$tw.desktop.utils.menu.createMenuBar(this.window_nwjs);
	this.iframe = this.window_nwjs.window.document.getElementById("tid-main-wiki-folder-viewer");
	// Ask the shell to boot TiddlyWiki as a server, then point our forwarder at it. The backend
	// does not exist until this returns, which is why the proxy target is set late.
	var starter = this.window_nwjs.window.tdStartWikiServer;
	if(typeof starter !== "function") {
		console.error("[TiddlyDesktop] folder wiki shell did not expose tdStartWikiServer");
		return;
	}
	starter({
		appDir: path.resolve(__dirname,".."),
		wikiPath: this.pathname,
		lan: this.lanOptions
	},function(err,backend) {
		if(err || !backend) {
			$tw.desktop.utils.wiki.alert("Could not open this wiki: TiddlyWiki failed to start. " + ((err && err.message) || ""));
			return;
		}
		self.server.setProxy({origin: backend.origin, authHeader: backend.authHeader});
		self.iframe.onload = self.onloadiframe.bind(self);
		// The wiki lives at the origin root. The session cookie was set when the shell was
		// served, so this request carries it.
		self.iframe.src = self.server.origin + "/";
	});
	this.window_nwjs.show();
	this.window_nwjs.focus();
};

/*
Load handler for the wiki iframe. Runs on every load, including in-place reloads, so the previous
load's teardowns run first — the same contract as wiki-file-window.js.
*/
WikiFolderWindow.prototype.onloadiframe = function() {
	var self = this;
	if(this._iframeTeardowns) {
		this._iframeTeardowns.forEach(function(fn) { try { fn(); } catch(e) {} });
	}
	this._iframeTeardowns = [];
	if(!this._iframeCloseBound) {
		this._iframeCloseBound = true;
		this.window_nwjs.once("close",function() {
			(self._iframeTeardowns || []).forEach(function(fn) { try { fn(); } catch(e) {} });
			self._iframeTeardowns = [];
		});
	}
	this.applySpellcheck();
	var doc = this.iframe.contentDocument,
		win = this.iframe.contentWindow;
	// TiddlyWiki's text editor puts its <textarea> in an iframe of its own, created when the user opens
	// an editor — long after this load, and inheriting nothing from the wiki document. Stamp each one
	// as it appears; the teardown list ends the watch on reload or close.
	this._iframeTeardowns.push(spellcheck.observeFrames(doc,function() {
		return spellcheck.isEnabled($tw);
	}));
	// Paint this shell with the wiki's own canvas: it is what shows through anything the wiki
	// leaves transparent, the page scrollbar's track included. See utils/shell-backdrop.js.
	try {
		var backdrop = require("./utils/shell-backdrop.js").install({
			iframe: this.iframe,
			hostDocument: this.window_nwjs.window.document
		});
		if(backdrop) { this._iframeTeardowns.push(backdrop.teardown); }
	} catch(e) { console.error("[TiddlyDesktop] shell backdrop install failed:",e); }
	try { $tw.desktop.utils.links.trapLinks(doc); } catch(e) { console.error("[TiddlyDesktop] trapLinks failed:",e); }
	try {
		$tw.desktop.utils.dragdrop.installImportInterceptor(doc,win,{
			parentDocument: this.window_nwjs.window.document,
			parentWindow: this.window_nwjs.window
		});
	} catch(e) { console.error("[TiddlyDesktop] dragdrop install failed:",e); }
	try {
		$tw.desktop.utils.findbar.installFindBar({
			hostWindow: this.window_nwjs.window,
			hostDocument: this.window_nwjs.window.document,
			getContentWindow: function() { return self.iframe.contentWindow; },
			getContentDocument: function() { return self.iframe.contentDocument; }
		});
	} catch(e) { console.error("[TiddlyDesktop] find bar install failed:",e); }
	try { require("./utils/zoom.js").install(this.window_nwjs,this.window_nwjs.window.document,doc); } catch(e) {}
	// Route attachments onto the attachment origin. Folder wikis need RELATIVE ones handled too:
	// TiddlyWiki's server answers only its own routes, so "pics/photo.png" would 404.
	try {
		this._attachments = require("./utils/attachments.js").install(doc,win,this.server,{wikiDir: this.pathname});
	} catch(e) { console.error("[TiddlyDesktop] attachment routing install failed:",e); }
	// In-wiki offer to trust an attachment's location. Folder wikis were missing this entirely —
	// their absolute attachments could be refused with no way to grant from inside the wiki.
	try {
		var _tu = require("./utils/trust-ui.js").install(doc,win,{
			identifier: this.getIdentifier(),
			wikiDir: this.pathname,
			onGranted: function() {
				if(self._attachments) { self._attachments.refresh(); }
			},
			openPicker: function(kind,seedPath,cb) {
				var hostDoc = self.window_nwjs.window.document;
				var input = hostDoc.createElement("input");
				input.type = "file";
				if(kind === "dir") { input.setAttribute("nwdirectory",""); }
				if(seedPath) { input.setAttribute("nwworkingdir",String(seedPath)); }
				input.style.display = "none";
				hostDoc.body.appendChild(input);
				input.addEventListener("change",function() {
					var chosen = input.value ? path.resolve(input.value) : null;
					try { input.parentNode.removeChild(input); } catch(e) {}
					try { cb(chosen); } catch(e) {}
				});
				input.click();
			}
		});
		if(_tu) { this._iframeTeardowns.push(_tu.teardown); }
	} catch(e) { console.error("[TiddlyDesktop] trust UI install failed:",e); }
	// Dropping a file with External Attachments enabled should reference it where it lives rather
	// than embedding its bytes, resolved against the WIKI FOLDER. That hook used to run in-page
	// with Node; it is installed onto the wiki's own $tw from here now.
	try { require("./utils/attachment-import.js").install(win,this.pathname); } catch(e) {
		console.error("[TiddlyDesktop] folder import hook install failed:",e);
	}
	try { require("./utils/embeds.js").install(doc,win); } catch(e) {}
	// Node-backed bridges. Folder wikis need these now for the same reason single-file wikis
	// always did: the wiki has no Node, so the parent performs the privileged operations the
	// collab plugin needs. Before phase 9 they used Node directly in-page, which is what
	// asset-util.js's nodeFs branch was for — with both wiki kinds on the bridge, that split
	// no longer has two sides.
	try {
		require("./utils/bridges.js").install({
			iframe: this.iframe,
			window_nwjs: this.window_nwjs,
			pathname: this.pathname,
			wikiDir: this.pathname,
			identifier: this.getIdentifier(),
			teardowns: this._iframeTeardowns,
			owner: this
		});
	} catch(e) { console.error("[TiddlyDesktop] bridge install failed:",e); }
	// Title and favicon, read straight off the wiki now that it renders in an iframe the
	// backstage can see. This is what the live-state file used to carry across processes.
	var MutationObserver = this.window_nwjs.window.MutationObserver;
	var titleNode = doc.getElementsByTagName("title")[0];
	this.extractIframeTitle();
	if(titleNode) {
		this.titleObserver = new MutationObserver(this.extractIframeTitle.bind(this));
		this.titleObserver.observe(titleNode,{attributes: true, childList: true, characterData: true});
	}
	var faviconLink = doc.getElementById("faviconLink");
	this.extractIframeFavicon();
	if(faviconLink) {
		this.favIconObserver = new MutationObserver(this.extractIframeFavicon.bind(this));
		this.favIconObserver.observe(faviconLink,{attributes: true, childList: true, characterData: true});
	}
};

// Apply the local-spellcheck setting to the wiki's document, and to any editor frames already open
// inside it. Safe to call any time.
WikiFolderWindow.prototype.applySpellcheck = function() {
	try {
		spellcheck.applyToDocument(this.iframe && this.iframe.contentDocument,
			spellcheck.isEnabled($tw));
	} catch(e) {}
};

WikiFolderWindow.prototype.extractIframeTitle = function() {
	try {
		this.wikiTitle = this.iframe.contentDocument.title;
		this.window_nwjs.window.document.title = this.wikiTitle;
		this.onTitleChange();
	} catch(e) {}
};

WikiFolderWindow.prototype.extractIframeFavicon = function() {
	try {
		var faviconLink = this.iframe.contentDocument.getElementById("faviconLink"),
			href = faviconLink && faviconLink.getAttribute("href");
		// Only a real data: URI is a favicon; the static placeholder means "none", and clearing
		// lets the wiki list show its missing-favicon placeholder rather than a broken thumbnail.
		if(href && href.indexOf("data:") === 0) {
			var posColon = href.indexOf(":"),
				posSemiColon = href.indexOf(";"),
				posComma = href.indexOf(",");
			this.wikiFavIconType = href.substring(posColon + 1,posSemiColon);
			this.wikiFavIconText = href.substring(posComma + 1);
			this.onFavIconChange();
		} else {
			this.clearFavIcon();
		}
	} catch(e) {}
};

// Reopen this window — raise it (show / un-minimise / focus), see window-base.js.
WikiFolderWindow.prototype.reopen = function() {
	this.focusWindow();
};

WikiFolderWindow.prototype.getWikiTitle = function() {
	return this.wikiTitle || "";
};

WikiFolderWindow.prototype.getWikiFavIconText = function() {
	return this.wikiFavIconText || "";
};

WikiFolderWindow.prototype.getWikiFavIconType = function() {
	return this.wikiFavIconType || "";
};

// Close handler for window
WikiFolderWindow.prototype.onclose = function(event) {
	if(this.stateReadTimer) { clearTimeout(this.stateReadTimer); this.stateReadTimer = null; }
	if(this.stateWatcher) { try { this.stateWatcher.close(); } catch(e) {} this.stateWatcher = null; }
	if(this.titleObserver) { try { this.titleObserver.disconnect(); } catch(e) {} }
	if(this.favIconObserver) { try { this.favIconObserver.disconnect(); } catch(e) {} }
	// Stop serving this wiki. The parent's per-window server and its session token die with the
	// window, so a closed wiki is no longer reachable by anything else on the machine.
	if(this.server) {
		try { this.server.close(); } catch(e) {}
		this.server = null;
	}
	// TiddlyWiki itself now runs as a CHILD PROCESS (wiki-folder-server.js), which does not die
	// with the window the way the old in-window server did. Left running it would keep the wiki
	// folder writable through a loopback port nothing is watching any more.
	try {
		var stopper = this.window_nwjs && this.window_nwjs.window && this.window_nwjs.window.tdStopWikiServer;
		if(typeof stopper === "function") { stopper(); }
	} catch(e) {
		console.error("[TiddlyDesktop] could not stop the folder wiki server:",e);
	}
	// Close the window, removing it from the wiki list if it was marked for removal.
	this.windowList.handleClose(this,this.mustRemoveFromWikiListOnClose);
};

// Save a tiddler to the backstage wiki describing this wiki folder
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
