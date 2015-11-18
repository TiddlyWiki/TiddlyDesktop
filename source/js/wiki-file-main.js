(function(){

/*jslint browser: true */
"use strict";

window.$tw = global.$tw;

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

// Use the main window as the container window
var containerWindow = gui.Window.get();
containerWindow.showDevTools();

// Hide the container window when we start, and when it is closed
containerWindow.on("close",function(isQuitting) {
	if(!isQuitting) {
		containerWindow.close(true);
	}
});

var menuBar = new gui.Menu({type:"menubar"});
if(process.platform === "darwin") {
	menuBar.createMacBuiltin("TiddlyDesktop");
}
containerWindow.menu = menuBar;

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(containerWindow,document);

// Get the query parameters that were used to open this container window

var queryObject = $tw.desktop.utils.dom.decodeQueryString(containerWindow.window.document.location),
	url = queryObject.url;

var iframe = document.getElementById("tid-main-wiki-file-viewer");

iframe.src = url;

iframe.onload = function() {

	var pullUpIframeTitle = function() {
			containerWindow.window.document.title = iframe.contentDocument.title;
		},
		titleObserver = new MutationObserver(pullUpIframeTitle),
		iframeTitleNode = iframe.contentDocument.getElementsByTagName("title")[0];
	pullUpIframeTitle();
	titleObserver.observe(iframeTitleNode,{attributes: true, childList: true, characterData: true});
	// titleObserver.disconnect();

	var faviconLink = iframe.contentDocument.getElementById("faviconLink");
	var readFavIcon = function() {
			console.log("Favicon:",faviconLink.getAttribute("href"));

		},
		favIconObserver = new MutationObserver(readFavIcon);
	favIconObserver.observe(faviconLink,{attributes: true, childList: true, characterData: true});
};

})();
