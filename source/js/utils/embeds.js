/*
Safe embedding of external media (YouTube, Vimeo, maps, …) in TiddlyDesktop wiki windows.

Security model
--------------
Folder wikis render in a Node-enabled page (an RCE boundary): a remote page that somehow
obtained Node would be remote code execution. Single-file wikis render in an `nwdisable`
iframe (no Node). In NW.js a remote `https` iframe does NOT receive Node by default, but we
do not want to rely on that alone, and we do not want a tiddler to be able to beacon to an
arbitrary server just by being rendered.

So:
  • Only iframes whose host is on a curated allowlist are permitted to load at all; any
    other external (http/https) iframe is blocked and replaced with a small note. The list
    is editable per-wiki via $:/config/TiddlyDesktop/EmbedHosts (added to the defaults).
  • Allowlisted media is routed through a loopback http shim (local-server.js): the iframe's
    src is rewritten to http://127.0.0.1:<port>/<token>/embed?src=<original>. The shim, served
    from a real http origin, embeds the provider — so the provider sees an http Referer and
    plays, instead of YouTube's file:// rejection (error 153). The embed stays a plain in-flow
    <iframe> (natural layout/scroll/stacking); the wiki document itself stays file://, so
    saving, the collab bridges and external attachments are untouched. If the shim server
    can't start we fall back to hardening the iframe in place (no playback, but no breakage).

Local / relative / blob: / data: iframes (TiddlyWiki's own internal frames) are left alone.
*/

"use strict";

var embedHosts  = require("./embed-hosts.js"),
	localServer = require("./local-server.js");

var DEFAULT_HOSTS = embedHosts.DEFAULT_HOSTS,
	hostAllowed   = embedHosts.hostAllowed;

var CONFIG_HOSTS = "$:/config/TiddlyDesktop/EmbedHosts";
// Permissions-policy features for the embed iframe. `fullscreen *` (not the default `'src'`)
// so fullscreen delegates down a cross-origin frame chain (file:// wiki → 127.0.0.1 shim →
// provider); with just `fullscreen` the player's fullscreen button is blocked. (We omit
// `web-share`: this Chromium build doesn't recognise it in `allow=` and only logs a warning.)
var EMBED_ALLOW  = "autoplay; encrypted-media; fullscreen *; picture-in-picture; clipboard-write";

