/*
The JavaScript in this file is injected into each TiddlyWiki Classic page that loads, once the
document has loaded, and gives Classic a way to read and write the file this window owns.

The host defines `window.tiddlywikiSourceText` (the on-disk text of that file) and
`window.tiddlywikiFileUrl` (its file:// URL) immediately before this code runs.

The other half of the Classic support is utils/classic-local-inject.js, which the wiki server
injects into the document's head instead: what it does has to happen before Classic boots, and it
gets by without the file's contents.
*/

// Take this script back out of the document as soon as it has run. It carries the whole text of
// the wiki in a string literal, and Classic's recreateOriginal() rebuilds the file to save from
// document.documentElement.outerHTML — so left in place it could be written into the user's wiki,
// doubling its size. Removing the element does not undo its execution.
(function() {
	var element = document.currentScript;
	if(element && element.parentNode) {
		element.parentNode.removeChild(element);
	}
})();

/*
Returns true if successful, false if failed, null if not available
*/
var injectedSaveFile = function(path,content) {
	// Find the message box element
	var messageBox = document.getElementById("tiddlyfox-message-box");
	if(!messageBox) {
		return null;
	}
	// Create the message element and put it in the message box
	var message = document.createElement("div");
	message.setAttribute("data-tiddlyfox-path",path);
	message.setAttribute("data-tiddlyfox-content",content);
	messageBox.appendChild(message);
	// Create and dispatch the custom event to the extension
	var event = document.createEvent("Events");
	event.initEvent("tiddlyfox-save-file",true,false);
	message.dispatchEvent(event);
	// The host handles that event synchronously and takes the message element out of the box once
	// it has written the file, so a message still sitting in the box means the save was refused.
	// Report that honestly: Classic shows its own "failed to save" rather than claiming success.
	if(!message.parentNode) {
		return true;
	}
	messageBox.removeChild(message);
	return false;
};

/*
Returns text if successful, false if failed, null if not available

The `path` argument is deliberately ignored. This window owns exactly one file, and the host has
already injected that file's contents as window.tiddlywikiSourceText, so the argument carries no
information we do not already have — the same reasoning that made the saver stop trusting the
path the page supplies.

It used to be compared against getLocalPath(document.location), which worked only while the wiki
was a file:// document. Wikis are now served from a loopback http origin, so that comparison can
never match and Classic could not load its own source at all.
*/
var injectedLoadFile = function(path) {
	return window.tiddlywikiSourceText;
};

var injectedConvertUriToUTF8 = function(path) {
	return path;
}

var injectedConvertUnicodeToFileFormat = function(s) {
	return s;
}

/*
Get TiddlyWiki Classic 2.6 and earlier past their own "am I a file:// document?" gate.

Those versions open saveChanges() with

	var originalPath = document.location.toString();
	if(originalPath.substr(0,5) != "file:") { alert(msg.notFileUrlError); return; }

and wikis are served from a loopback http origin, so that check fails and saving stops there. 2.9
replaced the check with window.allowSave(), which defaults to true, so from 2.9 on there is nothing
here to fix — and the path the check guards is handled for every version by the getLocalPath
override in utils/classic-local-inject.js.

document.location cannot be shadowed: the HTML spec marks it [LegacyUnforgeable], which makes it an
own, non-configurable property of every Document. So rewrite that one reference inside saveChanges
instead — take the function's own source, point it at the file:// URL of this window's file, and
re-evaluate it in global scope. Rewriting rather than reimplementing keeps whatever saveChanges the
wiki actually ships, including one a plugin has already patched.
*/
var patchSaveChanges = function() {
	var url = window.tiddlywikiFileUrl,
		reference = /(?:document|window)\s*\.\s*location/g;
	if(typeof window.saveChanges !== "function" || !url) {
		return;
	}
	var source = window.saveChanges.toString();
	// Test for the gate itself rather than for a version number: it is the only thing being
	// neutralised, and rewriting a saveChanges that does not have it is risk for nothing.
	if(source.indexOf("\"file:\"") === -1 && source.indexOf("'file:'") === -1) {
		return;
	}
	var patched = source.replace(reference,"window.tiddlywikiFileLocation");
	if(patched === source) {
		return;
	}
	// A String object rather than a plain string, so both of the ways Classic reads a location
	// work: toString()/substr() see the URL, and `.href` is there for variants that read that.
	var location = new String(url);
	location.href = url;
	window.tiddlywikiFileLocation = location;
	try {
		// Indirect eval, so the replacement is defined in the global scope where the globals it
		// calls (store, config, saveMain, getLocalPath, ...) live, rather than in this scope.
		(0,window.eval)("window.saveChanges = (" + patched + ");");
	} catch(e) {
		console.error("[TiddlyDesktop] could not enable saving for this TiddlyWiki Classic wiki: " + e);
	}
};

window.mozillaSaveFile = injectedSaveFile;
window.mozillaLoadFile = injectedLoadFile;
window.convertUriToUTF8 = injectedConvertUriToUTF8;
window.convertUnicodeToFileFormat = injectedConvertUnicodeToFileFormat;

patchSaveChanges();
