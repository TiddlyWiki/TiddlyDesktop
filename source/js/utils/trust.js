/*
Per-wiki trusted-path store.

A wiki may read a path on disk only if that path is trusted for THAT wiki. This module owns the
records; callers decide what to do with the answer. Today the only consumer is the file bridge in
wiki-file-window.js; the attachment server will be the second (see DESIGN-http-wiki-origin.md),
which is why the policy lives here rather than inside either of them.

Where the records live, and why it matters
------------------------------------------
In the BACKSTAGE wiki. That placement is the security boundary, not a filing preference: a wiki can
write its own tiddlers, so records kept inside the wiki would let a hostile wiki grant itself access
to anything. The backstage wiki is ours and the wiki cannot write to it. It also carries the
filesystem plugin, so grants persist across restarts for free, and Settings can list and revoke
them.

One tiddler per grant, titled with a hash of the path so it is stable and collision-free:

	$:/TiddlyDesktop/Config/trusted-paths/<wiki-id>/<sha1-16>
		wiki:        the wiki identifier
		trust-path:  the absolute path
		trust-kind:  "file" (exactly that file) or "dir" (that folder and everything under it)

One tiddler per grant rather than a list in one tiddler, so the Settings UI is a plain $list and
revoking is a plain $action-deletetiddler — no JSON parsing in wikitext, and no filter-escaping
hazard from paths that contain "]".

Keying by pathname (the `wikifile://` / `wikifolder://` identifiers WindowList already produces)
means a moved wiki loses its grants and a copied wiki does not inherit them — both correct. A UUID
stored inside the wiki would survive moves but would let a wiki adopt another wiki's identity.

Prefer "file". A "dir" grant hands the wiki everything readable underneath it, so it is an
explicit user choice rather than a default.
*/

"use strict";

var path = require("path"),
	crypto = require("crypto");

var PREFIX = "$:/TiddlyDesktop/Config/trusted-paths/";

exports.PREFIX = PREFIX;

/*
Normalise for storage and comparison. Paths compare literally (case-sensitively) on POSIX; on
Windows and macOS the filesystem is conventionally case-insensitive, so fold there — a grant the
user made through a picker must still match the path the wiki later asks for.
*/
function normalise(p) {
	if(!p) { return ""; }
	var abs = path.resolve(String(p));
	return (process.platform === "win32" || process.platform === "darwin") ? abs.toLowerCase() : abs;
}
exports.normalise = normalise;

// Title of the tiddler recording one grant. The hash keeps the title stable for a given path and
// free of characters that would need escaping; the real path lives in a field.
function grantTitle(identifier, absPath) {
	var h = crypto.createHash("sha1").update(normalise(absPath)).digest("hex").slice(0, 16);
	return PREFIX + identifier + "/" + h;
}
exports.grantTitle = grantTitle;

/*
Is `child` inside `parent` (or the same path)? Segment-wise, never a string prefix: a bare
startsWith would treat "/home/u/wikis-evil" as inside "/home/u/wikis". An ABSOLUTE result from
path.relative means the two are unrelatable — on Windows, a different drive — which is also
"outside".
*/
function isInside(parent, child) {
	var rel = path.relative(parent, child);
	if(rel === "") { return true; }
	if(path.isAbsolute(rel)) { return false; }
	return rel.split(path.sep)[0] !== "..";
}
exports.isInside = isInside;

/*
Every grant recorded for one wiki, as [{title, path, kind}]. Iterates rather than using a filter
string, because a path may contain characters that would need escaping in filter syntax. A record
missing its fields is skipped, so a damaged tiddler denies access instead of throwing.
*/
function list(identifier) {
	var out = [];
	try {
		$tw.wiki.forEachTiddler(function(title, tiddler) {
			if(title.indexOf(PREFIX) !== 0) { return; }
			var f = tiddler.fields;
			if(f.wiki !== identifier) { return; }
			if(typeof f["trust-path"] !== "string" || !f["trust-path"]) { return; }
			var kind = f["trust-kind"] === "dir" ? "dir" : "file";
			out.push({title: title, path: f["trust-path"], kind: kind});
		});
	} catch(e) {
		console.error("[TiddlyDesktop] could not read trusted paths:", e && e.message);
		return [];
	}
	return out;
}
exports.list = list;

/*
Is `absPath` trusted for this wiki? True when it is exactly a granted file, or inside a granted
directory. `extraRoots` are paths the CALLER trusts implicitly without a stored grant — the wiki's
own directory, in practice, since a wiki can already write there through the saver.
*/
function isTrusted(identifier, absPath, extraRoots) {
	var target = normalise(absPath);
	if(!target) { return false; }
	var roots = extraRoots || [];
	for(var i = 0; i < roots.length; i++) {
		if(roots[i] && isInside(normalise(roots[i]), target)) { return true; }
	}
	var entries = list(identifier);
	for(var j = 0; j < entries.length; j++) {
		var p = normalise(entries[j].path);
		if(entries[j].kind === "file" ? p === target : isInside(p, target)) { return true; }
	}
	return false;
}
exports.isTrusted = isTrusted;

/*
Record a grant. `kind` is "file" or "dir". Returns true if anything changed.

Idempotent: a path already covered records nothing. A directory grant additionally absorbs the
narrower grants it now covers, so the Settings list does not accumulate redundant entries.
*/
function grant(identifier, absPath, kind) {
	var target = normalise(absPath);
	if(!target || (kind !== "file" && kind !== "dir")) { return false; }
	var entries = list(identifier);
	// Already covered by an equal-or-wider grant?
	for(var i = 0; i < entries.length; i++) {
		var p = normalise(entries[i].path);
		if(entries[i].kind === "dir" && isInside(p, target)) { return false; }
		if(entries[i].kind === "file" && kind === "file" && p === target) { return false; }
	}
	if(kind === "dir") {
		// Drop the grants this directory now subsumes.
		entries.forEach(function(e) {
			if(isInside(target, normalise(e.path))) {
				try { $tw.wiki.deleteTiddler(e.title); } catch(err) {}
			}
		});
	}
	var abs = path.resolve(String(absPath));
	$tw.wiki.addTiddler(new $tw.Tiddler({
		title: grantTitle(identifier, abs),
		wiki: identifier,
		"trust-path": abs,
		"trust-kind": kind,
		text: ""
	}));
	console.log("[TiddlyDesktop] trusted", kind, abs, "for", identifier);
	return true;
}
exports.grant = grant;

// Remove the grant for exactly this path. Returns true if something was removed.
function revoke(identifier, absPath) {
	var target = normalise(absPath), removed = false;
	list(identifier).forEach(function(e) {
		if(normalise(e.path) === target) {
			try { $tw.wiki.deleteTiddler(e.title); removed = true; } catch(err) {}
		}
	});
	if(removed) { console.log("[TiddlyDesktop] revoked", target, "for", identifier); }
	return removed;
}
exports.revoke = revoke;

// Drop every grant for a wiki — used when a wiki is removed from the list, so a later wiki at the
// same path does not silently inherit them.
function revokeAll(identifier) {
	list(identifier).forEach(function(e) {
		try { $tw.wiki.deleteTiddler(e.title); } catch(err) {}
	});
}
exports.revokeAll = revokeAll;
