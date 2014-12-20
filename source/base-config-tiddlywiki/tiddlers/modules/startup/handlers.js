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
		var tiddlywikiWindow = $tw.desktop.configWindow.open({
			tiddler: "TiddlyWikiWindow",
			variables: {
				"wiki-url": event.param
			}
		});

	});
};

})();
