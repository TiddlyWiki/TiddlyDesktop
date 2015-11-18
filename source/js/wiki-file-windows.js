(function(){

/*jslint browser: true */
"use strict";

/*
A hashmap of WikiFileWindow objects for open windows. The key is the pathname of the wiki folder
*/
var wikiFileWindows = {};

function WikiFileWindow(url) {
	this.url = url;
	this.window = $tw.desktop.gui.Window.open("app://foobar/html/wiki-file-window.html?url=" + encodeURIComponent(url),{
		toolbar: false,
		show: true,
		nodejs: true,
		icon: "images/app_icon.png"
	});
}

function openWikiFileWindowByUrl(url) {
	// Create/update config tiddler for this window
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),$tw.wiki.getTiddler(url),$tw.wiki.getModificationFields(),{title: url, tags: ["wikilist","wikifile"]}));
	// Check if the window already exists
	var wikiFileWindow = wikiFileWindows[url];
	if(wikiFileWindow) {
		// If so, activate it and return it
		try {
			wikiFileWindow.window.focus(); // Doesn't work; not clear why
		} catch(e) {
			console.log("WARNING: Focusing existing wiki file window failed '" + url + "'");
		}
	} else {
		// Otherwise create the new window
		wikiFileWindow = new WikiFileWindow(url);
		wikiFileWindows[url] = wikiFileWindow;
	}
	return wikiFileWindow;
}

exports.openWikiFileWindowByUrl = openWikiFileWindowByUrl;

})();
