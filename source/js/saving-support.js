(function(){

/*jslint browser: true */
"use strict";

// Helper to enable TiddlyFox-style saving for a window
exports.enableSaving = function(doc) {
	// Create the message box
	var messageBox = doc.createElement("div");
	messageBox.id = "tiddlyfox-message-box";
	doc.body.appendChild(messageBox);
	// Inject saving code into TiddlyWiki classic
	if(isTiddlyWikiClassic(doc)) {
		injectClassicOverrides(doc);
	}
	// Listen for save events
	messageBox.addEventListener("tiddlyfox-save-file",function(event) {
		// Get the details from the message
		var message = event.target,
			path = message.getAttribute("data-tiddlyfox-path"),
			content = message.getAttribute("data-tiddlyfox-content");
		// Save the file
		saveFile(path,content);
		// Remove the message element from the message box
		message.parentNode.removeChild(message);
		// Send a confirmation message
		var event = doc.createEvent("Events");
		event.initEvent("tiddlyfox-have-saved-file",true,false);
		event.savedFilePath = path;
		message.dispatchEvent(event);
		return false;
	},false);
}

// Helper to detect whether a document is a TiddlyWiki Classic
function isTiddlyWikiClassic(doc) {
	var versionArea = doc.getElementById("versionArea");
	return doc.getElementById("storeArea") &&
		(versionArea && /TiddlyWiki/.test(versionArea.text));
}

// Helper to inject overrides into TiddlyWiki Classic
function injectClassicOverrides(doc) {
	// Read classic-inject.js
	var xhReq = new XMLHttpRequest();
	xhReq.open("GET","../js/classic-inject.js",false);
	xhReq.send(null);
	// Inject it in a script tag
	var script = doc.createElement("script");
	script.appendChild(doc.createTextNode(xhReq.responseText));
	doc.getElementsByTagName("head")[0].appendChild(script);
}


// Helper function to save a file
function saveFile(path,content) {
	var fs = require("fs");
	fs.writeFileSync(path,content);
}

})();
