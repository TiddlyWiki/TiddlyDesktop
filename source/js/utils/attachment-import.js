/*
Reference a file added to a wiki, instead of embedding it.

Phase 9 of DESIGN-http-wiki-origin.md.

When External Attachments is enabled, adding a file to a wiki — dropped in or chosen through the
import button — should record a `_canonical_uri` pointing at where the file already lives, rather
than reading its bytes into the tiddler.

The stock plugin resolves that against the wiki DOCUMENT. That has never suited a folder wiki,
whose references belong relative to the WIKI FOLDER, so TiddlyDesktop has always supplied its own
hook; and since wikis are served over http it does not suit a single-file wiki either, because the
document is now a loopback URL rather than a path on disk. Both kinds therefore use this.

The folder-wiki version of this hook lived in wiki-folder-main.js and ran in-page with Node. The
wiki has no Node now, so it is installed from the parent onto the wiki's own `$tw.hooks` instead.
Nothing here actually needs Node: the file's absolute path comes from the File object (NW.js sets
`path` only for a real user selection), and the rest is path arithmetic.

The two-hook arrangement is deliberate and worth preserving. `th-importing-file` is a "piped" hook:
every handler sees the value returned by the previous one, and the importer embeds the file inline
unless the final value is exactly `true`. Claiming from a single handler is not enough — a later
handler would be handed our boolean, return false, and the file would ALSO be imported inline,
with the async inline import winning and the bytes ending up embedded after all. So `claim` runs
first, where it still receives the real info object, and `settle` runs last to control the final
value while passing other importers' results through untouched.
*/

"use strict";

// Relative path from `from` to `to`, both absolute and forward-slashed. Pure string work so this
// can run in the wiki's context.
function relativePath(from, to) {
	var a = String(from).split("/"),
		b = String(to).split("/"),
		i = 0;
	while(i < a.length && i < b.length && a[i] === b[i]) { i++; }
	var up = [];
	for(var j = i; j < a.length; j++) { up.push(".."); }
	return up.concat(b.slice(i)).join("/") || ".";
}

/*
	win      the wiki's window
	wikiDir  the directory references are resolved against — the wiki folder for a folder wiki,
	         the file's own directory for a single-file wiki
*/
exports.install = function(win, wikiDir) {
	var tw = null;
	try { tw = win && win.$tw; } catch(e) { tw = null; }
	if(!tw || !tw.hooks || !wikiDir) { return; }
	if(win.__tdAttachmentImportInstalled) { return; }
	win.__tdAttachmentImportInstalled = true;

	// Mirrors the stock plugin's makePathRelative, but rooted at the wiki folder rather than the
	// document, and reading the plugin's own UseAbsolute settings.
	function canonicalUriForDroppedFile(filePath) {
		var abs = String(filePath).replace(/\\/g, "/");
		if(abs.charAt(0) !== "/") { abs = "/" + abs; }           // C:/… -> /C:/…
		var baseDir = String(wikiDir).replace(/\\/g, "/").replace(/\/+$/, "");
		if(baseDir.charAt(0) !== "/") { baseDir = "/" + baseDir; }
		var isDescendent = abs === baseDir || abs.indexOf(baseDir + "/") === 0;
		var useAbsolute = tw.wiki.getTiddlerText(
			isDescendent
				? "$:/config/ExternalAttachments/UseAbsoluteForDescendents"
				: "$:/config/ExternalAttachments/UseAbsoluteForNonDescendents",
			isDescendent ? "no" : "yes"
		) === "yes";
		// encodeURI matches how TiddlyWiki's external-attachments records URIs (spaces -> %20).
		return useAbsolute
			? "file://" + encodeURI(abs)
			: encodeURI(relativePath(baseDir, abs));
	}

	var claimed = false;

	function claim(info) {
		claimed = false;
		try {
			if(info && info.isBinary && info.file && info.file.path &&
				tw.wiki.getTiddlerText("$:/config/ExternalAttachments/Enable", "") === "yes") {
				info.callback([{
					title: info.file.name,
					type: info.type,
					_canonical_uri: canonicalUriForDroppedFile(info.file.path)
				}]);
				claimed = true;
				return true;
			}
		} catch(e) {
			console.error("[TiddlyDesktop] external attachment import failed:", e);
		}
		return false;
	}

	function settle(value) {
		if(claimed) { claimed = false; return true; }
		return value;
	}

	var arr = tw.hooks.names && tw.hooks.names["th-importing-file"];
	if(arr && typeof arr.unshift === "function") {
		arr.unshift(claim);                        // first: still receives the real info object
	} else {
		tw.hooks.addHook("th-importing-file", claim);
	}
	tw.hooks.addHook("th-importing-file", settle); // last: controls the final return value
};
