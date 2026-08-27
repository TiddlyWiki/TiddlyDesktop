/*
Utilities concerned with handling TiddlyDesktop links.

A wiki's links are the one place its content reaches the operating system, so the scheme is
checked before anything is handed over — the same rule the openExternal bridge follows
(utils/bridges.js) and the Android side enforces in host/ExternalLinks.kt.

  http, https, mailto, tel   opened with the system handler. This is what a wiki legitimately
                             links to.
  file                       REVEALED in the file manager, never opened. Linking to a local file
                             is a real thing wikis do, but Shell.openExternal on a file:// URL
                             asks the OS to LAUNCH it — so a link a wiki labelled "Read the
                             notes" could point at an .exe, a .desktop file or a .bat and run it
                             on one click. Revealing keeps the intent (get me to that file) and
                             takes the execution away.
  anything else              refused. Every other scheme is whatever an installed application
                             happened to register: UNC paths, vendor deep links, and our own
                             tiddlydesktop:// (which only ever arrives from the system browser
                             and is never navigated to from inside a wiki).

In-document links (a bare "#target") and the pseudo-schemes a page can build for itself
(javascript:, data:, blob:) are left to the document, which is what the allowlist does by not
naming them.
*/

"use strict";

var OPEN_SCHEMES = {"http:": true, "https:": true, "mailto:": true, "tel:": true};

// Scheme of an absolute URL, lowercased and including the colon ("https:"), or null for anything
// without one. Deliberately its own parse rather than a URL(): this runs on every click, and a
// relative href has no scheme to find.
function schemeOf(href) {
	var m = (/^([a-z][a-z0-9+.\-]*:)/i).exec(String(href || ""));
	return m ? m[1].toLowerCase() : null;
}

// Hand a link to the operating system, if its scheme is allowed. Returns true if we took it.
function openExternalLink(href) {
	var scheme = schemeOf(href);
	if(!scheme) { return false; }
	if(OPEN_SCHEMES[scheme]) {
		$tw.desktop.gui.Shell.openExternal(href);
		return true;
	}
	if(scheme === "file:") {
		// Reveal rather than launch — see the note above.
		try {
			var pathname = $tw.desktop.utils.file.convertFileUrlToPath(href.split("#")[0].split("?")[0]);
			try { pathname = decodeURI(pathname); } catch(e) {}
			$tw.desktop.gui.Shell.showItemInFolder(pathname);
		} catch(e) {
			console.error("[TiddlyDesktop] could not reveal the linked file:", e && e.message);
		}
		return true;
	}
	console.warn("[TiddlyDesktop] refused a link with a scheme we do not open:", href);
	return true;
}

// Helper to trap wikilinks within a window
exports.trapLinks = function(doc) {
	doc.addEventListener("click",function(event) {
		// Check that we're not in an internal link
		// "tc-tiddlylink" is for TW5, "tiddlyLink" for TWC
		var link = $tw.desktop.utils.dom.findParentWithTag(event.target,"a");
		if(link) {
			var href;
			if(link.namespaceURI === "http://www.w3.org/2000/svg") {
				// SVG
				href = link.href.baseVal.split("#");
				href = (href[0] || doc.location.href.split("#")[0]) + "#" + href[1];
			} else {
				// HTML
				href = link.href;
			}
			if(href && href.split("#")[0] !== doc.location.href.split("#")[0]) {
				if(openExternalLink(href)) {
					event.preventDefault();
					event.stopPropagation();
					return false;
				}
			}
		}
		return true;
	},false);
};
