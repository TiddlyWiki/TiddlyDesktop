/*
In-wiki UI for granting trust to an attachment's location.

Phase 6 of DESIGN-http-wiki-origin.md.

An attachment stored outside the wiki folder is only served once the user has trusted its path
(see utils/trust.js). Before this, the only way to create a grant was to add the file again —
fine for new attachments, useless for the ones already in a wiki. This puts the offer where the
problem appears: on the tiddler itself, naming the exact path.

Who does what
-------------
The PARENT decides and mints; the wiki only displays and asks.

  parent   works out which visible attachments are untrusted (it alone knows the paths and the
           grants), writes a $:/temp marker per affected tiddler, and injects a view template
  wiki     renders the panel when a marker exists, and on a click writes a REQUEST tiddler
  parent   sees the request, opens a file/directory picker it owns, and grants what the user
           actually selects

Requesting is deliberately not a privilege. A wiki can write the request tiddler itself and make
a picker appear — annoying, not dangerous, because nothing is granted until the user selects
something in a dialog the parent opened and reads. That is the same unforgeable mechanism used by
grant-on-add and the save dialog: script cannot set a file input's value.

Everything injected lives under $:/temp/, which $:/config/SaverFilter excludes, so none of it is
written into the user's wiki file.

And none of it is a security control. A wiki can delete the template, fake a marker, or lie about
a path — it only misleads itself. The attachment server decides what it serves.
*/

"use strict";

var path = require("path"),
	trust = require("./trust.js"),
	attachments = require("./attachments.js");

var TEMPLATE_TITLE = "$:/temp/TiddlyDesktop/AttachmentTrustTemplate",
	MARKER_PREFIX = "$:/temp/TiddlyDesktop/untrusted/",
	REQUEST_TITLE = "$:/temp/TiddlyDesktop/trust-request";

exports.MARKER_PREFIX = MARKER_PREFIX;
exports.REQUEST_TITLE = REQUEST_TITLE;

// The panel shown on a tiddler whose attachment is not yet trusted. Kept deliberately plain: it
// has to read as an explanation, not an error.
var TEMPLATE_TEXT = [
	'<$list filter="[[' + MARKER_PREFIX + ']addsuffix<currentTiddler>is[tiddler]]" variable="tdMarker">',
	'<div class="td-untrusted-attachment" style="border:1px solid #d0a000;background:#fffbe6;padding:12px;margin:8px 0;border-radius:4px">',
	"<p style=\"margin:0 0 6px\"><strong>This attachment's location isn't trusted yet</strong>, so it can't be shown.</p>",
	'<p style="margin:0 0 8px"><code><$text text={{{ [<tdMarker>get[trust-path]] }}}/></code></p>',
	'<$button class="tc-btn-invisible" style="border:1px solid #999;padding:3px 10px;margin-right:6px;border-radius:3px">',
	'<$action-setfield $tiddler="' + REQUEST_TITLE + '" path={{{ [<tdMarker>get[trust-path]] }}} kind="file" nonce=<<now [UTC]YYYY0MM0DD0hh0mm0ssXXX>>/>',
	"Trust this file",
	"</$button>",
	'<$button class="tc-btn-invisible" style="border:1px solid #999;padding:3px 10px;border-radius:3px">',
	'<$action-setfield $tiddler="' + REQUEST_TITLE + '" path={{{ [<tdMarker>get[trust-path]] }}} kind="dir" nonce=<<now [UTC]YYYY0MM0DD0hh0mm0ssXXX>>/>',
	"Trust this folder",
	"</$button>",
	'<p style="margin:8px 0 0;font-size:0.85em;color:#666">Trusting a folder lets this wiki read everything inside it. You can withdraw either in Settings &rarr; Trusted paths.</p>',
	"</div>",
	"</$list>"
].join("\n");

/*
	doc/win  the wiki's document and window
	options  {identifier, wikiDir, openPicker(kind, seedPath, cb)}

`openPicker` is supplied by the caller because only it can create an input in the parent's own
document; cb receives the selected path or null.
*/
exports.install = function(doc, win, options) {
	var tw = null;
	try { tw = win && win.$tw; } catch(e) { tw = null; }
	if(!tw || !tw.wiki) { return null; }
	var identifier = options.identifier,
		wikiDir = options.wikiDir,
		openPicker = options.openPicker;

	// Inject the template once per document load.
	try {
		tw.wiki.addTiddler(new tw.Tiddler({
			title: TEMPLATE_TITLE,
			tags: "$:/tags/ViewTemplate",
			text: TEMPLATE_TEXT
		}));
	} catch(e) {
		console.error("[TiddlyDesktop] could not inject the trust template:", e && e.message);
		return null;
	}

	// Every tiddler with a local _canonical_uri, as [{title, abs}].
	function localAttachments() {
		var out = [];
		try {
			tw.wiki.each(function(tiddler, title) {
				if(!tiddler || title.indexOf("$:/temp/") === 0) { return; }
				var uri = tiddler.fields && tiddler.fields._canonical_uri;
				if(!uri) { return; }
				var abs = attachments.resolveCanonicalUri(uri, wikiDir);
				if(abs) { out.push({title: title, abs: abs}); }
			});
		} catch(e) {}
		return out;
	}

	// Mark the untrusted ones and clear markers that no longer apply. Runs on load and whenever
	// the wiki changes, so a grant makes the panel disappear without a reload.
	function refresh() {
		var wanted = Object.create(null);
		localAttachments().forEach(function(item) {
			if(!trust.isTrusted(identifier, item.abs, [wikiDir])) {
				wanted[MARKER_PREFIX + item.title] = item.abs;
			}
		});
		var existing = [];
		try {
			tw.wiki.each(function(tiddler, title) {
				if(title.indexOf(MARKER_PREFIX) === 0) { existing.push(title); }
			});
		} catch(e) {}
		existing.forEach(function(title) {
			if(!(title in wanted)) {
				try { tw.wiki.deleteTiddler(title); } catch(e) {}
			}
		});
		Object.keys(wanted).forEach(function(title) {
			try {
				var cur = tw.wiki.getTiddler(title);
				if(cur && cur.fields["trust-path"] === wanted[title]) { return; }
				tw.wiki.addTiddler(new tw.Tiddler({title: title, "trust-path": wanted[title], text: ""}));
			} catch(e) {}
		});
	}

	// A click wrote the request tiddler. Open the picker the parent owns, seeded at the path in
	// question, and grant whatever the user actually selects — which may be something else
	// entirely, and that is fine: what they picked is what they consented to.
	var lastNonce = null;
	function handleRequest() {
		var req = null;
		try { req = tw.wiki.getTiddler(REQUEST_TITLE); } catch(e) {}
		if(!req) { return; }
		var nonce = req.fields.nonce || "";
		if(nonce === lastNonce) { return; }
		lastNonce = nonce;
		var wanted = String(req.fields.path || ""),
			kind = req.fields.kind === "dir" ? "dir" : "file";
		if(!wanted || typeof openPicker !== "function") { return; }
		var seed = kind === "dir" ? wanted : path.dirname(wanted);
		openPicker(kind, seed, function(chosen) {
			if(!chosen) { return; }
			trust.grant(identifier, chosen, kind);
			refresh();
		});
	}

	var onChange = function(changes) {
		if(changes && changes[REQUEST_TITLE]) { handleRequest(); }
		refresh();
	};
	try { tw.wiki.addEventListener("change", onChange); } catch(e) {}

	refresh();

	return {
		refresh: refresh,
		teardown: function() {
			try { tw.wiki.removeEventListener("change", onChange); } catch(e) {}
		}
	};
};
