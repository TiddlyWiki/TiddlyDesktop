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

var path = require("path");

// Export name and synchronous status
exports.name = "tiddlydesktop-handlers";
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	$tw.rootWidget.addEventListener("tiddlydesktop-open-config-window",function(event) {
		if(typeof event.paramObject === "object") {
			$tw.desktop.configWindow.open(event.paramObject);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-add-wiki-url",function(event) {
		$tw.desktop.configWindow.openHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-add-wiki-path",function(event) {
		for(var t=0; t<event.param.length; t++) {
			var file = event.param[t];
			$tw.desktop.configWindow.openHostWindowByPath(file.path);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-remove-wiki-url",function(event) {
		$tw.desktop.configWindow.removeHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-open-path-in-shell",function(event) {
		var itemPath;
		switch(event.param) {
			case "USER_CONFIG_FOLDER":
				itemPath = $tw.desktop.gui.App.dataPath;
				break;
			default:
				itemPath = event.param;
				break;
		}
		if(itemPath) {
			$tw.desktop.gui.Shell.openItem(itemPath);
		}
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
		pathname = pathname.substr(fileUriPrefix.length).replace(/\//g,path.sep).replace(/^\\/,"");
	}
	return pathname;
}

})();
