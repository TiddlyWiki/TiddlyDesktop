/*
Class for backstage windows
*/

(function(){

/*jslint browser: true */
"use strict";

var windowBase = require("../js/window-base.js");

// Constructor
function BackstageWindow(options) {
	var self = this;
	options = options || {};
	// Save the options
	this.windowList = options.windowList;
	this.info = options.info || {};
	this.tiddler = this.info.tiddler;
	this.mustQuitOnClose = options.mustQuitOnClose;
	// Open the window
	$tw.desktop.gui.Window.open("html/backstage-tiddler-window.html",{
		id: this.getIdentifier(),
		show: true,
		icon: "images/app_icon.png"
	},function(win) {
		self.window_nwjs = win;
		self.window_nwjs.once("loaded",self.onloaded.bind(self));
		self.window_nwjs.on("close",self.onclose.bind(self));
	});
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
	return "backstage://" + this.tiddler;
};

// Load handler for window
BackstageWindow.prototype.onloaded = function(event) {
	// Make $tw available in the window
	this.window_nwjs.window.$tw = $tw;
	// Show dev tools
	// this.window_nwjs.showDevTools();
	// Trap links
	$tw.desktop.utils.links.trapLinks(this.window_nwjs.window.document);
	// Handle popups
	$tw.utils.addEventListeners(this.window_nwjs.window.document,[{
		name: "click",
		handlerObject: $tw.popup,
		handlerMethod: "handleEvent"
	}]);
	// Show dev tools on F12
	$tw.desktop.utils.devtools.trapDevTools(this.window_nwjs,this.window_nwjs.window.document);
	// Add menu
	$tw.desktop.utils.menu.createMenuBar(this.window_nwjs);
	// Show the window
	this.window_nwjs.show();
	this.window_nwjs.focus();
	// Render the window content
	this.renderWindow();
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
	// Remove our wiki change event handler
	$tw.wiki.removeEventListener("change",this.boundChangeHandler);
	// Close the window, remove it from the window list
	this.windowList.handleClose(this);
};

// Reopen this window
BackstageWindow.prototype.reopen = function() {
	this.window_nwjs.focus();
};

exports.BackstageWindow = BackstageWindow;

})();
