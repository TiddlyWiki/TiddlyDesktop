/*
Saving support for TiddlyWiki5 and TiddlyWiki Classic
*/

"use strict";

// Helper to enable TiddlyFox-style saving for a window.
// `getPathnameFn` returns the pathname of the file this window owns, and is the ONLY destination
// this saver will ever write to — see the security note in the save handler below. It is required:
// without it the saver refuses to save rather than falling back on a page-supplied path.
exports.enableSaving = function(doc,areBackupsEnabledFn,loadFileTextFn,backupCountFn,getPathnameFn) {
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
		var path = require("path"),
			message = event.target,
			claimedPath = message.getAttribute("data-tiddlyfox-path"),
			content = message.getAttribute("data-tiddlyfox-content");
		// Convert the claimed path from UTF8 binary to a real string
		if(claimedPath && (process.platform !== "win32" || isClassic)) {
			claimedPath = Buffer.from(claimedPath,"binary").toString("utf8");
		}
		// SECURITY: never save to the path the page asked for. This listener runs in the parent's
		// Node context but is attached to the WIKI's document, so any script in the wiki controls
		// data-tiddlyfox-path — honouring it is an arbitrary file write as the user (~/.bashrc, an
		// autostart entry, the app's own JS). A wiki-file window owns exactly one file, so the
		// window's own pathname is the authoritative destination and the attribute is redundant.
		// TW5's "save as" / download goes through Chromium's download path rather than TiddlyFox,
		// so there is no legitimate case where the two differ.
		var filepath = typeof getPathnameFn === "function" ? getPathnameFn() : null;
		if(!filepath) {
			console.error("[TiddlyDesktop] save refused: this window has no authoritative pathname");
			return false;
		}
		if(claimedPath && path.resolve(claimedPath) !== path.resolve(filepath)) {
			console.warn("[TiddlyDesktop] ignoring save path supplied by the page:",claimedPath,"- saving to",filepath);
		}
		// Backup the existing file (if any)
		if(areBackupsEnabledFn() && !isClassic) {
			backupFile(filepath,backupCountFn ? backupCountFn() : "");
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

/*
Write the wiki file.

Via a temp file in the same directory and a rename, not a plain writeFileSync. A single-file wiki
is one file holding everything the user has ever written, and writeFileSync truncates it before it
writes: a crash, a power cut or a full disk between those two leaves a truncated wiki and nothing
else. The rename is atomic on every platform we ship (POSIX rename(2), and Node's rename uses
MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows), so the file on disk is only ever the old
wiki or the new one.

The path is REALPATH'd first, because a rename replaces whatever is at the destination — including
a symlink. A wiki that is a link into a synced folder would otherwise have the link itself
overwritten with a regular file, leaving the real wiki frozen at its previous contents and silently
out of the sync set. writeFileSync followed the link; so must this. Resolving also puts the temp
file in the same directory as the real target, which is what keeps the rename inside one filesystem
and therefore atomic.

Falls back to a direct write if the rename cannot be done — a directory the user cannot create
files in, say. That is the old behaviour, which is the right floor: failing to save at all would
be worse than saving the way we always used to.
*/
function saveFile(filepath,content) {
	var fs = require("fs"),
		path = require("path"),
		target = filepath;
	// A wiki that does not exist yet has no realpath; write to the path we were given.
	try { target = fs.realpathSync(filepath); } catch(e) {}
	var temp = path.join(path.dirname(target),"." + path.basename(target) + ".tdsave");
	// The temp file is created fresh, so it gets default permissions rather than the wiki's. A user
	// who chmod'd their wiki to 0600 must not have it quietly widened to 0644 by saving it.
	var mode = null;
	try { mode = fs.statSync(target).mode & 0o777; } catch(e) {}
	try {
		var fd = fs.openSync(temp,"w");
		try {
			fs.writeFileSync(fd,content);
			// Flush before the rename, so a power loss cannot leave a renamed file whose bytes
			// never reached the disk.
			try { fs.fsyncSync(fd); } catch(e) {}
		} finally {
			fs.closeSync(fd);
		}
		if(mode !== null) { try { fs.chmodSync(temp,mode); } catch(e) {} }
		fs.renameSync(temp,target);
	} catch(e) {
		try { fs.unlinkSync(temp); } catch(e2) {}
		fs.writeFileSync(filepath,content);
	}
}

// Helper function to backup a file by copying it to the backup folder. `keepText` is the
// per-wiki "number of backups to keep" string (empty = keep all).
function backupFile(filepath,keepText) {
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
		// Enforce the per-wiki retention limit (keep only the most recent N backups).
		pruneBackups(filepath,backupSubPath,ext,keepText);
	}
}

// Delete the oldest backups of `filepath` in `backupSubPath` beyond `keepText` (the per-wiki
// "number of backups to keep"). Empty / non-numeric / <= 0 means "keep all" (no pruning).
function pruneBackups(filepath,backupSubPath,ext,keepText) {
	var fs = require("fs"),
		path = require("path");
	keepText = (keepText || "").trim();
	var keep = parseInt(keepText,10);
	if(!keepText || isNaN(keep) || keep <= 0) { return; }
	// Backups are named "<basename>.<timestamp>[ n]<ext>" (see above), so match that prefix
	// and extension. Filtering by name keeps us from touching other wikis' backups if they
	// share a backup folder.
	var prefix = path.basename(filepath,ext) + ".",
		entries;
	try { entries = fs.readdirSync(backupSubPath); } catch(e) { return; }
	var backups = entries.filter(function(name) {
		if(name.indexOf(prefix) !== 0) { return false; }
		return ext ? name.slice(-ext.length) === ext : true;
	}).map(function(name) {
		var full = path.resolve(backupSubPath,name), mtime = 0;
		try { mtime = fs.statSync(full).mtimeMs || 0; } catch(e) {}
		return {full: full, mtime: mtime};
	});
	if(backups.length <= keep) { return; }
	// Newest first; remove everything past the keep count.
	backups.sort(function(a,b) { return b.mtime - a.mtime; });
	backups.slice(keep).forEach(function(b) {
		try { fs.unlinkSync(b.full); } catch(e) {}
	});
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
