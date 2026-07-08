/*
Disable the permalink / permaview buttons in TiddlyDesktop wiki windows.

Both build a URL fragment meant to be copied into a browser's address bar to navigate
to (or share) a tiddler. A TiddlyDesktop wiki window is a chromeless NW.js window over a
local file — there's no address bar and no shareable URL — so these controls do nothing
useful. We grey them out and make them non-interactive so it's clear the feature exists
but isn't applicable here.

We do this by injecting a stylesheet into the wiki's own document at runtime (never by
writing config tiddlers into the user's wiki, which would dirty and persist into their
file). The buttons carry no distinguishing attribute, but their SVG icons do
(tc-image-permalink-button / tc-image-permaview-button), so we target the enclosing
button via :has().
*/

"use strict";

// `doc` is the document that hosts the wiki content (folder wiki: the window's document;
// single-file wiki: the iframe's document, where the wiki actually renders).
exports.install = function(doc) {
	if(!doc) { return; }
	if(doc.getElementById("td-disable-permalinks-style")) { return; }
	var s = doc.createElement("style");
	s.id = "td-disable-permalinks-style";
	s.textContent = [
		"button:has(> svg.tc-image-permalink-button),",
		"button:has(> svg.tc-image-permaview-button){",
		"opacity:0.4 !important;",
		"pointer-events:none !important;",
		"cursor:default !important;",
		"}"
	].join("");
	(doc.head || doc.documentElement).appendChild(s);
};
