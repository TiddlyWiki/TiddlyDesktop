/*
Script for wiki folder windows
*/

(function(){

/*jslint browser: true */
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
		menu: require("../js/utils/menu.js")
	}
}};

global.$tw = $tw;
window.$tw = $tw;

// Use the main window as the container window
var containerWindow = gui.Window.get();
containerWindow.showDevTools();

// Hide the container window when we start, and when it is closed
containerWindow.on("close",function(isQuitting) {
	alert("Wiki folder windows cannot be manually closed. This window will close when the application is quit.\n\nThis temporary limitation will be removed as soon as possible");
});

containerWindow.menu = $tw.desktop.utils.menu.createMenuBar();

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(containerWindow,document);

// Get the query parameters that were used to open this container window

var queryObject = $tw.desktop.utils.dom.decodeQueryString(containerWindow.window.document.location);

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

var pathname = queryObject.pathname;

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [pathname];

// Main part of boot process
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);

})();
