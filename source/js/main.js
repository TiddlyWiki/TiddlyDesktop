/*
Main script, executed via main.html
*/

(function(){

/*jslint browser: true */
"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

var WindowList = require("../js/window-list.js").WindowList;

// Use the main window as the backstage window
var backstageWindow = gui.Window.get();
// backstageWindow.showDevTools();

function showBackstageWindow() {
	backstageWindow.show();
}

backstageWindow.on("close",function(event) {
	backstageWindow.hide();
});

// Create the tray icon
var tray = new gui.Tray({
	title: "",
	icon: "images/tray_icon_" + (process.platform === "darwin" ? "mono" : "color") + (window.devicePixelRatio > 1 ? "@2x" : "") + ".png",
	alticon: "",
	tooltip: "TiddlyDesktop",
	iconsAreTemplates: true
});

// Give it a menu
var trayMenu = new gui.Menu();
trayMenu.append(new gui.MenuItem({
	label: "TiddlyDesktop v" + require("../package.json").version,
	enabled: false
}));
trayMenu.append(new gui.MenuItem({
	label: "Wiki List",
	click: function() {
		$tw.desktop.windowList.openByUrl("backstage://WikiListWindow");
	}
}));
trayMenu.append(new gui.MenuItem({
	label: "Settings",
	click: function() {
		$tw.desktop.windowList.openByUrl("backstage://$:/TiddlyDesktop/Settings");
	}
}));
trayMenu.append(new gui.MenuItem({
	label: "",
	type: "separator"
}));
trayMenu.append(new gui.MenuItem({
	label: "Help",
	click: function() {
		$tw.desktop.windowList.openByUrl("backstage://$:/TiddlyDesktop/Help");
	}
}));
trayMenu.append(new gui.MenuItem({
	label: "",
	type: "separator"
}));
trayMenu.append(new gui.MenuItem({
	label: "Quit",
	// Undocumented nw.js feature for invoking system actions:
    selector: "closeAllWindowsQuit:"
}));
tray.menu = trayMenu;

// Set up the $tw global
var $tw = {desktop: {
	windowList: new WindowList({
		backstageWindow_nwjs: gui.Window.get()
	}),
	backstageWindow: {
		show: showBackstageWindow
	},
	gui: gui,
	utils: {
		devtools: require("../js/utils/devtools.js"),
		dom: require("../js/utils/dom.js"),
		file: require("../js/utils/file.js"),
		links: require("../js/utils/links.js"),
		menu: require("../js/utils/menu.js"),
		nwjs: require("../js/utils/nwjs.js"),
		saving: require("../js/utils/saving.js"),
		wiki: require("../js/utils/wiki.js")
	}
}};

global.$tw = $tw;
window.$tw = $tw;

var backstageWikiFolder = $tw.desktop.utils.wiki.getBackstageWikiFolder(gui.App.dataPath);

$tw.desktop.utils.menu.createMenuBar(backstageWindow);

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(backstageWindow,document);

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [backstageWikiFolder];

// Override process.nextTick() because it is broken under nw.js in mixed mode
var old_process_nextTick = process.nextTick;
process.nextTick = function() {
	var fn = arguments[0],
		args = Array.prototype.slice.call(arguments,1);
	window.setTimeout(function() {
		fn.apply(null,args);
	},4);
};

// Main part of boot process

var wikilistWindow;

$tw.boot.suppressBoot = true;
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);
$tw.boot.boot(function() {
  var dest;
  if (gui.App.argv.length !== 0){
    if($tw.utils.isDirectory(gui.App.argv[0])){
      dest = "wikifolder://" + gui.App.argv[0];
    } else {
      dest = "wikifile://" + gui.App.argv[0];
    }
  } else {
    dest = "backstage://WikiListWindow";
  }
  wikilistWindow = $tw.desktop.windowList.openByUrl(dest,{mustQuitOnClose: true});
});

})();