/*
  doc      - the document the wiki renders into (folder: the window's document; single-file:
             the iframe's contentDocument)
  win      - that document's window (for URL parsing and reading the wiki's $tw config)
*/
exports.install = function(doc, win) {
	if(!doc || !doc.body) { return; }
	if(doc.__tdEmbedsInstalled) { return; }   // fresh per (re)loaded document, so this is per-load
	doc.__tdEmbedsInstalled = true;

	var URLctor = (win && win.URL) || (typeof URL !== "undefined" ? URL : null);
	var embedBase   = null;    // shim handle once the server is up; null if it failed to start
	var serverReady = false;   // false = still starting (distinct from "failed", which is ready+null)
	var parked      = [];      // allowlisted iframes blanked while the shim server starts

	// Defaults plus any extra hosts configured in the wiki itself (whitespace/comma list,
	// protocol and path tolerated). Re-read on each pass so edits take effect live.
	function allowedHosts() {
		var list = DEFAULT_HOSTS.slice();
		try {
			var tw = win && win.$tw;
			var txt = tw && tw.wiki ? tw.wiki.getTiddlerText(CONFIG_HOSTS, "") : "";
			if(txt) {
				txt.split(/[\s,]+/).forEach(function(h) {
					h = (h || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
					if(h) { list.push(h); }
				});
			}
		} catch(e) {}
		return list;
	}

	function blockEmbed(iframe, host) {
		var note = doc.createElement("div");
		note.className = "td-embed-blocked";
		note.setAttribute("style", "padding:8px 12px;border:1px dashed #b0883a;border-radius:6px;" +
			"background:rgba(176,136,58,0.08);color:#8a6d2b;font:13px/1.4 sans-serif;");
		note.textContent = "⚠ Embedded content from “" + host + "” is blocked. Add this host to " +
			CONFIG_HOSTS + " to allow it.";
		note.__tdEmbedUpgraded = true;
		if(iframe.parentNode) { iframe.parentNode.replaceChild(note, iframe); }
	}

	function hardenIframe(iframe) {
		// We frame our own shim (which sets its own allow on the provider iframe), so set a
		// known-good policy here rather than trusting the author's allow=. Crucially this uses
		// `fullscreen *` so fullscreen delegates across the origin change to the shim. Drop the
		// legacy `allowfullscreen` attribute: `allow=` supersedes it and keeping both just logs
		// "Allow attribute will take precedence over 'allowfullscreen'".
		iframe.setAttribute("allow", EMBED_ALLOW);
		iframe.removeAttribute("allowfullscreen");
		iframe.setAttribute("referrerpolicy", "origin-when-cross-origin");
		iframe.__tdEmbedUpgraded = true;
	}

	// Point an allowlisted iframe at the local shim (provider gets a real http origin and
	// plays). The shim load triggers a src mutation → the observer re-runs processIframe,
	// which short-circuits on the shim origin. If the shim server failed, just leave the
	// original src and harden in place (no playback, but no breakage).
	function pointAtShim(iframe, originalSrc, host) {
		hardenIframe(iframe);
		if(embedBase) {
			embedBase.registerHost(host);
			try { iframe.src = embedBase.embedUrl(originalSrc); } catch(e) {}
		} else {
			try { iframe.src = originalSrc; } catch(e) {}
		}
	}

	function processIframe(iframe) {
		if(!iframe || iframe.__tdEmbedUpgraded || iframe.__tdEmbedParked) { return; }
		var src = iframe.getAttribute("src") || "";
		// Our own shim URL (after we rewrote it) — leave it be, just mark it done.
		if(embedBase && src.indexOf(embedBase.origin) === 0) { iframe.__tdEmbedUpgraded = true; return; }
		if(!/^https?:\/\//i.test(src)) { return; }   // only real external embeds; leave TW's own frames
		var url;
		try { url = new URLctor(src); } catch(e) { return; }
		if(!hostAllowed(url.hostname, allowedHosts())) { blockEmbed(iframe, url.hostname); return; }
		// Allowlisted media.
		if(serverReady) {
			pointAtShim(iframe, src, url.hostname);
		} else {
			// The shim server is still binding. Kill the direct provider load NOW so the
			// file:// referer error (YouTube 153) never paints, and park the iframe to be
			// pointed at the shim the moment the server is up.
			iframe.__tdEmbedParked = true;
			iframe.__tdEmbedSrc    = src;
			iframe.__tdEmbedHost   = url.hostname;
			parked.push(iframe);
			try { iframe.src = "about:blank"; } catch(e) {}
		}
	}

	// The shim server is up (handle) or failed (null): release every parked iframe.
	function flushParked() {
		var list = parked; parked = [];
		for(var i = 0; i < list.length; i++) {
			var f = list[i];
			f.__tdEmbedParked = false;
			f.__tdEmbedUpgraded = false;
			pointAtShim(f, f.__tdEmbedSrc, f.__tdEmbedHost);
		}
	}

	function scan(root) {
		var frames = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
		for(var i = 0; i < frames.length; i++) { processIframe(frames[i]); }
	}

	// TiddlyWiki renders/refreshes tiddlers continuously, so watch for embeds appearing or
	// having their src set after creation. Upgraded nodes are marked, so this can't loop
	// (a blocked embed becomes a non-iframe note we ignore; our own shim src short-circuits).
	function attachObserver() {
		try {
			var MO = win.MutationObserver || win.WebKitMutationObserver;
			if(!MO) { return; }
			var obs = new MO(function(muts) {
				for(var m = 0; m < muts.length; m++) {
					var mut = muts[m];
					if(mut.type === "attributes" && mut.target && mut.target.tagName === "IFRAME") {
						mut.target.__tdEmbedUpgraded = false;   // src changed → re-evaluate
						processIframe(mut.target);
						continue;
					}
					for(var a = 0; a < mut.addedNodes.length; a++) {
						var n = mut.addedNodes[a];
						if(n.nodeType !== 1) { continue; }
						if(n.tagName === "IFRAME") { processIframe(n); }
						else if(n.querySelectorAll) { scan(n); }
					}
				}
			});
			obs.observe(doc.documentElement || doc.body, {
				childList: true, subtree: true, attributes: true, attributeFilter: ["src"]
			});
		} catch(e) {}
	}

	// Scan + observe SYNCHRONOUSLY so an embed is caught (and its direct provider load killed)
	// the instant it appears — before the file:// 153 page can paint — even though the shim
	// server starts asynchronously. Allowlisted embeds found before the server is ready are
	// parked (blanked) and released by flushParked() once ensureStarted resolves.
	try {
		localServer.registerHosts(allowedHosts());
		localServer.ensureStarted(function(handle) {
			embedBase = handle;   // may be null on failure
			serverReady = true;
			flushParked();
		});
	} catch(e) {
		// Server module unavailable for some reason — degrade to harden-only, still safe.
		serverReady = true;
		embedBase = null;
	}
	scan(doc);
	attachObserver();
};
