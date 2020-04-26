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
	$tw.rootWidget.addEventListener("tiddlydesktop-open-backstage-wiki",function(event) {
		$tw.desktop.backstageWindow.show();
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-add-wiki-url",function(event) {
		$tw.desktop.windowList.openByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-add-wiki-path",function(event) {
		for(var t=0; t<event.files.length; t++) {
			var file = event.files[t];
			$tw.desktop.windowList.openByPathname(file.path);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-remove-wiki-url",function(event) {
		$tw.desktop.windowList.removeByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-reveal-backups-wiki-url",function(event) {
		$tw.desktop.windowList.revealBackupsByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-open-config-folder",function(event) {
		$tw.desktop.gui.Shell.openItem($tw.desktop.gui.App.dataPath);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-reveal-url-in-shell",function(event) {
		$tw.desktop.windowList.revealByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-clone-wiki",function(event) {
		var source = event.param,
			dest = event.files && event.files[0].path;
		if(source && dest) {
			$tw.desktop.windowList.cloneToPath(source,dest);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-flags",function(event) {
		$tw.desktop.gui.Window.open("chrome://flags",{
			id: "chrome://flags"
		});
		return false;
	});
};
})();
