/*
Cross-browser drag-drop import interceptor.

Works around Chromium's cross-app drag-data sanitiser on Linux, which strips
custom MIME types (text/vnd.tiddler) and most standards (text/uri-list etc.)
when a drag crosses application boundaries. In practice only text/plain and
text/html survive. TiddlyWiki sources publish the data:text/vnd.tiddler URI
inside both a custom MIME and (after the upstream patch) the href of an
anchor in text/html — this interceptor finds the URI in whichever channel
survived and dispatches tm-import-tiddlers on the wiki's navigator widget so
the standard $:/Import preview opens.

Installed on the iframe document of each wiki-file window, and on the
document of wiki-folder windows, by their respective host scripts.
*/

"use strict";

var DATA_URI_RE = /^data:text\/vnd\.tiddler,(.*)$/i;

// MIME types TiddlyWiki sources publish, plus standards Chromium sometimes
// exposes via getData() without listing in dataTransfer.types[]. We probe
// these explicitly so the receiver isn't tied to Chromium's enumeration.
var PROBE_TYPES = [
	"text/uri-list",
	"text/x-moz-url",
	"URL",
	"text/vnd.tiddler",
	"text/html",
	"application/json",
	"application/vnd.tiddler+json",
	"text/json",
	"Text",
	"text/plain"
];

// Chromium on Linux hands text/html to JS as UTF-16LE bytes interpreted as
// Latin-1: every "real" character is followed by a null. Detect this
// shape and decode back to a normal JS string before pattern-matching.
function maybeDecodeUtf16(raw) {
	if(!raw || raw.length < 4) { return raw; }
	var sample = Math.min(raw.length, 64),
		nulls = 0;
	for(var i = 1; i < sample; i += 2) {
		if(raw.charCodeAt(i) === 0) { nulls++; }
	}
	if(nulls < Math.floor(sample / 2) * 0.8) { return raw; }
	if(typeof TextDecoder !== "undefined") {
		try {
			var bytes = new Uint8Array(raw.length);
			for(var k = 0; k < raw.length; k++) { bytes[k] = raw.charCodeAt(k) & 0xff; }
			return new TextDecoder("utf-16le").decode(bytes).replace(/^﻿/, "");
		} catch(e) {}
	}
	var out = "";
	for(var j = 0; j < raw.length; j += 2) { out += raw.charAt(j); }
	return out;
}

function tryDecodeTiddlerPayload(raw, type) {
	if(!raw) { return null; }
	raw = maybeDecodeUtf16(raw);
	var candidates = (type === "text/uri-list" || type === "text/x-moz-url")
		? raw.split(/\r?\n/)
		: [raw];
	for(var c = 0; c < candidates.length; c++) {
		var line = candidates[c];
		if(!line || line.charAt(0) === "#") { continue; }
		// Find a data:text/vnd.tiddler URI either as the entire line (text/uri-list,
		// text/x-moz-url) or embedded inside markup (text/html). Match on the still-
		// URI-encoded form so JSON %22 doesn't truncate the capture; the stop-class
		// excludes characters that cannot legally appear in a URI-encoded payload.
		var encMatch = line.match(/^data:text\/vnd\.tiddler,(.*)$/i)
			|| line.match(/data:text\/vnd\.tiddler,([^"'<>\s)]+)/i);
		if(encMatch) {
			try {
				var parsed = JSON.parse(decodeURIComponent(encMatch[1]));
				return Array.isArray(parsed) ? parsed : [parsed];
			} catch(e) {}
		}
		// Or the line itself is raw JSON (legacy text/vnd.tiddler, an array of
		// tiddler fields, or our self-identifying envelope).
		if(line.charAt(0) === "{" || line.charAt(0) === "[") {
			try {
				var rawParsed = JSON.parse(line);
				if(rawParsed && typeof rawParsed === "object" && !Array.isArray(rawParsed) &&
					rawParsed.__type === "text/vnd.tiddler" && rawParsed.fields) {
					return Array.isArray(rawParsed.fields) ? rawParsed.fields : [rawParsed.fields];
				}
				return Array.isArray(rawParsed) ? rawParsed : [rawParsed];
			} catch(e) {}
		}
	}
	return null;
}

function extractTiddlerFields(dataTransfer) {
	if(!dataTransfer) { return null; }
	var enumerated = [];
	try {
		for(var i = 0; i < (dataTransfer.types ? dataTransfer.types.length : 0); i++) {
			enumerated.push(dataTransfer.types[i]);
		}
	} catch(e) {}
	var allTypes = enumerated.slice();
	PROBE_TYPES.forEach(function(t) {
		if(allTypes.indexOf(t) === -1) { allTypes.push(t); }
	});
	for(var k = 0; k < allTypes.length; k++) {
		var raw;
		try {
			raw = dataTransfer.getData(allTypes[k]);
		} catch(e) {
			continue;
		}
		if(!raw) { continue; }
		var fields = tryDecodeTiddlerPayload(raw, allTypes[k]);
		if(fields) { return fields; }
	}
	return null;
}

// Widget.dispatchEvent walks UP via parentWidget; dispatching on $tw.rootWidget
// bubbles nowhere because there's no parent. The handler for tm-import-tiddlers
// lives on the navigator widget, which is a descendant — so we walk down to
// find a widget that registered the handler, then dispatch at that level.
function findEventHandlerWidget(widget, eventType) {
	if(!widget) { return null; }
	if(widget.eventListeners && widget.eventListeners[eventType]) {
		return widget;
	}
	if(widget.children) {
		for(var i = 0; i < widget.children.length; i++) {
			var found = findEventHandlerWidget(widget.children[i], eventType);
			if(found) { return found; }
		}
	}
	return null;
}

function makeDropHandler(getContentWindow) {
	return function(event) {
		var target = event.target;
		if(target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
			return;
		}
		var dataTransfer = event.dataTransfer;
		if(dataTransfer && dataTransfer.files && dataTransfer.files.length > 0) {
			return;
		}
		var tiddlerFields = extractTiddlerFields(dataTransfer);
		if(!tiddlerFields) { return; }
		var contentWindow = getContentWindow();
		var tw = contentWindow && contentWindow.$tw;
		if(!tw || !tw.rootWidget) { return; }
		var handlerWidget = findEventHandlerWidget(tw.rootWidget, "tm-import-tiddlers");
		if(!handlerWidget) { return; }
		event.preventDefault();
		event.stopPropagation();
		handlerWidget.dispatchEvent({
			type: "tm-import-tiddlers",
			param: JSON.stringify(tiddlerFields),
			importTitle: "$:/Import",
			paramObject: {importTitle: "$:/Import"}
		});
	};
}

function attachToDoc(doc, getContentWindow) {
	doc.addEventListener("dragover", function(e) { e.preventDefault(); }, true);
	doc.addEventListener("drop", makeDropHandler(getContentWindow), true);
}

exports.installImportInterceptor = function(doc, contentWindow, options) {
	options = options || {};
	if(!doc) { return; }
	var get = function() { return contentWindow; };
	var attachIframe = function() {
		try { attachToDoc(doc, get); } catch(e) {}
	};
	if(doc.body) {
		attachIframe();
	} else {
		var win = contentWindow || doc.defaultView;
		if(win) {
			win.addEventListener("DOMContentLoaded", attachIframe, {once: true});
		}
	}
	if(options.parentDocument) {
		try { attachToDoc(options.parentDocument, get); } catch(e) {}
	}
};
