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
	$tw.rootWidget.addEventListener("tiddlydesktop-clone-wiki-path",function(event) {
	    
	    /* Find the main window */
	    var window_url = $tw.desktop.windowList.decodeUrl("backstage://WikiListWindow")
	    var main_window = $tw.desktop.windowList.find(window_url.WindowConstructor, window_url.info) 
        
        /* Ask for the new file name */
        var src  = $tw.desktop.windowList.decodeUrl(event.param).info.pathname
        var dest = main_window.window_nwjs.window.prompt("What should be the path to the new file?");
        if(dest === null){ return false; } /* If the prompt returns null, the user cancelled the action, we should too. */
        
        fs.writeFileSync(dest,fs.readFileSync(src));
        
        $tw.desktop.windowList.openByUrl("file://"+dest);
        
        
	});
};

})();
