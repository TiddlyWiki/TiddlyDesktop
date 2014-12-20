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
	$tw.rootWidget.addEventListener("tiddlydesktop-open-wiki",function(event) {
		// Open the TiddlyWiki window
		openWindow(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-open-wiki-files",function(event) {
		for(var t=0; t<event.param.length; t++) {
			var file = event.param[t];
			openWindow(convertPathToFileUrl(file.path));
		}
		return false;
	},false);
};

function openWindow(url) {
	var tiddlywikiWindow = $tw.desktop.configWindow.open({
		tiddler: "HostWindow",
		variables: {
			"currentTiddler": url
		}
	});
}

function convertPathToFileUrl(path) {
	// File prefix depends on platform
	var fileUriPrefix = "file://";
	if(process.platform.substr(0,3) === "win") {
		fileUriPrefix = fileUriPrefix + "/";
	}
	return fileUriPrefix + path.replace(/\\/g,"/");
}

})();
