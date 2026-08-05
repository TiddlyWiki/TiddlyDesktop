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

/*
Content-Security-Policy for wiki documents.

Phase 11 of DESIGN-http-wiki-origin.md, and the only measure on any of our lists that constrains
what a wiki can send OUT rather than what it can read. It is available at all only because the
wiki is served: a file:// document cannot be given response headers.

What it restricts, and what it deliberately does not:

  connect-src   'self' plus the attachment origin. This is the point of the exercise — it stops a
                tiddler beaconing to an arbitrary host with fetch/XHR/WebSocket/sendBeacon. It does
                NOT break collaboration: the collab plugin's relay and LAN traffic go through the
                parent-side bridges, which make the request from the parent and are governed by
                their own scheme checks, not by the wiki's CSP.

  object-src    'none'. Nothing legitimate embeds plugins.
  base-uri      'none'. Stops a <base> tag silently repointing every relative URL in the document.
  form-action   'none'. TiddlyWiki does not submit forms, and a form POST is otherwise a tidy
                exfiltration channel that connect-src does not cover.

  script-src    must keep 'unsafe-eval' and 'unsafe-inline': TiddlyWiki compiles filters and
                widgets at runtime and ships inline scripts. A wiki is executable content by
                design, so CSP is not being used to contain its script.

  img-src /     left open. Wikis legitimately reference remote images and media, and a wiki that
  media-src     wants to leak through an <img> query string can still do so. Closing that would
  frame-src     break real wikis for a partial gain; frame-src likewise carries the allowlisted
                media embeds and the plugin library.

So this narrows the most direct exfiltration path without pretending to close every one.
*/
function cspFor(attachmentOrigin) {
	var attach = attachmentOrigin || "";
	return [
		"default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: " + attach,
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
		"style-src 'self' 'unsafe-inline' data:",
		"img-src * data: blob:",
		"media-src * data: blob:",
		"font-src * data:",
		"frame-src *",
		"connect-src 'self' " + attach,
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'"
	].join("; ");
}

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

