/*
Main script, executed via main.html
*/

"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

var WindowList = require("../js/window-list.js").WindowList;

// Use the main window as the backstage window
var backstageWindow = gui.Window.get();

function showBackstageWindow() {
	backstageWindow.show();
	$tw.desktop.utils.menu.createMenuBar(backstageWindow);
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
	click: function() {
		gui.App.quit();
		// gui.App.closeAllWindows();
	}
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
	pluginHooks: [],
	gui: gui,
	utils: {
		devtools: require("../js/utils/devtools.js"),
		dom: require("../js/utils/dom.js"),
		dragdrop: require("../js/utils/dragdrop.js"),
		file: require("../js/utils/file.js"),
		findbar: require("../js/utils/findbar.js"),
		links: require("../js/utils/links.js"),
		menu: require("../js/utils/menu.js"),
		nwjs: require("../js/utils/nwjs.js"),
		saving: require("../js/utils/saving.js"),
		wiki: require("../js/utils/wiki.js"),
		ws: require("ws"),
		https: require("https"),
		http: require("http")
	}
}};

global.$tw = $tw;
window.$tw = $tw;

var backstageWikiFolder = $tw.desktop.utils.wiki.getBackstageWikiFolder(gui.App.dataPath);

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(backstageWindow,document);

// Fullscreen on F11 (and the fullscreen button, should the UI gain one) for this window
try {
	require("./utils/fullscreen.js").install(backstageWindow,document,function() { return $tw.rootWidget; });
} catch(e) {
	console.error("[TiddlyDesktop] fullscreen install failed:",e);
}

// First part of boot process
var _sjcl = require("../tiddlywiki/boot/sjcl.js");
global.sjcl = _sjcl;
window.sjcl = _sjcl;

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

// Command handlers

var defaultCommand = "open",
	commandFlags = {},
	commands = {
		"open": function(args) {
			args.forEach(function(p) {
				$tw.desktop.windowList.openByPathname(p);
				commandFlags.haveOpenedWindow = true;
			});
		},
		"debug": function(args) {
			backstageWindow.showDevTools();
		}
	};

// Main boot process

// If no wiki path was passed on the command line, eagerly open the wiki list
// window now (with its lightweight loading splash) so the user sees a window
// immediately. The heavy TiddlyWiki boot below paints the real content into
// the already-open window via BackstageWindow.tryRender().
var initialArgv = gui.App.argv.slice(0),
	hasNonFlagArg = initialArgv.some(function(a) { return !a.startsWith("--"); });
if(!hasNonFlagArg) {
	$tw.desktop.windowList.openByUrl("backstage://WikiListWindow",{mustQuitOnClose: true});
	commandFlags.haveOpenedWindow = true;
}

// Defer boot to the next tick so the splash window's renderer can paint
// before the main process gets blocked by the synchronous TiddlyWiki boot.
setTimeout(function() {
	$tw.boot.suppressBoot = true;
	require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);
	$tw.boot.boot(function() {
		// Process command line
		var tokens = initialArgv,
			command, commandFn,
			args;
		while(tokens.length > 0) {
			if(tokens[0].startsWith("--")) {
				command = tokens.shift().slice(2);
			} else {
				command = defaultCommand;
			}
			args = [];
			while(tokens.length > 0 && !tokens[0].startsWith("--")) {
				args.push(tokens.shift());
			}
			commandFn = commands[command];
			if(!commandFn) {
				console.error("Unknown command: --" + command);
			} else {
				commandFn(args);
			}
		}
		// Register for file open events
		// Commented out as an attempt to fix https://github.com/TiddlyWiki/TiddlyDesktop/issues/214
		// gui.App.on("open",function(cmdline) {
		// 	$tw.desktop.windowList.openByPathname(p);
		// });
		// Fallback: if nothing has been opened (e.g. only flag args), open the wiki list now
		if(!commandFlags.haveOpenedWindow) {
			$tw.desktop.windowList.openByUrl("backstage://WikiListWindow",{mustQuitOnClose: true});
		}
		// Render any windows that were opened before boot completed
		$tw.desktop.bootComplete = true;
		$tw.desktop.windowList.windows.forEach(function(w) {
			if(typeof w.tryRender === "function") {
				w.tryRender();
			}
		});
	});
},0);
