/*
The JavaScript in this file is injected into the head of each single-file wiki the wiki server
serves, ahead of the wiki's own scripts, and does its work at DOMContentLoaded — by which point
those scripts have defined everything, and `<body onload="main()">` has not yet run.

The host defines `window.tiddlywikiFilePath` (the absolute pathname of this window's file)
immediately before this code runs. Nothing here needs the file's *contents*; those arrive later,
with utils/classic-inject.js, which the host injects once the document has loaded.

TiddlyWiki Classic works out what it may do, and where, by looking at its own URL. Single-file
wikis are served from a loopback http origin now, so every one of those answers comes out wrong:

  * `readOnly` is computed in main() from `window.isLocal()` (2.9+) or from
    `window.location.protocol` (2.6 and earlier), falling back to `config.options.chkHttpReadOnly`
    — which defaults to true. So Classic starts read-only and renders no save command at all,
    which is why saving looked like it had disappeared rather than like it was failing.
  * `getLocalPath()` converts the document URL into the native path to save to. Given an http URL
    it falls through to the "pc network file" branch and returns something like
    \\127.0.0.1:47111\wiki\wiki.html — a path that names nothing.
  * `tw.io.xhrLoadFile()` (2.9+) reads the original file back with an XHR to a file:// URL, which
    a page on an http origin is not allowed to make.

Each is answered here at its own seam, so that the rest of Classic — 2.5 through 2.10 alike — goes
on believing it is the local file it actually is.
*/
(function() {
	// Take this script back out of the document as soon as it has run. Classic's
	// recreateOriginal() rebuilds the file to save from document.documentElement.outerHTML, so
	// anything left in the DOM here can end up written into the user's wiki. Removing the element
	// does not undo its execution.
	var element = document.currentScript;
	if(element && element.parentNode) {
		element.parentNode.removeChild(element);
	}

	// Classic strips the query and fragment before converting a URL to a path, and its own
	// fragment changes as the user navigates, so compare URLs without either.
	function bare(url) {
		return String(url === null || url === undefined ? "" : url).split("#")[0].split("?")[0];
	}

	// main() reads chkHttpReadOnly to decide whether an http document may be edited. On this host
	// the document is a local file that happens to be delivered over http, so it always may.
	function allowHttpEditing() {
		if(window.config && config.options) {
			config.options.chkHttpReadOnly = false;
		}
	}

	function makeLocal() {
		// TiddlyWiki Classic only, and neither `#storeArea` nor the version object can establish
		// that: TW5 writes a `#storeArea` for 5.1.x tooling, and its twedit.js saver deliberately
		// sets `window.version = {title: "TiddlyWiki"}` so that TWEdit takes it for a Classic.
		// `#shadowArea` — where every release from 2.0 to 2.10 keeps its shadow tiddlers, and
		// which TW5 never writes — is the marker that separates them, and $tw is the one thing TW5
		// does not pretend about. (`#versionArea` would do from 2.4 on, but 2.2 leaves the script
		// holding the version object anonymous.)
		if(window.$tw || !document.getElementById("storeArea") || !document.getElementById("shadowArea")) {
			return;
		}
		// ── this file is local ──────────────────────────────────────────────────────
		// 2.9 and later ask window.isLocal(). Earlier versions test
		// window.location.protocol directly, which cannot be shadowed — the HTML spec marks
		// `location` [LegacyUnforgeable], making it an own, non-configurable property — so for
		// those the answer has to come through the option instead.
		if(typeof window.isLocal === "function") {
			window.isLocal = function() {
				return true;
			};
		}
		allowHttpEditing();
		// main() calls loadOptions() — cookies, and the wiki's own SystemSettings tiddler —
		// between here and the line that reads chkHttpReadOnly, and either source can set it back
		// to true. Re-apply once those have been read.
		if(typeof window.loadOptions === "function") {
			var inheritedLoadOptions = window.loadOptions;
			window.loadOptions = function() {
				var result = inheritedLoadOptions.apply(this,arguments);
				allowHttpEditing();
				return result;
			};
		}
		// ── and this is where it lives ──────────────────────────────────────────────
		// Every version funnels the document URL through getLocalPath() to get the path to save
		// to, so this one override serves all of them: 2.10 via tw.io.getOriginalLocalPath(), 2.9
		// and earlier from saveChanges directly. Only this document's own URL is answered from
		// the host — a file:// URL in a tiddler is still Classic's own business.
		var inheritedGetLocalPath = window.getLocalPath;
		window.getLocalPath = function(origPath) {
			var asked = bare(origPath);
			if(asked && (asked === bare(document.location) ||
				(window.tiddlywikiFileUrl && asked === bare(window.tiddlywikiFileUrl)))) {
				return window.tiddlywikiFilePath;
			}
			return typeof inheritedGetLocalPath === "function" ?
				inheritedGetLocalPath.apply(this,arguments) : window.tiddlywikiFilePath;
		};
		// ── and this is how it is read back ─────────────────────────────────────────
		// saveChanges loads the file from disk to splice the new store area into it. 2.9 and
		// later do that asynchronously through tw.io.xhrLoadFile, whose XHR to a file:// URL this
		// origin cannot make; the host answers the synchronous read instead (see
		// utils/classic-inject.js), so hand it there.
		if(window.tw && tw.io) {
			tw.io.xhrLoadFile = function(filepath,callback) {
				// mozillaLoadFile rather than loadFile: loadFile's own chain ends by calling this
				// function, so going back in through it would be a loop.
				var text = null;
				try {
					text = window.mozillaLoadFile(filepath);
				} catch(e) {}
				if(typeof text !== "string") {
					text = null;
				}
				return callback ? callback(text,{}) : text;
			};
		}
	}

	if(document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded",makeLocal,false);
	} else {
		makeLocal();
	}
})();
