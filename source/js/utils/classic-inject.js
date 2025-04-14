/*
The JavaScript in this file is injected into each TiddlyWiki Classic page that loads
*/

/*
Returns true if successful, false if failed, null if not available
*/
var injectedSaveFile = function(path,content) {
	// Find the message box element
	var messageBox = document.getElementById("tiddlyfox-message-box");
	if(messageBox) {
		// Create the message element and put it in the message box
		var message = document.createElement("div");
		message.setAttribute("data-tiddlyfox-path",path);
		message.setAttribute("data-tiddlyfox-content",content);
		messageBox.appendChild(message);
		// Create and dispatch the custom event to the extension
		var event = document.createEvent("Events");
		event.initEvent("tiddlyfox-save-file",true,false);
		message.dispatchEvent(event);
	}
	return true;
};

/*
Returns text if successful, false if failed, null if not available
*/
var injectedLoadFile = function(path) {
	if(getLocalPath(document.location.toString()) === path) {
		return this.tiddlywikiSourceText;
	} else {
		return false;
	}
};

var injectedConvertUriToUTF8 = function(path) {
	return path;
}

var injectedConvertUnicodeToFileFormat = function(s) {
	return s;
}

window.mozillaSaveFile = injectedSaveFile;
window.mozillaLoadFile = injectedLoadFile;
window.convertUriToUTF8 = injectedConvertUriToUTF8;
window.convertUnicodeToFileFormat = injectedConvertUnicodeToFileFormat;
