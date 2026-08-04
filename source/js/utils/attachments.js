/*
Route the wiki's absolute external attachments onto the attachment origin.

Phase 5 of DESIGN-http-wiki-origin.md.

The problem
-----------
The External Attachments plugin records a tiddler's `_canonical_uri` as a RELATIVE path when the
file sits inside the wiki tree, and as an absolute `file://` URL when it does not — and absolute is
the default for anything outside (`UseAbsoluteForNonDescendents` defaults to "yes"), so it is the
common case, not an edge case.

Relative ones are fine: they resolve against the wiki's own URL and the wiki server serves them.
Absolute `file://` ones broke when the wiki stopped being a `file://` page, because an http document
cannot load a `file://` subresource at all — Chromium blocks it outright.

The fix
-------
Rewrite those references onto the attachment origin, which serves a file only if the user has
trusted it for this wiki. Two channels need it, because TiddlyWiki loads the two classes of
attachment in completely different ways:

  MEDIA   image/audio/video/pdf parsers emit elements whose `src` is the _canonical_uri, and
          Chromium fetches them. Handled by rewriting the attribute, with a MutationObserver to
          catch tiddlers rendered later — the same approach embeds.js already uses for iframes.

  TEXT    wikiparser.js calls loadRemoteTiddler() -> $tw.utils.httpRequest -> XMLHttpRequest for a
          .tid/.txt attachment. That never touches the DOM, so the observer cannot see it; the
          wiki's XMLHttpRequest.open is wrapped instead.

Both run from the parent, on the wiki's window. Rewriting is not a security control — the server
decides, per request, whether the path is trusted — so a wiki that evades the rewrite gains
nothing but a broken image.
*/

"use strict";

// Attributes that can carry an attachment reference, by element.
var ATTR_BY_TAG = {
	IMG: "src",
	VIDEO: "src",
	AUDIO: "src",
	SOURCE: "src",
	EMBED: "src",
	IFRAME: "src",
	OBJECT: "data"
};

var SELECTOR = "img[src], video[src], audio[src], source[src], embed[src], iframe[src], object[data]";

// A file:// URL -> its filesystem path. _canonical_uri values are URI-encoded (spaces as %20), so
// decode; a value that will not decode is left alone rather than guessed at.
function fileUrlToPath(url) {
	var s = String(url || "");
	if(!(/^file:\/\//i).test(s)) { return null; }
	s = s.replace(/^file:\/\//i, "");
	// Windows file URLs carry a leading slash before the drive letter (file:///C:/…).
	if((/^\/[a-zA-Z]:/).test(s)) { s = s.slice(1); }
	try { return decodeURI(s); } catch(e) { return s; }
}
exports.fileUrlToPath = fileUrlToPath;

/*
A tiddler's _canonical_uri -> the absolute filesystem path it refers to, or null when it does not
refer to a local file (http(s):, data:, or empty). Relative URIs resolve against the wiki's own
directory, which is exactly how TiddlyWiki resolves them against the wiki document's URL.
*/
function resolveCanonicalUri(uri, wikiDir) {
	var s = String(uri || "");
	if(!s) { return null; }
	if((/^(https?|data|blob):/i).test(s)) { return null; }
	var abs = fileUrlToPath(s);
	if(abs) { return require("path").resolve(abs); }
	try { s = decodeURI(s); } catch(e) {}
	return require("path").resolve(wikiDir || ".", s);
}
exports.resolveCanonicalUri = resolveCanonicalUri;

/*
	doc     the wiki's document
	win     the wiki's window
	handle  the server handle (needs attachmentUrl())
*/
exports.install = function(doc, win, handle) {
	if(!doc || !win || !handle || typeof handle.attachmentUrl !== "function") { return; }
	if(doc.__tdAttachmentsInstalled) { return; }
	doc.__tdAttachmentsInstalled = true;

	function rewriteElement(el) {
		var attr = ATTR_BY_TAG[el.tagName];
		if(!attr) { return; }
		var value = el.getAttribute(attr);
		var abs = fileUrlToPath(value);
		if(!abs) { return; }
		try { el.setAttribute(attr, handle.attachmentUrl(abs)); } catch(e) {}
	}

	function scan(root) {
		if(!root || !root.querySelectorAll) { return; }
		var nodes = root.querySelectorAll(SELECTOR);
		for(var i = 0; i < nodes.length; i++) { rewriteElement(nodes[i]); }
		if(ATTR_BY_TAG[root.tagName]) { rewriteElement(root); }
	}

	// TiddlyWiki renders and re-renders continuously, so new attachments appear long after load.
	try {
		var MO = win.MutationObserver || win.WebKitMutationObserver;
		if(MO) {
			var obs = new MO(function(muts) {
				for(var m = 0; m < muts.length; m++) {
					var mut = muts[m];
					if(mut.type === "attributes") {
						rewriteElement(mut.target);
						continue;
					}
					for(var a = 0; a < mut.addedNodes.length; a++) {
						var n = mut.addedNodes[a];
						if(n.nodeType === 1) { scan(n); }
					}
				}
			});
			obs.observe(doc.documentElement || doc.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["src", "data"]
			});
		}
	} catch(e) {}

	// Text attachments never reach the DOM: TiddlyWiki XHRs them straight into the store.
	try {
		var XHR = win.XMLHttpRequest;
		if(XHR && XHR.prototype && !XHR.prototype.__tdAttachmentPatched) {
			var open = XHR.prototype.open;
			XHR.prototype.open = function(method, url) {
				var abs = fileUrlToPath(url);
				if(abs) {
					arguments[1] = handle.attachmentUrl(abs);
				}
				return open.apply(this, arguments);
			};
			XHR.prototype.__tdAttachmentPatched = true;
		}
	} catch(e) {}

	scan(doc);
};
