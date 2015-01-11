/*\
title: $:/TiddlyDesktop/startup/handlers.js
type: application/javascript
module-type: startup

Event handlers for the root widget

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

// Export name and synchronous status
exports.name = "tiddlydesktop-handlers";
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	var fs = require("fs"),
		path = require("path");
	$tw.rootWidget.addEventListener("tiddlydesktop-open-config-window",function(event) {
		if(typeof event.paramObject === "object") {
			$tw.desktop.tiddlerWindows.open(event.paramObject);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-open-backstage-wiki",function(event) {
		$tw.desktop.backstageWindow.show();
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-add-wiki-url",function(event) {
		$tw.desktop.tiddlerWindows.openHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-add-wiki-path",function(event) {
		for(var t=0; t<event.files.length; t++) {
			var file = event.files[t];
			$tw.desktop.tiddlerWindows.openHostWindowByPath(file.path);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-remove-wiki-url",function(event) {
		$tw.desktop.tiddlerWindows.removeHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-reveal-backups-wiki-url",function(event) {
		var backupPath = $tw.desktop.backupPathByPath(convertFileUrlToPath(event.param));
		if(!fs.existsSync(backupPath)) {
			$tw.utils.createDirectory(backupPath);
		}
		$tw.desktop.gui.Shell.openItem(backupPath);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-navigate-back-wiki-url",function(event) {
		$tw.desktop.tiddlerWindows.navigateBackForHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-navigate-forward-wiki-url",function(event) {
		$tw.desktop.tiddlerWindows.navigateForwardForHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-show-devtools-wiki-url",function(event) {
		$tw.desktop.tiddlerWindows.showDevToolsForHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-open-config-folder",function(event) {
		$tw.desktop.gui.Shell.openItem($tw.desktop.gui.App.dataPath);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-reveal-path-in-shell",function(event) {
		if(event.param) {
			$tw.desktop.gui.Shell.showItemInFolder(event.param);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-reveal-url-in-shell",function(event) {
		if(event.param) {
			$tw.desktop.gui.Shell.showItemInFolder(convertFileUrlToPath(event.param));
		}
		return false;
	});
};

function convertFileUrlToPath(pathname) {
	var fileUriPrefix = "file://";
	if(pathname.substr(0,fileUriPrefix.length) === fileUriPrefix) {
		pathname = pathname.substr(fileUriPrefix.length);
	}
	return pathname;
}

})();
