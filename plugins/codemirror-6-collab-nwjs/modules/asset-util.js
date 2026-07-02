/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/asset-util.js
type: application/javascript
module-type: library

Helpers for sharing external-attachment assets (the file a tiddler's _canonical_uri
points at) over collaboration.

File I/O works in two contexts: folder wikis use Node fs directly; single-file wikis
(nwdisable iframe, no Node) go through the parent file bridge in wiki-file-window.js
(window._nwjsFileCmdQueue / _nwjsFileResults / _nwjsWikiDir). All path maths is pure
JavaScript so it needs neither Node nor the bridge.

Where a received asset lands, and whether _canonical_uri records it relatively or
absolutely, follows the External Attachments plugin's own settings:
  $:/config/ExternalAttachments/Enable                       (no => embed inline)
  $:/config/ExternalAttachments/UseAbsoluteForDescendents
  $:/config/ExternalAttachments/UseAbsoluteForNonDescendents
\*/

"use strict";

var nodeFs, nodePath;
try { nodeFs = require("fs"); } catch(e) {}
try { nodePath = require("path"); } catch(e) {}

var ENABLE   = "$:/config/ExternalAttachments/Enable";
var ABS_DESC = "$:/config/ExternalAttachments/UseAbsoluteForDescendents";
var ABS_NON  = "$:/config/ExternalAttachments/UseAbsoluteForNonDescendents";
var MAX_MB   = "$:/config/codemirror-6-collab/max-asset-mb";

// Configured maximum asset size, in bytes (default 25 MB).
exports.maxAssetBytes = function() {
	var mb = parseFloat($tw.wiki.getTiddlerText(MAX_MB, "25"));
	if(!isFinite(mb) || mb <= 0) { mb = 25; }
	return mb * 1024 * 1024;
};

// Store received assets as real files only when the External Attachments plugin is
// installed AND enabled; otherwise embed them inline in the tiddler.
exports.storeExternally = function() {
	return !!$tw.wiki.getTiddler("$:/plugins/tiddlywiki/external-attachments")
		&& $tw.wiki.getTiddlerText(ENABLE, "no") === "yes";
};

// Is this tiddler type binary (its text field holds base64-encoded bytes)?
exports.isBinaryType = function(type) {
	var info = $tw.config.contentTypeInfo[type || ""];
	return !!(info && info.encoding === "base64");
};

