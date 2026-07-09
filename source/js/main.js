/*
Main script, executed via main.html
*/

"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

var WindowList = require("../js/window-list.js").WindowList;
var protocol = require("../js/utils/protocol.js");
var deeplink = require("../js/utils/deeplink.js");
var startupGuard = require("../js/utils/startup-guard.js");
var spellcheck = require("../js/utils/spellcheck.js");

// On a Chromium (NW.js) upgrade, clear Chromium's disposable GPU/shader caches and any stale
// Singleton lock BEFORE booting — a stale cache from the old Chromium is a classic blank/no-window
// cause. Cheap unless the version actually changed; never touches the wiki list or any TiddlyDesktop
// data, and is self-guarded so it can never block startup.
try { startupGuard.guardProfile(gui.App.dataPath); } catch(e) { console.error("[TiddlyDesktop] profile guard failed:",e); }

// Stale same-profile orphan cleanup (killStaleInstances) is deliberately NOT run synchronously here:
// reaching main.js means we are already the primary for this profile (a live instance would have
// absorbed this launch), so any orphans left by a crash or an older build are NOT blocking us —
// terminating them is pure recovery. Its process-enumeration query is slow on Windows, so it is
// deferred until after the window is up (see the boot-complete callback below) to keep startup fast.

// The real process.exit, captured before anything (e.g. wiki conversion) can monkey-patch it.
// quitApp() uses this so a quit during a conversion still terminates.
var _realProcessExit = (typeof process !== "undefined" && process.exit) ? process.exit.bind(process) : null;

// Use the main window as the backstage window
var backstageWindow = gui.Window.get();

function showBackstageWindow() {
	backstageWindow.show();
	$tw.desktop.utils.menu.createMenuBar(backstageWindow);
}

backstageWindow.on("close",function(event) {
	backstageWindow.hide();
});

// Fully quit TiddlyDesktop, guaranteeing no process is left behind. Force-closes every window,
// asks NW.js to quit, then — as an absolute backstop — terminates the main (browser) process.
// Killing the main process makes Chromium tear down all renderer processes with it (on Windows
// they're in the same Job Object), so even a Node handle (e.g. a listening socket, the embed
// shim, a collab socket) or a hung renderer that would otherwise keep something alive cannot
// leave a zombie behind. Idempotent.
var _quitting = false;
function quitApp() {
	if(_quitting) { return; }
	_quitting = true;
	try { if(tray) { tray.remove(); } } catch(e) {}
	// Force-close every tracked wiki window (close(true) skips close handlers / save prompts).
	try {
		var wl = $tw && $tw.desktop && $tw.desktop.windowList;
		if(wl && wl.windows) {
			wl.windows.slice().forEach(function(w) {
				try { if(w && w.window_nwjs) { w.window_nwjs.close(true); } } catch(e) {}
			});
		}
	} catch(e) {}
	try { backstageWindow.close(true); } catch(e) {}
	try { gui.App.closeAllWindows(); } catch(e) {}
	try { gui.App.quit(); } catch(e) {}
	// Backstop: if anything would otherwise keep the process alive, terminate it outright.
	setTimeout(function() { try { (_realProcessExit || process.exit)(0); } catch(e) {} }, 300);
}

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
		quitApp();
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

// Expose the full-quit so other parts (e.g. window-list, menu) can trigger a guaranteed quit,
// and make OS termination signals quit cleanly too rather than leaving the process around.
$tw.desktop.quitApp = quitApp;
try { process.on("SIGINT", quitApp); } catch(e) {}
try { process.on("SIGTERM", quitApp); } catch(e) {}

// Custom-protocol (tiddlydesktop://) handling: register this binary as the handler so the OAuth
// relay's post-login redirect returns to the app, and wire the running-instance "open" hook. We
// track the last-focused window so a deep link re-focuses the window the user came from.
try { protocol.register(); } catch(e) {}
try { deeplink.install(backstageWindow, gui); } catch(e) {}
try { backstageWindow.on("focus", function() { try { $tw.desktop.lastFocusedWindow = null; } catch(e) {} }); } catch(e) {}

var backstageWikiFolder = $tw.desktop.utils.wiki.getBackstageWikiFolder(gui.App.dataPath);

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(backstageWindow,document);

// Fullscreen on F11 (and the fullscreen button, should the UI gain one) for this window
try {
	require("../js/utils/fullscreen.js").install(backstageWindow,document,function() { return $tw.rootWidget; });
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
var initialArgv = gui.App.argv.slice(0);
// A tiddlydesktop:// deep link (OAuth return) launched cold lands in argv — pull it out so it
// isn't treated as a wiki path, and act on it once boot has finished (see below).
var _coldStartDeepLink = deeplink.findColdStartUrl(initialArgv);
if(_coldStartDeepLink) {
	initialArgv = initialArgv.filter(function(a) { return deeplink.extractUrl(a) !== _coldStartDeepLink; });
}
var hasNonFlagArg = initialArgv.some(function(a) { return !a.startsWith("--"); });
if(!hasNonFlagArg) {
	$tw.desktop.windowList.openByUrl("backstage://WikiListWindow",{mustQuitOnClose: true});
	commandFlags.haveOpenedWindow = true;
}

// Defer boot to the next tick so the splash window's renderer can paint
// before the main process gets blocked by the synchronous TiddlyWiki boot.
setTimeout(function() {
	$tw.boot.suppressBoot = true;
	require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);
	// Point ONLY the backstage boot at the backstage-specific language set: copies of the languages
	// with the wiki-list UI translations injected and bumped to plugin-priority 100, so the active
	// language wins in the backstage UI. The shared "../languages/" library stays clean, so the
	// PluginChooser and folder wikis get plain languages (no TiddlyDesktop strings, no priority
	// bump). deepDefaults during boot preserves this (it only fills missing keys); it is restored to
	// the clean default in the boot callback below, before the PluginChooser can enumerate anything.
	$tw.config = $tw.config || {};
	$tw.config.languagesPath = "../languages-backstage/";
	$tw.boot.boot(function() {
		$tw.config.languagesPath = "../languages/";
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
		// Local-spellcheck toggle: apply to the backstage window now, and re-apply to it plus every
		// open single-file wiki whenever the setting changes — no app restart. (Folder wikis run in
		// their own process and pick up the change on their next open/reload.)
		spellcheck.applyToDocument(document, spellcheck.isEnabled($tw));
		$tw.wiki.addEventListener("change", function(changes) {
			if(!changes[spellcheck.CONFIG_TITLE]) { return; }
			spellcheck.applyToDocument(document, spellcheck.isEnabled($tw));
			$tw.desktop.windowList.windows.forEach(function(w) {
				try { if(typeof w.applySpellcheck === "function") { w.applySpellcheck(); } } catch(e) {}
			});
		});
		// If launched cold by a tiddlydesktop:// deep link, act on it now that there's a window.
		if(_coldStartDeepLink) { try { deeplink.handleUrl(_coldStartDeepLink); } catch(e) {} }
		// Deferred recovery (see the note near the top of this file): now that the UI is up, clean up
		// any stale same-profile orphan process trees. Deferred so its slow Windows process query
		// never delays the window appearing.
		setTimeout(function() {
			try { startupGuard.killStaleInstances(gui.App.dataPath); } catch(e) { console.error("[TiddlyDesktop] stale-process cleanup failed:",e); }
		},0);
	});
},0);
