/*\
title: $:/TiddlyDesktop/startup/globals.js
type: application/javascript
module-type: startup

Set up globals:

* Copy version number from tiddler $:/TiddlyDesktop/version to variable $tw.desktop.version

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

// Export name and synchronous status
exports.name = "tiddlydesktop-globals";
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	$tw.desktop = $tw.desktop || {};
	$tw.desktop.version = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/version")
};

})();
