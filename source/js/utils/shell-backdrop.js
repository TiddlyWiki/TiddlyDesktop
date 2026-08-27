/*
Mirror a framed wiki's canvas onto the shell document behind it.

A sandboxed wiki window is a shell document (html/wiki-file-window.html, html/wiki-folder-shell.html)
whose visible content is one iframe holding the wiki. Both the iframe and the shell are transparent,
so every pixel the wiki does NOT paint composites down onto the SHELL's canvas — which, with no
background and no `color-scheme` of its own, is Chromium's default white.

The page scrollbar is exactly such a gap. A theme that asks for a transparent scrollbar track
(`html { scrollbar-color: <thumb> transparent; }`) gets the wiki's dark background behind every
scrollbar INSIDE the page, but a white stripe down the window edge for the page scrollbar itself:
the wiki's canvas covers the content box, not the scrollbar gutter, and the shell showed through
there. Measured against NW.js 0.114 (Chromium 151): the track sampled #ffffff; painting the shell
magenta turned the track magenta; giving the shell root `color-scheme: dark` turned it #121212. The
scrollbar was obeying the wiki all along — only the backdrop was wrong.

So the shell copies the wiki's used colour scheme and canvas colour onto its own root element, and
re-copies whenever the wiki's stylesheet changes (a palette switch is exactly that). Until the wiki
has painted, the shell's own `color-scheme: light dark` keeps that gap following the OS rather than
flashing white.

This is deliberately NOT coupled to the framed wiki's `$tw`: the shell must work for whatever
TiddlyWiki version the wiki carries, and computed style plus a DOM watch says everything needed.
*/

"use strict";

var TRANSPARENT = "rgba(0, 0, 0, 0)";

// The wiki's canvas colour. TiddlyWiki paints it on <body>, but a theme may put it on <html>
// instead, and either one propagates to the canvas — so prefer whichever is actually painted.
function canvasColour(win,doc) {
	var rootColour = win.getComputedStyle(doc.documentElement).backgroundColor;
	if(rootColour && rootColour !== TRANSPARENT) {
		return rootColour;
	}
	var bodyColour = doc.body && win.getComputedStyle(doc.body).backgroundColor;
	return (bodyColour && bodyColour !== TRANSPARENT) ? bodyColour : "";
}

/*
	iframe        - the shell's wiki iframe, already loaded
	hostDocument  - the shell document to paint

Returns a handle with a teardown(), or null if there is nothing to do. Safe to call again on the
next iframe load, provided the previous handle was torn down first.
*/
exports.install = function(options) {
	options = options || {};
	var iframe = options.iframe,
		hostDocument = options.hostDocument;
	if(!iframe || !hostDocument || !hostDocument.documentElement) {
		return null;
	}
	var hostRoot = hostDocument.documentElement,
		observer = null,
		timer = null;
	function apply() {
		try {
			var doc = iframe.contentDocument,
				win = iframe.contentWindow;
			if(!doc || !win || !doc.documentElement) {
				return;
			}
			var scheme = win.getComputedStyle(doc.documentElement).colorScheme;
			// Cleared rather than pinned to "light" when the wiki expresses no preference: that
			// falls back to the shell's own `color-scheme: light dark`, so such a wiki follows the
			// OS instead of forcing a light gutter onto a dark desktop.
			hostRoot.style.colorScheme = (scheme && scheme !== "normal") ? scheme : "";
			hostRoot.style.backgroundColor = canvasColour(win,doc);
		} catch(e) {}
	}
	function schedule() {
		if(timer) {
			return;
		}
		timer = setTimeout(function() {
			timer = null;
			apply();
		},50);
	}
	apply();
	// A palette or theme switch reaches the DOM as a rewrite of TiddlyWiki's stylesheet <style>
	// element, so watch the wiki's <head>. TiddlyWiki rewrites that text only when the rendered
	// stylesheet actually changes, so this stays quiet through ordinary editing; the debounce
	// coalesces the burst a single switch produces.
	try {
		var contentWindow = iframe.contentWindow,
			contentDocument = iframe.contentDocument;
		if(contentWindow && contentWindow.MutationObserver && contentDocument && contentDocument.head) {
			observer = new contentWindow.MutationObserver(schedule);
			observer.observe(contentDocument.head,{childList: true, subtree: true, characterData: true});
		}
	} catch(e) {}
	return {
		teardown: function() {
			if(timer) {
				clearTimeout(timer);
				timer = null;
			}
			try {
				if(observer) {
					observer.disconnect();
				}
			} catch(e) {}
			observer = null;
			// Reset, so an in-place reload does not show the previous wiki's colours behind the
			// next one while it boots.
			try {
				hostRoot.style.colorScheme = "";
				hostRoot.style.backgroundColor = "";
			} catch(e) {}
		}
	};
};
