/*
Per-window loopback HTTP server.

Phase 4 of DESIGN-http-wiki-origin.md. Each wiki window gets its own server on an OS-assigned
port, serving two things from one origin:

	/__tiddlydesktop_shell__/<token>/…   the app's own files (the window shell)
	/wiki/<token>/…                      the wiki file and its directory

Why this shape
--------------
Node access is granted by `node-remote` in source/package.json, whose value is

	http://127.0.0.1:<*>/__tiddlydesktop_shell__/<*>

where <*> is a literal asterisk — written that way here only because an asterisk followed by a
slash would close this comment.

`node-remote` matches on PATH, which is what lets the port be OS-assigned: the port wildcard is
safe because the path carries the scoping. Measured against NW.js 0.114 — the shell path gets full
Node while a sibling path on the SAME origin gets none. Other forms were tried and rejected: an
array of patterns crashes when granting a second window, host wildcards crash, and space-separated
patterns silently match nothing.

So the shell has Node and the wiki, one path segment away on the same origin, does not. Sharing an
origin is deliberate — it keeps the parent's cross-document access to the wiki working — and is
safe only because the wiki iframe carries `nwdisable nwfaketop`. Both attributes are required; see
the comment in html/wiki-file-window.html.

The `<token>` is a per-window random segment. Any local process can reach a loopback port, so
without it another program on the machine could read the user's wiki (and, worse, fetch the shell
path, which is Node-eligible). It sits INSIDE the shell prefix so `node-remote` still matches.

Containment
-----------
Requests are resolved and then checked to be inside the directory they claim to be in, segment-wise
(never a string prefix, and rejecting the absolute path that path.relative returns for a foreign
Windows drive). Symlinks are resolved before the check, so a link inside the wiki folder cannot
point out of it.
*/

"use strict";

var http = require("http"),
	fs = require("fs"),
	path = require("path"),
	crypto = require("crypto"),
	trust = require("./trust.js");

var SHELL_PREFIX = "/__tiddlydesktop_shell__/";

exports.SHELL_PREFIX = SHELL_PREFIX;

// Content types for what we actually serve. Anything unlisted is sent as octet-stream, which the
// browser will download rather than execute — the safe default for unexpected files.
var TYPES = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".ogg": "audio/ogg",
	".pdf": "application/pdf",
	".txt": "text/plain; charset=utf-8",
	".tid": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8"
};

function contentType(file) {
	return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// Resolve a URL path under `root`, or null if it escapes. realpath first so a symlink inside the
// directory cannot point outside it; a missing file falls back to the lexical path so the caller
// can answer 404 rather than 500.
function resolveWithin(root, relUrlPath) {
	var decoded;
	try { decoded = decodeURIComponent(relUrlPath); } catch(e) { return null; }
	if(decoded.indexOf("\0") !== -1) { return null; }
	var target = path.resolve(root, "." + (decoded.charAt(0) === "/" ? decoded : "/" + decoded));
	var realRoot, realTarget;
	try { realRoot = fs.realpathSync(root); } catch(e) { realRoot = root; }
	try { realTarget = fs.realpathSync(target); } catch(e) { realTarget = target; }
	if(!trust.isInside(realRoot, realTarget)) { return null; }
	return target;
}

function sendFile(res, file, method) {
	fs.stat(file, function(err, stats) {
		if(err || !stats.isFile()) {
			res.writeHead(404, {"Content-Type": "text/plain"});
			res.end("Not found");
			return;
		}
		var headers = {
			"Content-Type": contentType(file),
			"Content-Length": stats.size,
			// Nothing here is meant for another origin to read.
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store"
		};
		if(method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
		res.writeHead(200, headers);
		var stream = fs.createReadStream(file);
		stream.on("error", function() { try { res.destroy(); } catch(e) {} });
		stream.pipe(res);
	});
}

/*
Start a server for one wiki window.

	options.appDir   the application directory (source/), whose html/ and js/ the shell needs
	options.wikiDir  the directory containing the wiki file
	options.wikiFile the wiki file's basename

cb(err, handle) where handle is:
	{origin, token, shellUrl, wikiUrl, isShellUrl(url), close()}
*/
exports.start = function(options, cb) {
	var appDir = options.appDir,
		wikiDir = options.wikiDir,
		wikiFile = options.wikiFile,
		token = crypto.randomBytes(16).toString("hex");

	var shellBase = SHELL_PREFIX + token + "/",
		wikiBase = "/wiki/" + token + "/";

	var server = http.createServer(function(req, res) {
		if(req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, {"Content-Type": "text/plain"});
			res.end("Method not allowed");
			return;
		}
		var urlPath;
		try { urlPath = req.url.split("?")[0].split("#")[0]; } catch(e) { urlPath = ""; }
		var root = null, rel = null;
		if(urlPath.indexOf(shellBase) === 0) {
			root = appDir;
			rel = urlPath.slice(shellBase.length - 1);
		} else if(urlPath.indexOf(wikiBase) === 0) {
			root = wikiDir;
			rel = urlPath.slice(wikiBase.length - 1);
		} else {
			// Includes a correct prefix with the WRONG token, which must be indistinguishable
			// from a path that does not exist.
			res.writeHead(404, {"Content-Type": "text/plain"});
			res.end("Not found");
			return;
		}
		var file = resolveWithin(root, rel);
		if(!file) {
			res.writeHead(403, {"Content-Type": "text/plain"});
			res.end("Forbidden");
			return;
		}
		sendFile(res, file, req.method);
	});

	server.on("error", function(err) {
		try { cb(err, null); } catch(e) {}
		cb = function() {};
	});

	server.listen(0, "127.0.0.1", function() {
		var origin = "http://127.0.0.1:" + server.address().port;
		var handle = {
			origin: origin,
			token: token,
			shellUrl: origin + shellBase + "html/wiki-file-window.html",
			wikiUrl: origin + wikiBase + encodeURIComponent(wikiFile),
			// True for any URL on this origin that would be Node-enabled if opened. Used to
			// enforce the invariant that nothing on the shell path is ever opened outside the
			// nwdisable subtree.
			isShellUrl: function(url) {
				if(!url) { return false; }
				var s = String(url);
				return s.indexOf(origin + SHELL_PREFIX) === 0;
			},
			close: function() {
				try { server.close(); } catch(e) {}
			}
		};
		try { cb(null, handle); } catch(e) {}
		cb = function() {};
	});

	// A listening server keeps Node's event loop alive, which would stop the window's process
	// exiting cleanly when it closes. unref() lets the process exit while the server still serves
	// normally for as long as the window is open — same reasoning as utils/local-server.js.
	try { server.unref(); } catch(e) {}
};
