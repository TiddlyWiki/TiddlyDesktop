/*\
title: $:/TiddlyDesktop/startup/handlers.js
type: application/javascript
module-type: startup

Event handlers for the root widget

\*/
"use strict";

// Export name and synchronous status
exports.name = "tiddlydesktop-handlers";
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	var fs = require("fs"),
		path = require("path");
	// These rootWidget handlers run in the main/node process context, where the
	// global `window` is the invisible background page. Calling confirm()/alert()
	// on it blocks the main event loop on a dialog that is never shown, freezing
	// every window. Resolve the visible window that the click came from instead
	// (falling back to the wiki-list window), and dialog on that.
	function getDialogWindow(event) {
		try {
			var dv = event && event.event && event.event.target &&
				event.event.target.ownerDocument && event.event.target.ownerDocument.defaultView;
			if(dv && typeof dv.confirm === "function") { return dv; }
		} catch(e) {}
		var windows = ($tw.desktop.windowList && $tw.desktop.windowList.windows) || [];
		for(var i=0; i<windows.length; i++) {
			var w = windows[i];
			if(w.getIdentifier && w.getIdentifier() === "backstage://WikiListWindow" &&
				w.window_nwjs && w.window_nwjs.window) {
				return w.window_nwjs.window;
			}
		}
		return null;
	}
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
	$tw.rootWidget.addEventListener("tiddlydesktop-create-wiki-folder",function(event) {
		var dest = event.files && event.files[0] && event.files[0].path;
		if(dest) {
			$tw.desktop.windowList.createWikiFolderAtPath(dest);
		}
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-flags",function(event) {
		$tw.desktop.gui.Window.open("chrome://flags",{
			id: "chrome://flags"
		});
		return false;
	});
	$tw.rootWidget.addEventListener("tiddlydesktop-convert-wiki",function(event) {
		var sourceUrl = event.param;
		if(!sourceUrl) { return false; }
		// The destination path/name was chosen in the file/folder picker that sent
		// this message.
		var destPath = event.files && event.files[0] && event.files[0].path;
		console.log("[TiddlyDesktop] convert-wiki source=" + sourceUrl + " dest=" + destPath +
			" files=" + (event.files ? event.files.length : "none"));
		if(!destPath) {
			$tw.desktop.utils.wiki.alert("No destination was chosen for the conversion.");
			return false;
		}
		var decodedUrl = $tw.desktop.windowList.decodeUrl(sourceUrl);
		var sourcePath = decodedUrl.info.pathname;
		var isFolder   = decodedUrl.type === "folder";
		var actionLabel = isFolder ? "folder to file" : "file to folder";
		var msg = "Convert wiki " + actionLabel + "?\n\nFrom: " + sourcePath + "\nTo: " + destPath + "\n\nThe original wiki will not be deleted.";
		var dialogWindow = getDialogWindow(event);
		if(dialogWindow && !dialogWindow.confirm(msg)) { return false; }
		$tw.desktop.utils.wiki.alert("Converting wiki (" + actionLabel + ")…");
		$tw.desktop.windowList.convertWiki(sourceUrl, destPath, function(err) {
			if(err) {
				$tw.desktop.utils.wiki.alert("Conversion failed: " + err.message);
			} else {
				$tw.desktop.utils.wiki.alert("Wiki converted: " + destPath);
			}
		});
		return false;
	});
};
