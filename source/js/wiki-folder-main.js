(function(){

/*jslint browser: true */
"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

// Use the main window as the container window
var containerWindow = gui.Window.get();
containerWindow.showDevTools();

var devTools = require("../js/dev-tools.js");

// Hide the container window when we start, and when it is closed
containerWindow.on("close",function(isQuitting) {
	if(!isQuitting) {
		containerWindow.close(true);
	}
});

var menuBar = new gui.Menu({type:"menubar"});
if(process.platform === "darwin") {
	menuBar.createMacBuiltin("TiddlyDesktop");
}
containerWindow.menu = menuBar;

// Show dev tools on F12
devTools.trapDevTools(containerWindow,document);

// Set up the $tw global
var $tw = {desktop: {
	gui: gui
}};

global.$tw = $tw;
window.$tw = $tw;

// Get the query parameters that were used to open this container window

var queryObject = decodeQueryString(containerWindow.window.document.location);

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

var pathname = queryObject.pathname;

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [pathname];

// Main part of boot process
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);

function decodeQueryString(location) {
	var result = {};
	location.search.substr(1).split('&').forEach(function(pair) {
		if(pair) {
			var parts = pair.split("=");
			result[parts[0]] = decodeURIComponent(parts[1].replace(/\+/g, " "));
		}
	});
	return result;
}

})();
