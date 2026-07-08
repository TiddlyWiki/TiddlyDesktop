/*
Local loopback HTTP shim for media embeds.

The problem
-----------
Single-file wikis are `file://` pages. An embedded `<iframe src="https://youtube.com/embed/…">`
inside a `file://` page loads with a `file://`/empty Referer, and YouTube rejects that with
player error 153 (other providers behave similarly). NW.js gives us no way to fix the request
header — `chrome.webRequest` is unavailable in the app's event-page context.

The fix
-------
Host a tiny static "embed shim" page on `http://127.0.0.1:<random-port>/<token>/embed?src=<url>`.
embeds.js points the wiki's media iframe at that shim instead of straight at the provider. The
shim — served from a real `http` origin — embeds the provider in turn, so the provider now sees
an `http` Referer/origin and plays. The wiki document itself stays `file://`, so saving, the
collab bridges and external attachments (which all rely on the parent sharing the iframe's
`file://` origin, and on `file://` resource loads) are completely untouched.

Security
--------
  • Bound to 127.0.0.1 only — not reachable off the machine.
  • Every request must carry an unguessable per-process token in its path; we never log it.
  • The shim ONLY embeds URLs whose host is on the media allowlist (the same list embeds.js
    enforces, plus any per-wiki additions embeds.js registers here). It serves no filesystem
    content and proxies nothing, so it can't read local files or act as an open relay.
  • The shim sets `referrerpolicy="origin-when-cross-origin"`, so the provider receives only
    `http://127.0.0.1:<port>` as the origin — enough to play, nothing about the user.
*/

"use strict";

var http   = require("http"),
	crypto = require("crypto"),
	hosts  = require("./embed-hosts.js");

var server     = null,
	token      = null,
	origin     = null,           // e.g. "http://127.0.0.1:53187"
	starting   = false,
	pending    = [],             // callbacks waiting for the server to come up
	allowed    = null;           // Set of allowed hostnames (lowercased)

function ensureAllowSet() {
	if(!allowed) {
		allowed = Object.create(null);
		hosts.DEFAULT_HOSTS.forEach(function(h) { allowed[h] = true; });
	}
	return allowed;
}

// Add hosts (e.g. a wiki's $:/config/TiddlyDesktop/EmbedHosts additions) to the allowlist the
// shim will embed. embeds.js calls this for every host it itself decided to allow, so the
// server never embeds anything embeds.js wouldn't.
exports.registerHosts = function(list) {
	var set = ensureAllowSet();
	(list || []).forEach(function(h) { if(h) { set[String(h).toLowerCase()] = true; } });
};

function hostIsAllowed(hostname) {
	hostname = (hostname || "").toLowerCase();
	var set = ensureAllowSet();
	if(set[hostname]) { return true; }
	// Suffix match against the configured hosts (www.youtube.com vs youtube.com).
	return hosts.hostAllowed(hostname, Object.keys(set));
}

function shimHtml(src) {
	// Inject the URL as a JS string literal (JSON-encoded, with "<" neutralised so a crafted
	// URL can't close the <script>). The iframe is built in script so there's no HTML-attribute
	// injection surface.
	var js = JSON.stringify(src).replace(/</g, "\\u003c");
	return "<!doctype html><html><head><meta charset=\"utf-8\">" +
		"<meta name=\"referrer\" content=\"origin\">" +
		"<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}" +
		"iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>" +
		"var u=" + js + ";" +
		// YouTube embeds want the embedding page's origin declared explicitly; without it some
		// videos report \"Video unavailable\". Harmless for other providers, so only YouTube.
		"try{var _u=new URL(u);if(/(^|\\.)youtube(-nocookie)?\\.com$/.test(_u.hostname)&&!_u.searchParams.has('origin')){_u.searchParams.set('origin',location.origin);u=_u.toString();}}catch(e){}" +
		"var f=document.createElement('iframe');" +
		"f.src=u;" +
		// `fullscreen *` so the provider's fullscreen button works through the frame chain;
		// no legacy allowfullscreen (allow= supersedes it and avoids a console warning).
		"f.setAttribute('allow','autoplay; encrypted-media; fullscreen *; picture-in-picture; clipboard-write');" +
		"f.setAttribute('referrerpolicy','origin-when-cross-origin');" +
		"document.body.appendChild(f);" +
		"</script></body></html>";
}

function handleRequest(req, res) {
	var u;
	try { u = new URL(req.url, origin || "http://127.0.0.1"); } catch(e) { res.writeHead(400); res.end(); return; }
	// Path must be /<token>/embed
	if(u.pathname !== "/" + token + "/embed") { res.writeHead(404); res.end("Not found"); return; }
	var src = u.searchParams.get("src") || "";
	var target;
	try { target = new URL(src); } catch(e) { res.writeHead(400); res.end("Bad src"); return; }
	if(!/^https?:$/i.test(target.protocol) || !hostIsAllowed(target.hostname)) {
		res.writeHead(403); res.end("Host not allowed"); return;
	}
	var body = shimHtml(target.href);
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		// The shim is meant to be framed by the wiki window; allow it.
		"X-Content-Type-Options": "nosniff"
	});
	res.end(body);
}

/*
Start the server once per process and hand the caller an embed-base helper:
  cb({
    origin: "http://127.0.0.1:<port>",
    embedUrl: function(src) -> shim URL for that media src,
    registerHost: function(hostname)
  })
On failure (couldn't bind), cb(null) — embeds.js then falls back to hardening only.
*/
exports.ensureStarted = function(cb) {
	if(origin) { cb(makeHandle()); return; }
	pending.push(cb);
	if(starting) { return; }
	starting = true;
	token = crypto.randomBytes(16).toString("hex");
	server = http.createServer(handleRequest);
	server.on("error", function(err) {
		try { console.error("[TiddlyDesktop] embed shim server failed to start:", err && err.message); } catch(e) {}
		starting = false;
		var cbs = pending; pending = [];
		cbs.forEach(function(fn) { try { fn(null); } catch(e) {} });
	});
	// Port 0 → OS assigns a free ephemeral port. 127.0.0.1 only.
	server.listen(0, "127.0.0.1", function() {
		var addr = server.address();
		origin = "http://127.0.0.1:" + addr.port;
		starting = false;
		var cbs = pending; pending = [];
		cbs.forEach(function(fn) { try { fn(makeHandle()); } catch(e) {} });
	});
	// A listening server keeps Node's event loop alive, which (in each wiki window's process)
	// would stop that process from exiting cleanly when the window closes — leaving zombie
	// TiddlyDesktop processes behind. unref() lets the process exit when nothing else is
	// pending; the shim still serves normally while the window is open.
	try { server.unref(); } catch(e) {}
};

function makeHandle() {
	return {
		origin: origin,
		embedUrl: function(src) {
			return origin + "/" + token + "/embed?src=" + encodeURIComponent(src);
		},
		registerHost: function(hostname) {
			if(hostname) { ensureAllowSet()[String(hostname).toLowerCase()] = true; }
		}
	};
}
