/*
Saving support for TiddlyWiki5 and TiddlyWiki Classic
*/

"use strict";

// Helper to enable TiddlyFox-style saving for a window.
// `getPathnameFn` returns the pathname of the file this window owns, and is what every save is
// resolved against — see resolveSaveTarget() below. It is required: without it the saver refuses
// to save rather than falling back on a page-supplied path.
exports.enableSaving = function(doc,areBackupsEnabledFn,loadFileTextFn,backupCountFn,getPathnameFn) {
	// Create the message box
	var messageBox = doc.createElement("div");
	messageBox.id = "tiddlyfox-message-box";
	doc.body.appendChild(messageBox);
	// The one file this window owns — see the security note in the save handler below.
	var ownPathFn = function() {
		return typeof getPathnameFn === "function" ? getPathnameFn() : null;
	};
	// Inject saving code into TiddlyWiki classic
	var isClassic = isTiddlyWikiClassic(doc);
	if(isClassic) {
		injectClassicOverrides(doc,loadFileTextFn,ownPathFn());
	}
	// Listen for save events
	messageBox.addEventListener("tiddlyfox-save-file",function(event) {
		// Get the details from the message
		var message = event.target,
			claimedPath = message.getAttribute("data-tiddlyfox-path"),
			content = message.getAttribute("data-tiddlyfox-content");
		// TW5's TiddlyFox saver hands the path over as UTF8 bytes in a binary string, so decode
		// it. Classic's comes back out of the file:// URL we injected ourselves, through an
		// unescape() that leaves it exactly as we wrote it, so it is already a real string —
		// decoding it again would mangle every non-ASCII name.
		if(claimedPath && !isClassic && process.platform !== "win32") {
			claimedPath = Buffer.from(claimedPath,"binary").toString("utf8");
		}
		var ownPath = ownPathFn();
		if(!ownPath) {
			console.error("[TiddlyDesktop] save refused: this window has no authoritative pathname");
			return false;
		}
		var filepath = resolveSaveTarget(ownPath,claimedPath,isClassic);
		if(!filepath) {
			return false;
		}
		// Backup the existing file (if any). Classic keeps its own backups, of its own file, so
		// leave that to it rather than shadowing it — and never back up a file Classic is itself
		// writing as a backup.
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

/*
Decide which file a TiddlyFox save message is allowed to write to, or null to refuse it.
`ownPath` is the one file this window owns; `claimedPath` is what the page put on the message.

SECURITY: the page's path is never taken at face value. This listener runs in the parent's Node
context but is attached to the WIKI's document, so any script in the wiki controls
data-tiddlyfox-path — honouring it as given is an arbitrary file write as the user (~/.bashrc, an
autostart entry, the app's own JS).

For TW5 the destination is simply the window's own file: such a window owns exactly one, and "save
as" / download goes through Chromium's download path rather than TiddlyFox, so there is no
legitimate case where the two differ.

Classic is the exception, and forcing it onto the window's own path is not safe. A single
saveChanges() writes up to four files — the wiki, a timestamped backup, an empty template and an
RSS feed — all through this one message, so redirecting them all onto the wiki would have Classic
overwrite the wiki with its own backup, its empty template or its feed.

Those are the wiki's own files, so they are allowed, on either of two grounds. The empty template
and the RSS feed always go beside the wiki, and so do backups under the default settings, so
anything in the wiki's own folder passes. Backups follow txtBackupFolder, though, which is a path
relative to that folder and may legitimately climb out of it ("../backups"), so a file named after
the wiki — which is how getBackupPath names every backup — passes wherever it is. That second rule
deliberately excludes a file with the wiki's own name, so it cannot be used to overwrite some other
index.html elsewhere on the disk, and both are bounded to the extensions Classic writes.

Anything else is refused rather than redirected: a redirect would turn a stray write into a
wiki-destroying one.
*/
function resolveSaveTarget(ownPath,claimedPath,isClassic) {
	var path = require("path"),
		own = path.resolve(ownPath);
	if(!claimedPath || path.resolve(claimedPath) === own) {
		return own;
	}
	if(!isClassic) {
		console.warn("[TiddlyDesktop] ignoring save path supplied by the page:",claimedPath,"- saving to",own);
		return own;
	}
	var claimed = path.resolve(claimedPath),
		name = path.basename(claimed),
		ownName = path.basename(own),
		insideWikiFolder = claimed.indexOf(path.dirname(own) + path.sep) === 0,
		namedAfterWiki = name !== ownName &&
			name.indexOf(path.basename(own,path.extname(own)) + ".") === 0;
	if((insideWikiFolder || namedAfterWiki) && /\.(?:html?|xml)$/i.test(claimed)) {
		return claimed;
	}
	console.error("[TiddlyDesktop] save refused: the page asked to write outside the wiki's own folder:",claimedPath);
	return null;
}

/*
The file:// URL of a wiki file, in the dialect TiddlyWiki Classic's getLocalPath() understands.

Deliberately not url.pathToFileURL(): that percent-encodes non-ASCII as UTF8, and Classic decodes
with unescape(), which reads each %XX back as one Latin-1 character — so "ä" would return as two
characters naming a file that does not exist. Classic cuts the URL at the first literal "?" or "#"
and only then unescapes, which makes "%", "#" and "?" exactly the set that has to be escaped;
everything else survives the round trip literally.
*/
function fileUrlFromPath(filepath) {
	if(!filepath) {
		// No authoritative path: leave the URL empty so the injected code declines to patch
		// saveChanges rather than pointing it somewhere arbitrary. Saves are refused anyway.
		return "";
	}
	var path = require("path"),
		absolute = path.resolve(filepath).replace(/\\/g,"/"),
		escaped = absolute.replace(/%/g,"%25").replace(/#/g,"%23").replace(/\?/g,"%3F");
	// "file:///C:/wiki.html" on Windows and "file:///home/me/wiki.html" elsewhere: three slashes
	// either way, which is what Classic's parser keys on.
	return "file://" + (escaped.charAt(0) === "/" ? "" : "/") + escaped;
}

/*
Helper to detect whether a document is a TiddlyWiki Classic.

`#storeArea` is NOT enough on its own: TiddlyWiki 5 writes one too, for the benefit of 5.1.x
tooling. Nor is the version object — TW5's twedit.js saver sets `window.version = {title:
"TiddlyWiki"}` in every browser, on purpose, so that TWEdit takes the document for a Classic. Every
release from 2.0 to 2.10 carries its shadow tiddlers in a `<div id="shadowArea">`, TW5 keeps its
shadows in plugins and writes no such element, and this is the same marker the wiki server sniffs
for (utils/classic-local.js), so both ends agree on what a Classic is. `#versionArea` would serve
from 2.4 on, but 2.2 leaves the script holding the version object anonymous.
*/
function isTiddlyWikiClassic(doc) {
	var view = doc.defaultView;
	// $tw is the one thing TW5 does not pretend about.
	if(view && view.$tw) {
		return false;
	}
	return !!(doc.getElementById("storeArea") && doc.getElementById("shadowArea"));
}

// Helper to inject overrides into TiddlyWiki Classic
function injectClassicOverrides(doc,loadFileTextFn,filepath) {
	var fs = require("fs"),
		path = require("path");
	// Define the data the injected code needs BEFORE it, so that it is there while that code runs:
	// the source text of the file, for the injected loadFile function, and the file:// URL of the
	// file, for the saveChanges patch (see classic-inject.js).
	var text = "window.tiddlywikiSourceText=\"" + stringify(loadFileTextFn()) + "\";\n" +
		"window.tiddlywikiFileUrl=\"" + stringify(fileUrlFromPath(filepath)) + "\";\n\n" +
		fs.readFileSync(path.resolve(path.dirname(module.filename),"classic-inject.js"),"utf8");
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
	// Classic's txtBackupFolder can name a folder that does not exist yet — "backup" beside the
	// wiki, say — and nothing else creates it, so the backup would just fail. Make the
	// destination's folder first, as backupFile() does for TiddlyWiki 5. A no-op for the wiki
	// itself, whose folder is the one it was opened from.
	try { fs.mkdirSync(path.dirname(target),{recursive: true}); } catch(e) {}
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
