/*
Saving support for TiddlyWiki5 and TiddlyWiki Classic
*/

"use strict";

// Helper to enable TiddlyFox-style saving for a window
exports.enableSaving = function(doc,areBackupsEnabledFn,loadFileTextFn) {
	// Create the message box
	var messageBox = doc.createElement("div");
	messageBox.id = "tiddlyfox-message-box";
	doc.body.appendChild(messageBox);
	// Inject saving code into TiddlyWiki classic
	var isClassic = isTiddlyWikiClassic(doc);
	if(isClassic) {
		injectClassicOverrides(doc,loadFileTextFn);
	}
	// Listen for save events
	messageBox.addEventListener("tiddlyfox-save-file",function(event) {
		// Get the details from the message
		var message = event.target,
			filepath = message.getAttribute("data-tiddlyfox-path"),
			content = message.getAttribute("data-tiddlyfox-content");
		// Convert filepath from UTF8 binary to a real string
		if(process.platform !== "win32" || isClassic) {
			filepath = (new Buffer(filepath,"binary")).toString("utf8");			
		}
		// Backup the existing file (if any)
		if(areBackupsEnabledFn() && !isClassic) {
			backupFile(filepath);
		}
		// Save the file
		saveFile(filepath,content);
		// Remove the message element from the message box
		message.parentNode.removeChild(message);
		// Send a confirmation message
		var event = doc.createEvent("Events");
		event.initEvent("tiddlyfox-have-saved-file",true,false);
		event.savedFilePath = filepath;
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
function injectClassicOverrides(doc,loadFileTextFn) {
	// Read classic-inject.js
	var fs = require("fs"),
		path = require("path"),
		text = fs.readFileSync(path.resolve(path.dirname(module.filename),"classic-inject.js"));
	// Add the source text of the file so that the injected loadFile function can access it
	text += "\n\nwindow.tiddlywikiSourceText=\"" + stringify(loadFileTextFn()) + "\";"
	// Inject it in a script tag
	var script = doc.createElement("script");
	script.appendChild(doc.createTextNode(text));
	doc.getElementsByTagName("head")[0].appendChild(script);
}

/*
Pad a string to a given length with "0"s. Length defaults to 2
*/
function pad(value,length) {
	length = length || 2;
	var s = value.toString();
	if(s.length < length) {
		s = "000000000000000000000000000".substr(0,length - s.length) + s;
	}
	return s;
};

/*
 * Returns an escape sequence for given character. Uses \x for characters <=
 * 0xFF to save space, \u for the rest.
 *
 * The code needs to be in sync with th code template in the compilation
 * function for "action" nodes.
 */
// Copied from peg.js, thanks to David Majda
function escape(ch) {
	var charCode = ch.charCodeAt(0);
	if(charCode <= 0xFF) {
		return '\\x' + pad(charCode.toString(16).toUpperCase());
	} else {
		return '\\u' + pad(charCode.toString(16).toUpperCase(),4);
	}
};

// Turns a string into a legal JavaScript string
// Copied from peg.js, thanks to David Majda
function stringify(s) {
	/*
	* ECMA-262, 5th ed., 7.8.4: All characters may appear literally in a string
	* literal except for the closing quote character, backslash, carriage return,
	* line separator, paragraph separator, and line feed. Any character may
	* appear in the form of an escape sequence.
	*
	* For portability, we also escape all non-ASCII characters.
	*/
	return (s || "")
		.replace(/\\/g, '\\\\')            // backslash
		.replace(/"/g, '\\"')              // double quote character
		.replace(/'/g, "\\'")              // single quote character
		.replace(/\r/g, '\\r')             // carriage return
		.replace(/\n/g, '\\n')             // line feed
		.replace(/[\x00-\x1f\x80-\uFFFF]/g, escape); // non-ASCII characters
};

// Helper function to save a file
function saveFile(filepath,content) {
	var fs = require("fs");
	fs.writeFileSync(filepath,content);
}

// Helper function to backup a file by copying it to the backup folder
function backupFile(filepath) {
	var fs = require("fs"),
		path = require("path");
	// Backup the file if it exists
	if(fs.existsSync(filepath)) {
		// Get the timestamp
		var timestamp = $tw.utils.stringifyDate(fs.statSync(filepath).mtime || (new Date())),
			backupSubPath = backupPathByPath(filepath);
		// Compose and uniquify the backup pathname
		var count = 0,
			backupPath,
			uniquifier,
			ext = path.extname(filepath);
		do {
			uniquifier = count ? " " + count : "";
			backupPath = path.resolve(
				backupSubPath,
				path.basename(filepath,ext) + "." + timestamp + uniquifier + ext
			);
			count = count + 1;
		} while(fs.existsSync(backupPath));
		// Copy the existing file to the backup
		$tw.utils.createDirectory(path.dirname(backupPath));
		fs.writeFileSync(backupPath,fs.readFileSync(filepath)); // For some reason $tw.utils.copyFile() doesn't work here
	}
}

// Helper to get the backup folder for a given filepath
function backupPathByPath(pathname) {
	var path = require("path"),
		backupPath = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/BackupPath","");
	// Replace $filename$ with the filename portion of the filepath and $filepath$ with the entire filepath 
	backupPath = backupPath.replace(/\$filename\$/mgi,path.basename(pathname))
		.replace(/\$filepath\$/mgi,pathname);
	backupPath = path.resolve(path.dirname(pathname),backupPath)
	return backupPath;
}

exports.backupPathByPath = backupPathByPath;