function sendFile(res, file, method, extraHeaders) {
	fs.stat(file, function(err, stats) {
		if(err || !stats.isFile()) {
			res.writeHead(404, {"Content-Type": "text/plain"});
			res.end("Not found");
			return;
		}
		var headers = {
			"Content-Type": contentType(file),
			"Content-Length": stats.size,
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store"
		};
		Object.keys(extraHeaders || {}).forEach(function(k) { headers[k] = extraHeaders[k]; });
		if(method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
		res.writeHead(200, headers);
		/*
		The chunk size is a performance fix, not a tuning preference.

		NW.js pumps Node's event loop from Chromium's message loop, so a loop turn costs far more
		here than in plain Node. A stream chunk takes one turn, which makes transfer time scale with
		the NUMBER of chunks rather than with the bytes: at the 64KB default, a 7.8MB wiki is 122
		chunks and took 1566ms to deliver over loopback, against 26ms for the same code in a
		standalone node process. At 4MB it is two chunks and 88ms (measured, both).

		Still a stream rather than a readFile, so a large video attachment does not have to be held
		in memory in one piece.
		*/
		var stream = fs.createReadStream(file, {highWaterMark: 4 * 1024 * 1024});
		stream.on("error", function() { try { res.destroy(); } catch(e) {} });
		stream.pipe(res);
	});
}

/*
Start a server for one wiki window.

	options.appDir     the application directory (source/), whose html/ and js/ the shell needs
	options.wikiDir    the directory containing the wiki file
	options.wikiFile   the wiki file's basename
	options.identifier this wiki's identifier, for trusted-path lookups
	options.proxy      optional {origin, authHeader} — FOLDER wikis only

A folder wiki is not a file we can serve: its UI is generated by TiddlyWiki's own --listen
server. When `options.proxy` is given, /wiki/<token>/… forwards there instead of reading from
disk, and the whole method set (PUT/DELETE, which the sync adaptor needs) is passed through.

Two reasons it is proxied rather than exposed directly. The token stays the only way in, and the
backend can require a password that only we know — TiddlyWiki's server takes username/password
variables, and its readers/writers then default to that user, so anonymous access is refused.
Without that, every local process could read and write the wiki, which is exactly the weakness
the Android folder-wiki servers have (audit finding #6).

A folder wiki is served at the ORIGIN ROOT, not under /wiki/<token>. TiddlyWiki's `path-prefix`
only strips the prefix server-side — nothing tells the client about it, and `getHost()` in the
tiddlyweb adaptor substitutes only $protocol$ and $host$. Under a prefix the client therefore syncs
to the wrong paths: GET /status 404s and saves 405. Making it work would mean setting
$:/config/tiddlyweb/host inside the wiki, i.e. writing to the user's wiki, which we will not do.

Serving at the root makes the client's default host correct with no changes to the wiki at all.
The token then cannot live in the path, so it is carried by an HttpOnly cookie that we set when we
serve the shell — same origin, so it is ours to set — and required on every proxied request. A
local process that has not been given the token cannot bootstrap the cookie, so it still cannot
reach the wiki.

Two servers are started, on two OS-assigned ports:

  the WIKI origin        shell + wiki, as described above
  the ATTACHMENT origin  files outside the wiki folder, and ONLY those the user has
                         trusted for this wiki

They are separate origins on purpose. A cross-origin image taints any canvas it is drawn
to, so script cannot launder attachment bytes out through getImageData(). The attachment
origin is also deliberately absent from node-remote — nothing served from it is ever
Node-eligible, which matters because it serves user files.

cb(err, handle) where handle is:
	{origin, token, shellUrl, wikiUrl, isShellUrl(url),
	 attachmentOrigin, attachmentUrl(absPath), close()}
*/
exports.start = function(options, cb) {
	var appDir = options.appDir,
		wikiDir = options.wikiDir,
		wikiFile = options.wikiFile,
		identifier = options.identifier,
		token = crypto.randomBytes(16).toString("hex");

	// Mutable: a folder wiki's backend does not exist until its shell has booted TiddlyWiki, so
	// the target is set afterwards via handle.setProxy().
	var proxy = options.proxy || null;

	var shellBase = SHELL_PREFIX + token + "/",
		wikiBase = "/wiki/" + token + "/",
		attachBase = "/a/" + token + "/";

	// Forward a request to the folder wiki's TiddlyWiki server, adding the credential it
	// requires. Everything else — method, path, body, status, headers — passes through.
	var COOKIE_NAME = "tdsession";

	function hasSessionCookie(req) {
		var raw = req.headers.cookie || "";
		var parts = raw.split(";");
		for(var i = 0; i < parts.length; i++) {
			var kv = parts[i].split("=");
			if(kv[0] && kv[0].trim() === COOKIE_NAME && (kv[1] || "").trim() === token) { return true; }
		}
		return false;
	}

	/*
	up.pipe(res) for a body that arrives in many pieces, but writing far fewer of them.

	Same NW.js cost as sendFile's chunk size, reached from the other end. Here the arrival size is
	not ours to choose — Node reads a TCP socket in 64KB regardless of any highWaterMark (tried;
	no effect) — but the expense turns out to be per RESPONSE WRITE, not per arrival: coalescing the
	writes alone took a 3MB folder wiki from 737ms of transfer to 44ms (measured).

	Held to FLUSH_BYTES with a FLUSH_MS deadline so this stays a proxy and not a download buffer:
	a video served from the wiki's files/ folder starts playing on the timer rather than waiting for
	a megabyte to accumulate. Backpressure is honoured — without it a client slower than the backend
	would have the whole response queued in memory.
	*/
	var FLUSH_BYTES = 1024 * 1024,
		FLUSH_MS = 20;

	function pipeCoalesced(up, res) {
		var buf = [],
			size = 0,
			timer = null,
			ended = false;

		function flush() {
			if(timer) { clearTimeout(timer); timer = null; }
			if(!size) { return true; }
			var chunk = buf.length === 1 ? buf[0] : Buffer.concat(buf, size);
			buf = [];
			size = 0;
			return res.write(chunk);
		}

		up.on("data", function(c) {
			buf.push(c);
			size += c.length;
			if(size >= FLUSH_BYTES) {
				if(!flush()) {
					// The client is behind: stop reading until it drains.
					up.pause();
					res.once("drain", function() { up.resume(); });
				}
			} else if(!timer) {
				timer = setTimeout(function() { timer = null; flush(); }, FLUSH_MS);
			}
		});
		up.on("end", function() {
			if(ended) { return; }
			ended = true;
			flush();
			res.end();
		});
		up.on("error", function() {
			if(timer) { clearTimeout(timer); timer = null; }
			try { res.destroy(); } catch(e) {}
		});
		// A client that goes away must not leave the backend response draining into a dead socket.
		res.on("close", function() {
			if(timer) { clearTimeout(timer); timer = null; }
			if(!ended) { try { up.destroy(); } catch(e) {} }
		});
	}

	function proxyRequest(req, res) {
		var headers = {};
		Object.keys(req.headers).forEach(function(k) {
			// Host must reflect the backend, and hop-by-hop headers must not be forwarded.
			if(k === "host" || k === "connection" || k === "keep-alive" ||
				k === "proxy-authorization" || k === "upgrade") { return; }
			headers[k] = req.headers[k];
		});
		if(proxy.authHeader) { headers["authorization"] = proxy.authHeader; }
		var target = new URL(proxy.origin);
		var upstream = http.request({
			hostname: target.hostname,
			port: target.port,
			method: req.method,
			path: req.url,
			headers: headers
		}, function(up) {
			var headers = up.headers || {};
			// TiddlyWiki's server sets no CSP of its own; ours is applied on the way back so a
			// served folder wiki is governed exactly like a single-file one.
			headers["content-security-policy"] = cspFor(attachOrigin);
			res.writeHead(up.statusCode, headers);
			pipeCoalesced(up, res);
		});
		upstream.on("error", function(err) {
			if(!res.headersSent) {
				res.writeHead(502, {"Content-Type": "text/plain"});
				res.end("Wiki server unavailable");
			} else {
				try { res.destroy(); } catch(e) {}
			}
		});
		req.pipe(upstream);
	}

	var server = http.createServer(function(req, res) {
		var urlPath;
		try { urlPath = req.url.split("?")[0].split("#")[0]; } catch(e) { urlPath = ""; }
		// Folder wikis: hand the whole method set to TiddlyWiki's server. Checked before the
		// GET/HEAD restriction below, which exists for the static routes only.
		if(proxy && urlPath.indexOf(SHELL_PREFIX) !== 0) {
			// Folder wiki: everything outside the shell prefix belongs to TiddlyWiki, whose
			// client expects to live at the origin root.
			if(!hasSessionCookie(req)) {
				res.writeHead(403, {"Content-Type": "text/plain"});
				res.end("Forbidden");
				return;
			}
			proxyRequest(req, res);
			return;
		}
		if(req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, {"Content-Type": "text/plain"});
			res.end("Method not allowed");
			return;
		}
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
		// Reaching a shell URL means presenting the path token, so this response is where the
		// session cookie is minted. It is what lets the folder wiki be served at the origin
		// root without the token in every URL.
		var extra = {};
		if(root === wikiDir) {
			extra["Content-Security-Policy"] = cspFor(attachOrigin);
		}
		if(root === appDir) {
			extra["Set-Cookie"] = COOKIE_NAME + "=" + token +
				"; Path=/; HttpOnly; SameSite=Strict";
		}
		sendFile(res, file, req.method, extra);
	});

	/*
	The attachment server. Serves files by ABSOLUTE path — the path is base64url in the URL, so
	nothing is ever joined and there is no traversal surface at all; the decoded path is simply
	checked against this wiki's trusted paths.

	CORS is decided per request from Sec-Fetch-Dest, not from the file's type:

	  Sec-Fetch-Dest: empty       a fetch/XHR, i.e. TiddlyWiki's loadRemoteTiddler pulling a
	                              .tid/.txt attachment into the store -> must be readable by
	                              script, so send Access-Control-Allow-Origin
	  anything else               a renderer load (<img>, <video>, …) -> no CORS header, so an
	                              opportunistic fetch() of the same URL gets an opaque response

	Classifying by content type instead was tried and abandoned: TiddlyWiki dispatches on the
	tiddler's `type` field, which the server cannot see and the WIKI writes — so a wiki wanting
	an image's bytes would just declare it text/plain. The no-CORS default is therefore hardening,
	not a boundary. The boundary is trust; see DESIGN-http-wiki-origin.md.
	*/
	var attachServer = http.createServer(function(req, res) {
		if(req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, {"Content-Type": "text/plain"});
			res.end("Method not allowed");
			return;
		}
		var urlPath;
		try { urlPath = req.url.split("?")[0].split("#")[0]; } catch(e) { urlPath = ""; }
		if(urlPath.indexOf(attachBase) !== 0) {
			res.writeHead(404, {"Content-Type": "text/plain"});
			res.end("Not found");
			return;
		}
		var abs;
		try {
			abs = Buffer.from(urlPath.slice(attachBase.length), "base64").toString("utf8");
		} catch(e) { abs = ""; }
		if(!abs || abs.indexOf("\0") !== -1 || !path.isAbsolute(abs)) {
			res.writeHead(400, {"Content-Type": "text/plain"});
			res.end("Bad request");
			return;
		}
		// Resolve symlinks before the trust check, so a trusted path that is a link to an
		// untrusted file cannot be used to read through it.
		var real = abs;
		try { real = fs.realpathSync(abs); } catch(e) {}
		var allowed = false;
		try { allowed = trust.isTrusted(identifier, real, [wikiDir]); } catch(e) { allowed = false; }
		if(!allowed) {
			console.warn("[TiddlyDesktop] attachment refused (not trusted for this wiki):", abs);
			res.writeHead(403, {"Content-Type": "text/plain"});
			res.end("Not trusted");
			return;
		}
		var headers = {};
		if(String(req.headers["sec-fetch-dest"] || "").toLowerCase() === "empty") {
			headers["Access-Control-Allow-Origin"] = wikiOrigin || "null";
		}
		sendFile(res, real, req.method, headers);
	});

	var wikiOrigin = null, attachOrigin = null, reported = false;
	function report(err) {
		if(reported) { return; }
		if(err) { reported = true; try { cb(err, null); } catch(e) {} return; }
		if(!wikiOrigin || !attachOrigin) { return; }   // wait for both
		reported = true;
		try {
			cb(null, {
				origin: wikiOrigin,
				token: token,
				shellUrl: wikiOrigin + shellBase + "html/wiki-file-window.html",
				// Folder wikis use a different shell page, and their wiki URL is the proxied
				// root rather than a file in the wiki directory.
				shellUrlFor: function(relPath) {
					return wikiOrigin + shellBase + String(relPath).replace(/^\/+/, "");
				},
				wikiRootUrl: wikiOrigin + wikiBase,
				wikiUrl: wikiOrigin + wikiBase + encodeURIComponent(wikiFile),
				// True for any URL on this origin that would be Node-enabled if opened. Used to
				// enforce the invariant that nothing on the shell path is ever opened outside the
				// nwdisable subtree.
				isShellUrl: function(url) {
					if(!url) { return false; }
					return String(url).indexOf(wikiOrigin + SHELL_PREFIX) === 0;
				},
				attachmentOrigin: attachOrigin,
				// URL for an absolute path on the attachment origin. Returns a URL whether or not
				// the path is trusted — the server decides that per request, so a grant made after
				// the page rendered takes effect on the next load without rewriting anything.
				attachmentUrl: function(absPath) {
					return attachOrigin + attachBase +
						Buffer.from(String(absPath), "utf8").toString("base64");
				},
				// Point /wiki/<token>/… at a backend. Passing null reverts to serving files.
				setProxy: function(target) {
					proxy = target || null;
				},
				close: function() {
					try { server.close(); } catch(e) {}
					try { attachServer.close(); } catch(e) {}
				}
			});
		} catch(e) {}
	}

	server.on("error", function(err) { report(err); });
	attachServer.on("error", function(err) { report(err); });

	server.listen(0, "127.0.0.1", function() {
		wikiOrigin = "http://127.0.0.1:" + server.address().port;
		report(null);
	});
	attachServer.listen(0, "127.0.0.1", function() {
		attachOrigin = "http://127.0.0.1:" + attachServer.address().port;
		report(null);
	});

	// A listening server keeps Node's event loop alive, which would stop the window's process
	// exiting cleanly when it closes. unref() lets the process exit while the servers still serve
	// normally for as long as the window is open — same reasoning as utils/local-server.js.
	try { server.unref(); } catch(e) {}
	try { attachServer.unref(); } catch(e) {}
};
