/*
Class for wiki file windows
*/

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
	$tw.desktop.gui.Window.open("html/wiki-file-window.html",this.applyGeometryToOpenOptions({
		id: hash.simpleHash(this.getIdentifier()),
		show: true,
		icon: "images/app-icon256.png"
	}),function(win) {
		self.window_nwjs = win;
		self.window_nwjs.once("loaded",self.onloaded.bind(self));
		self.window_nwjs.on("close",self.onclose.bind(self));
		self.trackGeometry();
		self.restoreMaximizedState();
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
	// Intercept cross-browser drag-drop imports so tiddlers dragged from Firefox
	// (which Chromium otherwise hands to TW as text/html) keep their fields
	$tw.desktop.utils.dragdrop.installImportInterceptor(
		this.iframe.contentDocument,
		this.iframe.contentWindow,
		{
			parentDocument: this.window_nwjs.window.document,
			parentWindow: this.window_nwjs.window
		}
	);
	// Browser-style find-in-page (Ctrl/Cmd+F). The bar lives in the outer wiki
	// window and searches the iframe content; it defers to any focused editor that
	// claims the shortcut (e.g. CodeMirror 6).
	try {
		$tw.desktop.utils.findbar.installFindBar({
			hostWindow: this.window_nwjs.window,
			hostDocument: this.window_nwjs.window.document,
			getContentWindow: function() { return self.iframe.contentWindow; },
			getContentDocument: function() { return self.iframe.contentDocument; }
		});
	} catch(e) {
		console.error("[TiddlyDesktop] find bar install failed:",e);
	}
	// Fullscreen: F11 and the fullscreen page-control button toggle the native window.
	// The wiki's tm-full-screen uses the HTML5 document API, which is blocked in this
	// nwdisable iframe (no allowfullscreen); reroute it to the native window instead.
	try {
		require("./utils/fullscreen.js").install(
			this.window_nwjs,
			this.iframe.contentDocument,
			function() {
				var cw = self.iframe && self.iframe.contentWindow;
				return cw && cw.$tw && cw.$tw.rootWidget;
			}
		);
	} catch(e) {
		console.error("[TiddlyDesktop] fullscreen install failed:",e);
	}
	// Page zoom: shortcuts bound on both the outer window and the iframe, with the reset
	// control living in the outer window (outside the wiki content, like the find bar).
	try {
		require("./utils/zoom.js").install(
			this.window_nwjs,
			this.window_nwjs.window.document,
			this.iframe.contentDocument
		);
	} catch(e) {
		console.error("[TiddlyDesktop] zoom install failed:",e);
	}
	// Grey out permalink/permaview — no shareable URL in a desktop wiki window. The wiki
	// renders inside the iframe, so the style goes into the iframe's document.
	try {
		require("./utils/disable-permalinks.js").install(this.iframe.contentDocument);
	} catch(e) {
		console.error("[TiddlyDesktop] disable-permalinks install failed:",e);
	}
	// Safe external embeds: enforce the allowlist and route allowlisted media iframes through
	// a loopback http shim (real origin -> avoids YouTube's file:// error 153). The wiki
	// document stays file://, so saving and the collab bridges below are unaffected.
	try {
		require("./utils/embeds.js").install(this.iframe.contentDocument,this.iframe.contentWindow);
	} catch(e) {
		console.error("[TiddlyDesktop] embeds install failed:",e);
	}
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
	// HTTP queue bridge for plugins running inside the nwdisable iframe.
	// nwdisable strips Node.js and suppresses any network I/O initiated from the
	// iframe's call stack. Solution: the parent owns a setInterval that drains a
	// shared request queue entirely from its own event loop tick. The iframe pushes
	// requests and polls results as plain window properties — no cross-context
	// function calls needed during async operations.
	try {
		var _httpsM = require("https"), _httpM = require("http");
		// Initialise the shared queue/results store visible to the iframe.
		self.iframe.contentWindow._nwjsHttpQueue   = [];
		self.iframe.contentWindow._nwjsHttpResults = {};
		// Parent-side queue processor — runs entirely in parent context.
		var _queueTimer = setInterval(function() {
			try {
				var cw    = self.iframe.contentWindow;
				var queue = cw._nwjsHttpQueue;
				if(!queue || !queue.length) return;
				var item = queue.shift();
				var mod  = (item.url && item.url.substr(0,8) === "https://") ? _httpsM : _httpM;
				mod.get(item.url, {headers: item.headers || {}}, function(res) {
					var body = "";
					res.setEncoding("utf8");
					res.on("data", function(c) { body += c; });
					res.on("end", function() {
						var results = cw._nwjsHttpResults;
						if(!results) return;
						if(res.statusCode < 200 || res.statusCode >= 300) {
							results[item.id] = {err: "HTTP " + res.statusCode};
						} else {
							try { results[item.id] = {data: JSON.parse(body)}; }
							catch(e) { results[item.id] = {err: "Invalid JSON"}; }
						}
					});
				}).on("error", function(e) {
					var results = cw._nwjsHttpResults;
					if(results) results[item.id] = {err: e.message || String(e)};
				});
			} catch(_e) {}
		}, 200);
		self.window_nwjs.once("close", function() { clearInterval(_queueTimer); });
		// Shell.openExternal bridge (GUI call — not affected by nwdisable).
		self.iframe.contentWindow._nwjsOpenExternal = function(url) {
			$tw.desktop.gui.Shell.openExternal(url);
		};
		// Notify oauth.js that the queue is ready.
		if(typeof self.iframe.contentWindow._nwjsHttpQueueReady === "function") {
			self.iframe.contentWindow._nwjsHttpQueueReady();
		}
		// File read/write bridge for the collab asset-transfer feature. The nwdisable
		// iframe can't use fs; the parent performs the op (relative paths resolved
		// against the wiki's own directory) and returns the result via the same
		// polled results-store pattern as the HTTP bridge.
		var _fsMod = require("fs"), _pathMod = require("path");
		var _wikiDir = _pathMod.dirname(self.pathname);
		self.iframe.contentWindow._nwjsWikiDir      = _wikiDir;
		// Machine hostname for a stable, clone-proof collab device name.
		try { self.iframe.contentWindow._nwjsHostname = require("os").hostname(); } catch(_e) {}
		self.iframe.contentWindow._nwjsFileCmdQueue = [];
		self.iframe.contentWindow._nwjsFileResults  = {};
		var _resolveAssetPath = function(p) {
			p = String(p || "");
			if((/^file:\/\//i).test(p)) { p = decodeURI(p.replace(/^file:\/\//i, "")); }
			return _pathMod.isAbsolute(p) ? p : _pathMod.resolve(_wikiDir, p);
		};
		var _fileTimer = setInterval(function() {
			try {
				var cw = self.iframe.contentWindow;
				var q = cw && cw._nwjsFileCmdQueue;
				if(!q || !q.length) return;
				var item = q.shift();
				if(item.op === "read") {
					_fsMod.readFile(_resolveAssetPath(item.path), function(err, buf) {
						var r = cw._nwjsFileResults; if(!r) return;
						r[item.id] = err ? {err: err.message} : {data: buf.toString("base64")};
					});
				} else if(item.op === "write") {
					var dest = _resolveAssetPath(item.path);
					try { _fsMod.mkdirSync(_pathMod.dirname(dest), {recursive: true}); } catch(_e) {}
					_fsMod.writeFile(dest, Buffer.from(item.base64, "base64"), function(err) {
						var r = cw._nwjsFileResults; if(!r) return;
						r[item.id] = err ? {err: err.message} : {data: dest};
					});
				}
			} catch(_e) {}
		}, 100);
		self.window_nwjs.once("close", function() { clearInterval(_fileTimer); });
		// WebSocket bridge — same queue-drain pattern as the HTTP bridge above.
		// All socket creation and event dispatch happen inside the parent's setInterval
		// tick (browser context) to avoid NW.js cross-context callback issues.
		// The iframe pushes commands to _nwjsWsCmdQueue; the parent processes them and
		// pushes events to _nwjsWsEventQueue; the setInterval drains both queues.
		var _wsLib = require("ws");
		var _wsPool = {};
		var _wsIdSeq = 0;
		self.iframe.contentWindow._nwjsWsCmdQueue   = [];
		self.iframe.contentWindow._nwjsWsEventQueue = [];
		var _wsTimer = setInterval(function() {
			try {
				var cw = self.iframe.contentWindow;
				if(!cw) return;
				// Process commands queued by the iframe
				var cmds = cw._nwjsWsCmdQueue;
				while(cmds && cmds.length) {
					var cmd = cmds.shift();
					if(cmd.op === "create") {
						(function(id, url, hdrs) {
							var wsHeaders = {"User-Agent": "TiddlyDesktop/1.0 NW.js"};
							Object.keys(hdrs || {}).forEach(function(k) { wsHeaders[k] = hdrs[k]; });
							console.log("[ws-bridge] Creating id=" + id + " url=" + url);
							try {
								var sock = new _wsLib(url, {headers: wsHeaders, perMessageDeflate: false, handshakeTimeout: 15000});
								_wsPool[id] = sock;
								sock.on("open",    function()        { if(cw._nwjsWsEventQueue) cw._nwjsWsEventQueue.push({id: id, type: "open",    data: null}); });
								sock.on("message", function(d, meta) { if(cw._nwjsWsEventQueue) cw._nwjsWsEventQueue.push({id: id, type: "message", data: (meta && meta.binary) ? d : d.toString("utf8")}); });
								// Forward server pings so the iframe's transport has a liveness signal on
								// an otherwise-idle room (ws auto-replies with a pong; we just observe).
								sock.on("ping",    function()        { if(cw._nwjsWsEventQueue) cw._nwjsWsEventQueue.push({id: id, type: "ping",    data: null}); });
								sock.on("close",   function()        { delete _wsPool[id]; if(cw._nwjsWsEventQueue) cw._nwjsWsEventQueue.push({id: id, type: "close",   data: null}); });
								sock.on("error",   function(e)       { console.error("[ws-bridge] Error id=" + id + ":", e && e.message); if(cw._nwjsWsEventQueue) cw._nwjsWsEventQueue.push({id: id, type: "error",   data: e && e.message || ""}); });
							} catch(e) {
								console.error("[ws-bridge] create failed:", e.message);
								if(cw._nwjsWsEventQueue) cw._nwjsWsEventQueue.push({id: id, type: "error", data: e.message});
							}
						})(cmd.id, cmd.url, cmd.headers);
					} else if(cmd.op === "send") {
						var _s = _wsPool[cmd.id];
						if(_s && _s.readyState === 1) { try { _s.send(cmd.data); } catch(_e) {} }
					} else if(cmd.op === "terminate") {
						var _t = _wsPool[cmd.id];
						if(_t) { try { _t.terminate(); } catch(_e) {} delete _wsPool[cmd.id]; }
					}
				}
				// Dispatch events from ws sockets to the iframe
				var evts = cw._nwjsWsEventQueue;
				if(evts && evts.length && typeof cw._nwjsWsOnEvent === "function") {
					while(evts.length) {
						var ev = evts.shift();
						try { cw._nwjsWsOnEvent(ev.id, ev.type, ev.data); } catch(_e) {}
					}
				}
			} catch(_e) {}
		}, 50);
		self.window_nwjs.once("close", function() {
			clearInterval(_wsTimer);
			Object.keys(_wsPool).forEach(function(id) { try { _wsPool[id].terminate(); } catch(_e) {} });
			_wsPool = {};
		});
		// Iframe interface: push commands to the queue; the setInterval handles them.
		self.iframe.contentWindow._nwjsWsCreate = function(url, headers) {
			var id = ++_wsIdSeq;
			self.iframe.contentWindow._nwjsWsCmdQueue.push({op: "create", id: id, url: url, headers: headers || {}});
			return id;
		};
		self.iframe.contentWindow._nwjsWsSend = function(id, data) {
			self.iframe.contentWindow._nwjsWsCmdQueue.push({op: "send", id: id, data: data});
		};
		self.iframe.contentWindow._nwjsWsTerminate = function(id) {
			self.iframe.contentWindow._nwjsWsCmdQueue.push({op: "terminate", id: id});
		};
		// Notify transport.js that the WebSocket bridge is ready.
		if(typeof self.iframe.contentWindow._nwjsWsBridgeReady === "function") {
			self.iframe.contentWindow._nwjsWsBridgeReady();
		}
		// ── LAN bridge ──
		// The iframe (nwdisable) can't listen on a socket or run Node crypto, so the
		// parent runs the LAN node (lan-node.js) on its behalf. The iframe pushes
		// commands (init/addpeer/broadcast/close) to a queue and receives events
		// (ready/message/peers); all socket + crypto work happens inside the parent's
		// setInterval tick, never the iframe's call stack (which nwdisable suppresses).
		var _lanNode = null;
		self.iframe.contentWindow._nwjsLanCmdQueue   = [];
		self.iframe.contentWindow._nwjsLanEventQueue = [];
		var _lanTimer = setInterval(function() {
			try {
				var cw = self.iframe.contentWindow;
				if(!cw) return;
				var cmds = cw._nwjsLanCmdQueue;
				while(cmds && cmds.length) {
					var cmd = cmds.shift();
					if(cmd.op === "init") {
						if(_lanNode) { try { _lanNode.close(); } catch(_e) {} _lanNode = null; }
						try {
							_lanNode = require("../js/utils/lan-node.js").createLanNode({
								deviceId: cmd.deviceId,
								roomKey:  cmd.roomKeyHex ? Buffer.from(cmd.roomKeyHex, "hex") : null,
								onReady:     function(pub, eps) { if(cw._nwjsLanEventQueue) cw._nwjsLanEventQueue.push({type: "ready",   pub: pub, eps: eps}); },
								onMessage:   function(peerId, json) { if(cw._nwjsLanEventQueue) cw._nwjsLanEventQueue.push({type: "message", peerId: peerId, json: json}); },
								onPeerCount: function(n)        { if(cw._nwjsLanEventQueue) cw._nwjsLanEventQueue.push({type: "peers",   n: n}); }
							});
						} catch(e) { console.error("[lan-bridge] init failed:", e && e.message); }
					} else if(cmd.op === "addpeer") {
						if(_lanNode) { _lanNode.addPeer(cmd.deviceId, cmd.pubKeyB64, cmd.endpoints); }
					} else if(cmd.op === "broadcast") {
						if(_lanNode) { _lanNode.broadcast(cmd.json); }
					} else if(cmd.op === "close") {
						if(_lanNode) { try { _lanNode.close(); } catch(_e) {} _lanNode = null; }
					}
				}
				var evts = cw._nwjsLanEventQueue;
				while(evts && evts.length) {
					var ev = evts.shift();
					try {
						if(ev.type === "ready"   && typeof cw._nwjsLanOnReady   === "function") { cw._nwjsLanOnReady(ev.pub, ev.eps); }
						else if(ev.type === "message" && typeof cw._nwjsLanOnMessage === "function") { cw._nwjsLanOnMessage(ev.peerId, ev.json); }
						else if(ev.type === "peers"   && typeof cw._nwjsLanOnPeers   === "function") { cw._nwjsLanOnPeers(ev.n); }
					} catch(_e) {}
				}
			} catch(_e) {}
		}, 50);
		self.window_nwjs.once("close", function() {
			clearInterval(_lanTimer);
			if(_lanNode) { try { _lanNode.close(); } catch(_e) {} _lanNode = null; }
		});
		self.iframe.contentWindow._nwjsLanInit = function(roomKeyHex, did) {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({op: "init", roomKeyHex: roomKeyHex, deviceId: did});
		};
		self.iframe.contentWindow._nwjsLanAddPeer = function(did, pubKeyB64, endpoints) {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({op: "addpeer", deviceId: did, pubKeyB64: pubKeyB64, endpoints: endpoints});
		};
		self.iframe.contentWindow._nwjsLanBroadcast = function(json) {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({op: "broadcast", json: json});
		};
		self.iframe.contentWindow._nwjsLanClose = function() {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({op: "close"});
		};
		// Notify transport.js that the LAN bridge is ready.
		if(typeof self.iframe.contentWindow._nwjsLanBridgeReady === "function") {
			self.iframe.contentWindow._nwjsLanBridgeReady();
		}
	} catch(_bridgeErr) {
		console.error("[TiddlyDesktop] Bridge injection failed:", _bridgeErr);
	}
	// Run any registered plugin hooks (e.g. collab transport shim)
	($tw.desktop.pluginHooks || []).forEach(function(hook) {
		try { hook(self); } catch(e) { console.error("[TiddlyDesktop] Plugin hook error:",e); }
	});
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
	var faviconLink = this.iframe.contentDocument.getElementById("faviconLink"),
		href = faviconLink && faviconLink.getAttribute("href");
	// Only a real data: URI is a favicon. A wiki with no $:/favicon.ico leaves the link at
	// its static "favicon.ico" placeholder; writing that as the favicon config left a
	// broken thumbnail in the wiki list instead of the missing-favicon placeholder. Clear
	// it so the list falls back to the placeholder, like folder wikis already do.
	if(href && href.indexOf("data:") === 0) {
		// data URIs look like "data:<type>;base64,<text>"
		var posColon = href.indexOf(":"),
			posSemiColon = href.indexOf(";"),
			posComma = href.indexOf(",");
		this.wikiFavIconType = href.substring(posColon+1,posSemiColon);
		this.wikiFavIconText = href.substring(posComma+1);
		this.onFavIconChange();
	} else {
		this.clearFavIcon();
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
