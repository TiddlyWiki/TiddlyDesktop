(function(){

/*jslint browser: true */
"use strict";

/*
A hashmap of WikiFolderWindow objects for open windows. The key is the pathname of the wiki folder
*/
var wikiFolderWindows = {};

function WikiFolderWindow(pathname) {
	this.pathname = pathname;
	this.window = $tw.desktop.gui.Window.open("app://foobar/html/wiki-folder-window.html?pathname=" + encodeURIComponent(pathname),{
		toolbar: false,
		show: true,
		"new-instance": true,
		nodejs: true,
		icon: "images/app_icon.png"
	});
}

function openWikiFolderWindowByPath(pathname) {
	// Create/update config tiddler for this window
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),$tw.wiki.getTiddler(pathname),$tw.wiki.getModificationFields(),{title: pathname, tags: ["wikilist","wikifolder"]}));
	// Check if the window already exists
	var wikiFolderWindow = wikiFolderWindows[pathname];
	if(wikiFolderWindow) {
		// If so, activate it and return it
		try {
			wikiFolderWindow.window.focus(); // Doesn't work; not clear why
		} catch(e) {
			console.log("WARNING: Focusing existing wiki folder window failed '" + pathname + "'");
		}
	} else {
		// Otherwise create the new window
		wikiFolderWindow = new WikiFolderWindow(pathname);
		wikiFolderWindows[pathname] = wikiFolderWindow;
	}
	return wikiFolderWindow;
}

exports.openWikiFolderWindowByPath = openWikiFolderWindowByPath;

})();
