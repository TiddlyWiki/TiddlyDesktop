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
	$tw.rootWidget.addEventListener("tiddlydesktop-open-wiki-url",function(event) {
		// Open the TiddlyWiki window
		$tw.desktop.configWindow.openHostWindowByUrl(event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-open-wiki-path",function(event) {
		for(var t=0; t<event.param.length; t++) {
			var file = event.param[t];
			$tw.desktop.configWindow.openHostWindowByPath(file.path);
		}
		return false;
	},false);
};

})();
