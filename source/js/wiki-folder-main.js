/*
Script for wiki folder windows
*/

"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

// Set up the $tw global
var $tw = {desktop: {
	gui: gui,
	utils: {
		devtools: require("../js/utils/devtools.js"),
		dom: require("../js/utils/dom.js"),
		dragdrop: require("../js/utils/dragdrop.js"),
		menu: require("../js/utils/menu.js"),
		ws: require("ws"),
		https: require("https"),
		http: require("http")
	}
}};

global.$tw = $tw;
window.$tw = $tw;

// Use the main window as the container window
var containerWindow = gui.Window.get();
// containerWindow.showDevTools();

// Hide the container window when we start, and when it is closed
containerWindow.on("close",function(isQuitting) {
	containerWindow.close(true);
});

$tw.desktop.utils.menu.createMenuBar(containerWindow);

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(containerWindow,document);

// Get the query parameters that were used to open this container window

var queryObject = $tw.desktop.utils.dom.decodeQueryString(containerWindow.window.document.location);

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [queryObject.pathname];

if(queryObject.host && queryObject.port) {
	$tw.boot.argv.push("--listen","host="+queryObject.host,"port="+queryObject.port,"credentials="+queryObject.credentials,"readers="+queryObject.readers,"writers="+queryObject.writers);
}

console.log("Running tiddlywiki " + $tw.boot.argv.join(" "));

// Main part of boot process
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);

$tw.wiki.addTiddler({title: "$:/status/IsReadOnly",text: "no"});

// Intercept cross-browser drag-drop imports (same fix as wiki-file windows).
// In the folder window the wiki document IS this window, so contentWindow
// and the document are the window itself.
$tw.desktop.utils.dragdrop.installImportInterceptor(
	containerWindow.window.document,
	containerWindow.window,
	{parentWindow: containerWindow.window}
);

// Browser-style find-in-page (Ctrl/Cmd+F). The folder wiki document IS this
// window, so host and content are the same window. It defers to any focused
// editor that claims the shortcut (e.g. CodeMirror 6).
try {
	$tw.desktop.utils.findbar.installFindBar({
		hostWindow: containerWindow.window,
		hostDocument: containerWindow.window.document,
		getContentWindow: function() { return containerWindow.window; },
		getContentDocument: function() { return containerWindow.window.document; }
	});
} catch(e) {
	console.error("[TiddlyDesktop] find bar install failed:",e);
}

// Mirror this wiki's title and favicon to the file the backstage watches, so the
// wiki-list entry tracks $:/SiteTitle / $:/SiteSubtitle / $:/favicon.ico live. TiddlyWiki
// keeps document.title and the #faviconLink href in sync with those tiddlers; we observe
// both and write a small JSON payload (in place, so the backstage's fs.watch keeps its
// inode), debounced and de-duplicated so the burst of changes during boot doesn't thrash
// the file.
(function() {
	var stateFile = queryObject.stateFile,
		win = containerWindow.window,
		doc = win.document;
	if(!stateFile) { return; }
	var lastWritten = null,
		writeTimer = null;
	function currentState() {
		var title = doc.title || "",
			faviconType = "",
			faviconText = "",
			faviconLink = doc.getElementById("faviconLink"),
			href = faviconLink && faviconLink.getAttribute("href");
		// faviconLink href is a data URI: "data:<type>;base64,<text>"
		if(href && href.indexOf("data:") === 0) {
			var posColon = href.indexOf(":"),
				posSemiColon = href.indexOf(";"),
				posComma = href.indexOf(",");
			if(posSemiColon !== -1 && posComma !== -1) {
				faviconType = href.substring(posColon + 1,posSemiColon);
				faviconText = href.substring(posComma + 1);
			}
		}
		return {title: title, faviconType: faviconType, faviconText: faviconText};
	}
	function writeState() {
		var payload = JSON.stringify(currentState());
		if(payload === lastWritten) { return; }
		lastWritten = payload;
		try { fs.writeFileSync(stateFile,payload,"utf8"); } catch(e) {}
	}
	function schedule() {
		if(writeTimer) { clearTimeout(writeTimer); }
		writeTimer = setTimeout(writeState,50);
	}
	if(win.MutationObserver) {
		var titleNode = doc.getElementsByTagName("title")[0];
		if(titleNode) {
			new win.MutationObserver(schedule).observe(titleNode,{childList: true, characterData: true, subtree: true});
		}
		// The favicon <link> is created/updated by the core favicon startup; observe its
		// href so a changed $:/favicon.ico is reflected. It may not exist yet at this point,
		// so also watch <head> for it being added.
		var faviconLink = doc.getElementById("faviconLink");
		if(faviconLink) {
			new win.MutationObserver(schedule).observe(faviconLink,{attributes: true, attributeFilter: ["href"]});
		} else if(doc.head) {
			var headObserver = new win.MutationObserver(function() {
				var link = doc.getElementById("faviconLink");
				if(link) {
					headObserver.disconnect();
					new win.MutationObserver(schedule).observe(link,{attributes: true, attributeFilter: ["href"]});
					schedule();
				}
			});
			headObserver.observe(doc.head,{childList: true});
		}
	}
	schedule();
}());