// A reasonable download filename for an embedded binary tiddler that has no
// _canonical_uri: the (sanitised) title plus the type's extension.
exports.assetFileName = function(title, type) {
	var info = $tw.config.contentTypeInfo[type || ""];
	var ext  = (info && info.extension) || "";
	var base = String(title).replace(/[\/\\:*?"<>|]+/g, "_");
	if(ext && base.slice(-ext.length).toLowerCase() !== ext.toLowerCase()) { base += ext; }
	return base;
};

// A _canonical_uri references a LOCAL file (whose bytes must be transferred) when it
// is a relative path or a file:// URL. http(s):// and data: are not local.
exports.isLocalCanonicalUri = function(uri) {
	if(!uri) { return false; }
	uri = String(uri);
	if((/^https?:\/\//i).test(uri)) { return false; }
	if((/^data:/i).test(uri)) { return false; }
	return true;
};

// ── pure-JS path helpers (forward-slash) ───────────────────────────────────────

function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""); }

function fromFileUrl(u) {
	u = String(u || "");
	if((/^file:\/\//i).test(u)) { u = u.replace(/^file:\/\//i, ""); }
	// A _canonical_uri is a URI: TiddlyWiki's external-attachments URL-encodes it (a space becomes
	// %20, etc.), so decode it back to a real filesystem path. This must apply to RELATIVE paths
	// too — previously only file:// URLs were decoded, so a relative attachment with a space stayed
	// "Screenshot%20bla.png" and could neither be read nor written (and showed encoded in the UI).
	try { return decodeURI(u); } catch(e) { return u; }
}
exports.fromFileUrl = fromFileUrl;

function isAbsolute(p) { p = norm(p); return (/^\//).test(p) || (/^[a-zA-Z]:\//).test(p); }

function basename(p) { p = norm(fromFileUrl(p)); return p.slice(p.lastIndexOf("/") + 1); }
exports.basename = basename;

// The wiki's base directory: folder wikis -> $tw.boot.wikiPath; single-file wikis ->
// window._nwjsWikiDir (set by the parent bridge).
function wikiDir() {
	if($tw.boot && $tw.boot.wikiPath) { return $tw.boot.wikiPath; }
	try { if(window._nwjsWikiDir) { return window._nwjsWikiDir; } } catch(e) {}
	return "";
}
exports.wikiDir = wikiDir;

// Relative path from -> to (both absolute, forward-slash). Pure JS, no Node.
function relativePath(from, to) {
	var a = norm(from).split("/"), b = norm(to).split("/"), i = 0;
	while(i < a.length && i < b.length && a[i] === b[i]) { i++; }
	var up = [];
	for(var j = i; j < a.length; j++) { up.push(".."); }
	return up.concat(b.slice(i)).join("/") || ".";
}

function isInside(child, parent) {
	child = norm(child); parent = norm(parent);
	return !!parent && (child === parent || child.indexOf(parent + "/") === 0);
}

// Given the absolute path the receiver saved the asset to, build the _canonical_uri
// to record, honouring the External Attachments relative/absolute settings.
exports.canonicalUriForPath = function(absPath) {
	// Android: the file bridge already returns a WIKI-RELATIVE _canonical_uri (e.g.
	// "./attachments/foo.png") for both single-file wikis (content:// wikiDir) and folder wikis
	// (local-mirror wikiDir). Use it verbatim — running relativePath against the wikiDir produces
	// garbage like "../../../../attachments/foo.png". On desktop writeAsset always returns an
	// ABSOLUTE fs path, so a leading "./"/"../" never occurs there — desktop behaviour is unchanged.
	if((/^\.\.?\//).test(String(absPath))) { return String(absPath); }
	var base = norm(wikiDir());
	var descendant = isInside(absPath, base);
	// Defaults mirror sensible plugin behaviour: relative inside the wiki, absolute
	// outside it (a relative path out of the tree is fragile).
	var useAbsolute = $tw.wiki.getTiddlerText(descendant ? ABS_DESC : ABS_NON, descendant ? "no" : "yes") === "yes";
	if(useAbsolute || !base) { return "file://" + encodeURI(norm(absPath)); }
	// Encode the relative form too, so the stored _canonical_uri is a proper URI (matching how TW
	// external-attachments records them) — it round-trips through fromFileUrl's decode and renders
	// correctly as an <img>/link src.
	return encodeURI(relativePath(base, norm(absPath)));
};

// ── file I/O (Node fs in folder wikis, parent bridge in single-file wikis) ──────

function bridgeCmd(cmd, cb) {
	try {
		if(!window._nwjsFileCmdQueue || !window._nwjsFileResults) { cb("no file access in this wiki"); return; }
		var id = "f" + Date.now() + Math.random().toString(36).slice(2, 8);
		cmd.id = id;
		window._nwjsFileCmdQueue.push(cmd);
		var tries = 0;
		var timer = setInterval(function() {
			var r = window._nwjsFileResults[id];
			if(r) { clearInterval(timer); delete window._nwjsFileResults[id]; cb(r.err || null, r.data); }
			else if(++tries > 1200) { clearInterval(timer); cb("file bridge timeout"); }
		}, 100);
	} catch(e) { cb((e && e.message) || String(e)); }
}

// Resolve a _canonical_uri (relative / absolute / file://) to an absolute fs path.
exports.resolveCanonical = function(uri) {
	var p = fromFileUrl(uri);
	if(isAbsolute(p)) { return norm(p); }
	var base = norm(wikiDir());
	return base ? base + "/" + norm(p) : norm(p);
};

// Read an asset's bytes as base64. cb(err, base64).
exports.readAsset = function(canonicalUri, cb) {
	if(nodeFs) {
		try {
			nodeFs.readFile(exports.resolveCanonical(canonicalUri), function(err, buf) {
				cb(err && err.message, err ? null : buf.toString("base64"));
			});
		} catch(e) { cb((e && e.message) || String(e)); }
	} else {
		bridgeCmd({op: "read", path: canonicalUri}, cb);
	}
};

// Write base64 bytes to an absolute path. cb(err, absPathWritten).
exports.writeAsset = function(absPath, base64, cb) {
	if(nodeFs) {
		try {
			if(nodePath) { try { nodeFs.mkdirSync(nodePath.dirname(absPath), {recursive: true}); } catch(e) {} }
			nodeFs.writeFile(absPath, Buffer.from(base64, "base64"), function(err) {
				cb(err && err.message, err ? null : absPath);
			});
		} catch(e) { cb((e && e.message) || String(e)); }
	} else {
		bridgeCmd({op: "write", path: absPath, base64: base64}, cb);
	}
};
