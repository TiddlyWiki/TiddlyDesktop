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
	utils/wiki-server.js and DESIGN-http-wiki-origin.md.

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
	wikiServer.start({
		appDir: path.resolve(__dirname,".."),
		wikiDir: this.pathname,
		wikiFile: "",
		identifier: this.getIdentifier()
	},function(err,handle) {
		if(err || !handle) {
			console.error("[TiddlyDesktop] could not start the wiki server:",err && err.message);
			$tw.desktop.utils.wiki.alert("Could not open this wiki: its local server failed to start. " + ((err && err.message) || ""));
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
		require("./utils/attachments.js").install(doc,win,this.server,{wikiDir: this.pathname});
	} catch(e) { console.error("[TiddlyDesktop] attachment routing install failed:",e); }
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

// Apply the local-spellcheck setting to the wiki's document. Safe to call any time.
WikiFolderWindow.prototype.applySpellcheck = function() {
	try {
		spellcheck.applyToDocument(this.iframe && this.iframe.contentDocument,
			spellcheck.isEnabled($tw),spellcheck.getLanguage($tw));
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

// Reopen this window — just focus it.
WikiFolderWindow.prototype.reopen = function() {
	try { this.window_nwjs.focus(); } catch(e) {}
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
	if(this.titleObserver) { try { this.titleObserver.disconnect(); } catch(e) {} }
	if(this.favIconObserver) { try { this.favIconObserver.disconnect(); } catch(e) {} }
	// Stop serving this wiki. The server and its session token die with the window, so a closed
	// wiki is no longer reachable by anything else on the machine.
	if(this.server) {
		try { this.server.close(); } catch(e) {}
		this.server = null;
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
