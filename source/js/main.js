(function(){

/*jslint browser: true */
"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

// Use the main window as the backstage window
var backstageWindow = gui.Window.get();
// backstageWindow.showDevTools();

var tiddlerWindows = require("../js/tiddler-windows.js"),
	wikiFolderWindows = require("../js/wiki-folder-windows.js"),
	devTools = require("../js/dev-tools.js");

// Hide the backstage window when we start, and when it is closed
backstageWindow.on("close",function(isQuitting) {
	if(!isQuitting) {
		backstageWindow.hide();
	}
});

function showBackstageWindow() {
	backstageWindow.show();
}

var menuBar = new gui.Menu({type:"menubar"});
if(process.platform === "darwin") {
	menuBar.createMacBuiltin("TiddlyDesktop");
}
backstageWindow.menu = menuBar;

// Show dev tools on F12
devTools.trapDevTools(backstageWindow,document);

// Create a user configuration wiki folder if it doesn't exist
var wikiFolder = path.resolve(gui.App.dataPath,"user-config-tiddlywiki"),
	packageFilename = path.resolve(wikiFolder,"tiddlywiki.info"),
	packageJson;
if(fs.existsSync(wikiFolder) && fs.existsSync(packageFilename)) {
	packageJson = JSON.parse(fs.readFileSync(packageFilename,"utf8") || {});
	packageJson.plugins = packageJson.plugins || [];
	if(packageJson.plugins.indexOf("tiddlywiki/tiddlydesktop") === -1) {
		packageJson.plugins.push("tiddlywiki/tiddlydesktop");
	}
	packageJson.includeWikis = [];
} else {
	packageJson = {
		"description": "TiddlyDesktop backstage user configuration wiki",
		"plugins": [
			"tiddlywiki/filesystem",
			"tiddlywiki/tiddlydesktop"
		],
		"themes": [
			"tiddlywiki/vanilla",
			"tiddlywiki/snowwhite"
		]
	};
}
if(!fs.existsSync(wikiFolder)) {
	fs.mkdirSync(wikiFolder);
}
fs.writeFileSync(packageFilename,JSON.stringify(packageJson,null,4));

// Set up the $tw global
var $tw = {desktop: {
	tiddlerWindows: tiddlerWindows,
	wikiFolderWindows: wikiFolderWindows,
	backstageWindow: {
		show: showBackstageWindow
	},
	savingSupport: require("../js/saving-support.js"),
	trapLinks: trapLinks,
	backupPathByPath: backupPathByPath,
	gui: gui,
	utils: require("../js/utils.js")
}};

global.$tw = $tw;
window.$tw = $tw;

$tw.desktop.openWiki = function(url) {
	var filepath = $tw.desktop.utils.convertFileUrlToPath(url);
	if(fs.existsSync(filepath) && fs.statSync(filepath).isDirectory()) {
		$tw.desktop.wikiFolderWindows.openWikiFolderWindowByPath(filepath);
	} else {
		$tw.desktop.tiddlerWindows.openHostWindowByUrl(url);
	}
}

$tw.desktop.openWikiByPath = function(filepath) {
	if(fs.existsSync(filepath) && fs.statSync(filepath).isDirectory()) {
		$tw.desktop.wikiFolderWindows.openWikiFolderWindowByPath(filepath);
	} else {
		$tw.desktop.tiddlerWindows.openHostWindowByUrl(url);
	}
}

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [wikiFolder];

// Main part of boot process
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);

// Open the wiki list window
var wikilistWindow = tiddlerWindows.open({
	tiddler: "WikiListWindow"
});

// Helper to get the backup folder for a given filepath
function backupPathByPath(pathname) {
	var backupPath = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/BackupPath","");

	// Replace $filename$ with the filename portion of the filepath and $filepath$ with the entire filepath 
	backupPath = backupPath.replace(/\$filename\$/mgi,path.basename(pathname))
		.replace(/\$filepath\$/mgi,pathname);
	backupPath = path.resolve(path.dirname(pathname),backupPath)
	return backupPath;
}

// Helper to trap wikilinks within a window
function trapLinks(doc) {
	doc.addEventListener("click",function(event) {
		// See if we're in an interwiki link
		var interwikiLink = $tw.desktop.utils.findParentWithClass(event.target,"tc-interwiki-link") || $tw.desktop.utils.findParentWithClass(event.target,"tw-interwiki-link");
		if(interwikiLink) {
			$tw.desktop.tiddlerWindows.openHostWindowByUrl(interwikiLink.href);
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		// See if we're in an external link
		// "tw-tiddlylink-external" is for TW5, "externallink" for TWC
		var externalLink = $tw.desktop.utils.findParentWithClass(event.target,"tc-tiddlylink-external tw-tiddlylink-external externalLink");
		if(externalLink) {
			gui.Shell.openExternal(externalLink.href);
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		return true;
	},false);
}

})();
