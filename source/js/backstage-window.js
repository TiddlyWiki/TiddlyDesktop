/*
Class for backstage windows
*/

"use strict";

var windowBase = require("../js/window-base.js"),
	hash = require("../js/utils/hash.js");

// Constructor
function BackstageWindow(options) {
	var self = this;
	options = options || {};
	// Save the options
	this.windowList = options.windowList;
	this.info = options.info || {};
	this.tiddler = this.info.tiddler;
	this.mustQuitOnClose = options.mustQuitOnClose;
	this.windowLoaded = false;
	this.rendered = false;
	// Open the window. Persist and restore position/size + maximized state like the
	// wiki windows do (the wiki list is itself a backstage window).
	$tw.desktop.gui.Window.open("html/backstage-tiddler-window.html",this.applyGeometryToOpenOptions({
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

// True when $tw has finished booting and we can render TiddlyWiki content
function isBootComplete() {
	return !!($tw && $tw.wiki && $tw.utils && $tw.popup && $tw.rootWidget && $tw.fakeDocument);
}

// Static method for getting the identifier for the specified info
BackstageWindow.getIdentifierFromInfo = function(info) {
	return "backstage://" + info.tiddler;
};

windowBase.addBaseMethods(BackstageWindow.prototype);

// Returns true if the provided parameters are the same as the ones used to create this window
BackstageWindow.prototype.matchInfo = function(info) {
	return info.tiddler === this.tiddler;
};

// The identifier for wiki file windows is the prefix `backstage://` plus the title of the tiddler
BackstageWindow.prototype.getIdentifier = function() {
	return BackstageWindow.getIdentifierFromInfo({tiddler: this.tiddler});
};

// Load handler for window — the splash is visible at this point.
// Defers the TiddlyWiki-dependent setup until boot has completed.
BackstageWindow.prototype.onloaded = function(event) {
	this.windowLoaded = true;
	// Always make $tw visible in the new window (the reference is stable
	// across boot; boot mutates the same object)
	this.window_nwjs.window.$tw = $tw;
	this.window_nwjs.show();
	this.window_nwjs.focus();
	this.tryRender();
};

// Render the page content once both the window has loaded AND $tw has booted.
// Idempotent — safe to call from onloaded or from main.js after boot.
BackstageWindow.prototype.tryRender = function() {
	if(this.rendered) { return; }
	if(!this.windowLoaded) { return; }
	if(!isBootComplete()) { return; }
	this.rendered = true;
	// TiddlyWiki-dependent setup that used to live in onloaded
	$tw.desktop.utils.links.trapLinks(this.window_nwjs.window.document);
	$tw.utils.addEventListeners(this.window_nwjs.window.document,[{
		name: "click",
		handlerObject: $tw.popup,
		handlerMethod: "handleEvent"
	}]);
	$tw.desktop.utils.devtools.trapDevTools(this.window_nwjs,this.window_nwjs.window.document);
	$tw.desktop.utils.menu.createMenuBar(this.window_nwjs);
	// Render the page content
	this.renderWindow();
	// Safe external media embeds (YouTube etc.): route allowlisted media through the local
	// loopback shim so videos play in backstage windows (the wiki list, Settings, and Help)
	// just like they do in single-file and folder wikis. Backstage windows render TW content
	// directly into this Node-enabled document, so this matches the folder-wiki install.
	try {
		require("../js/utils/embeds.js").install(this.window_nwjs.window.document,this.window_nwjs.window);
	} catch(e) {
		console.error("[TiddlyDesktop] embeds install failed:",e);
	}
	// Remove the loading splash now that real content is rendered
	var splash = this.window_nwjs.window.document.getElementById("td-loading-splash");
	if(splash && splash.parentNode) {
		splash.parentNode.removeChild(splash);
	}
};

BackstageWindow.prototype.renderWindow = function() {
	var self = this,
		doc = this.window_nwjs.window.document;
	// Set up the title
	this.titleWidgetNode = $tw.wiki.makeTranscludeWidget(this.tiddler,{field: "page-title", document: $tw.fakeDocument, parseAsInline: true, variables: {}});
	this.titleContainer = $tw.fakeDocument.createElement("div");
	this.titleWidgetNode.render(this.titleContainer,null);
	doc.title = this.titleContainer.textContent;
	// Set up the styles
	this.styleWidgetNode = $tw.wiki.makeTranscludeWidget("$:/core/ui/PageStylesheet",{document: $tw.fakeDocument, variables: {}});
	this.styleContainer = $tw.fakeDocument.createElement("style");
	this.styleWidgetNode.render(this.styleContainer,null);
	this.styleElement = doc.createElement("style");
	this.styleElement.innerHTML = this.styleContainer.textContent;
	doc.head.insertBefore(this.styleElement,doc.head.firstChild);
	// Render the tiddler
	this.widgetNode = $tw.wiki.makeTranscludeWidget(this.tiddler,{document: doc, parentWidget: $tw.rootWidget, variables: {}});
	this.pageContainer = doc.createElement("div");
	$tw.utils.addClass(this.pageContainer,"tc-page-container-wrapper");
	doc.body.insertBefore(this.pageContainer,doc.body.firstChild);
	this.widgetNode.render(this.pageContainer,null);
	// Add the change event handler
	this.boundChangeHandler = this.changeHandler.bind(this);
	$tw.wiki.addEventListener("change",this.boundChangeHandler);
};

BackstageWindow.prototype.changeHandler = function (changes) {
	var doc = this.window_nwjs.window.document;
	// Title changes
	if(this.titleWidgetNode.refresh(changes,this.titleContainer,null)) {
		doc.title = this.titleContainer.textContent;
	}
	// Style changes
	if(this.styleWidgetNode.refresh(changes,this.styleContainer,null)) {
		this.styleElement.innerHTML = this.styleContainer.textContent;
	}
	// Body changes
	this.widgetNode.refresh(changes,this.pageContainer,null);
};

// Close handler for window
BackstageWindow.prototype.onclose = function(event) {
	// Remove our wiki change event handler (may not exist if the window was
	// closed before TiddlyWiki finished booting and rendering)
	if($tw && $tw.wiki && this.boundChangeHandler) {
		$tw.wiki.removeEventListener("change",this.boundChangeHandler);
	}
	// Close the window, remove it from the window list
	this.windowList.handleClose(this);
};

// Reopen this window
BackstageWindow.prototype.reopen = function() {
	this.window_nwjs.focus();
};

exports.BackstageWindow = BackstageWindow;
