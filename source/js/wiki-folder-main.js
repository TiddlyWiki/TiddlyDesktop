/*
Script for wiki folder windows
*/

"use strict";

var gui = require("nw.gui"),
	fs = require("fs"),
	path = require("path");

// Set up the $tw global
var $tw = {
	desktop: {
		gui: gui,
		utils: {
			devtools: require("../js/utils/devtools.js"),
			dom: require("../js/utils/dom.js"),
			dragdrop: require("../js/utils/dragdrop.js"),
			findbar: require("../js/utils/findbar.js"),
			menu: require("../js/utils/menu.js"),
			ws: require("ws"),
			https: require("https"),
			http: require("http"),
		},
	},
};

global.$tw = $tw;
window.$tw = $tw;

// Use the main window as the container window
var containerWindow = gui.Window.get();
// containerWindow.showDevTools();

// Hide the container window when we start, and when it is closed
containerWindow.on("close", function (isQuitting) {
	containerWindow.close(true);
});

$tw.desktop.utils.menu.createMenuBar(containerWindow);

// Show dev tools on F12
$tw.desktop.utils.devtools.trapDevTools(containerWindow, document);

// Get the query parameters that were used to open this container window

var queryObject = $tw.desktop.utils.dom.decodeQueryString(
	containerWindow.window.document.location,
);

// Apply the local-spellcheck toggle and language passed from the backstage. The Google spelling service
// is already forced off profile-wide in node-main; this only gates the visible red squiggles and the
// spellcheck dictionary language for this folder wiki.
try {
	var _sc = require("../js/utils/spellcheck.js");
	_sc.applyToDocument(document, queryObject.spellcheck !== "no",
		queryObject["spellcheck-lang"] || "en-GB");
} catch (e) {}

// First part of boot process
require("../tiddlywiki/boot/bootprefix.js").bootprefix($tw);

// Set command line
$tw.boot = $tw.boot || {};
$tw.boot.argv = [queryObject.pathname];

if (queryObject.host && queryObject.port) {
	$tw.boot.argv.push(
		"--listen",
		"host=" + queryObject.host,
		"port=" + queryObject.port,
		"credentials=" + queryObject.credentials,
		"readers=" + queryObject.readers,
		"writers=" + queryObject.writers,
	);
	// Optional --listen server options (only passed when set, so empty values don't
	// override TiddlyWiki's own defaults).
	if (queryObject.pathprefix) {
		// TiddlyWiki matches path-prefix as a literal prefix of the (leading-slash)
		// request path, so it must start with "/" — normalise it for the user.
		var _pp = queryObject.pathprefix.replace(/\/+$/, "");
		if (_pp.charAt(0) !== "/") {
			_pp = "/" + _pp;
		}
		$tw.boot.argv.push("path-prefix=" + _pp);
	}
	if (queryObject.roottiddler) {
		$tw.boot.argv.push("root-tiddler=" + queryObject.roottiddler);
	}
	if (queryObject.anonusername) {
		$tw.boot.argv.push("anon-username=" + queryObject.anonusername);
	}
	if (queryObject.gzip === "yes") {
		$tw.boot.argv.push("gzip=yes");
	}
}

// External attachments for folder wikis (part 1 of 2 — see the import hook after boot). A folder
// wiki renders from the html/ app page, so document.baseURI is that app directory: a wiki-relative
// _canonical_uri (e.g. "pics/foo.png" or "../media/foo.png", relative to the WIKI FOLDER) would
// resolve against html/ and 404. We must NOT rewrite the STORED value — it stays relative so the
// tiddler still works when the folder is served over the LAN. Instead we wrap setAttribute on THIS
// window so that, at the instant TiddlyWiki sets a media element's src (or an <a> href) to a
// wiki-relative value, it is rewritten to resolve against file://<wikiFolder>/ . Doing this
// synchronously inside setAttribute — installed BEFORE boot renders — means the browser never sees
// the wrong URL, so there is no transient failed request. It covers every path uniformly: the
// image/audio/video widgets AND raw HTML <img>/<audio> in wikitext all set src via setAttribute,
// with no core-widget overrides. Absolute file:// URIs (the default for files outside the wiki, and
// what collab records in "use absolute" mode) carry a scheme, so they're left untouched and load
// directly. This also fixes collab-received attachments that are stored relative.
var wikiFolderPath = $tw.boot.wikiPath || queryObject.pathname;

// The wiki folder as a trailing-slashed file:// base (for resolving wiki-relative URIs).
function wikiFolderFileBase() {
	if (!wikiFolderPath) {
		return null;
	}
	var p = String(wikiFolderPath).replace(/\\/g, "/");
	if (p.charAt(0) !== "/") {
		p = "/" + p;
	} // C:/… -> /C:/… so it becomes file:///C:/…
	if (p.slice(-1) !== "/") {
		p += "/";
	}
	return "file://" + encodeURI(p);
}

(function () {
	var base = wikiFolderFileBase();
	var win = containerWindow.window;
	if (!base || !win || !win.Element || !win.Element.prototype || win.__tdAttachmentRebaseInstalled) {
		return;
	}
	win.__tdAttachmentRebaseInstalled = true;
	// Media elements whose src TiddlyWiki fills from a _canonical_uri; <iframe> is excluded (media
	// embeds are handled elsewhere and use absolute http URLs).
	var SRC_TAGS = { IMG: 1, EMBED: 1, AUDIO: 1, VIDEO: 1, SOURCE: 1, TRACK: 1 };
	// Wiki-relative = no scheme, not protocol-relative, not a bare fragment/query. "./x", "../x",
	// "attachments/x", "x.png" qualify; "http(s):", "data:", "file:", "blob:", "#t", "?q" do not.
	function isRelative(v) {
		return typeof v === "string" && !!v && !/^(?:[a-z][a-z0-9+.\-]*:|\/\/|#|\?)/i.test(v);
	}
	var proto = win.Element.prototype;
	var nativeSetAttribute = proto.setAttribute;
	proto.setAttribute = function (name, value) {
		// Fast path: only src/href are candidates, so most setAttribute calls skip straight through.
		if (name === "src" || name === "href") {
			if (
				this && this.tagName && isRelative(value) &&
				(name === "src" ? SRC_TAGS[this.tagName] : this.tagName === "A")
			) {
				try {
					value = new win.URL(value, base).href;
				} catch (e) {}
			}
		}
		return nativeSetAttribute.call(this, name, value);
	};
})();

console.log("Running tiddlywiki " + $tw.boot.argv.join(" "));

// Main part of boot process — timed so a slow folder-wiki load can be localised in the
// devtools console (F12): a big "TiddlyWiki() sync" number points at boot/startup work
// (wiki size, plugin startups), a big gap to "first tick" points at the async render.
var _tdBootStart = Date.now();
require("../tiddlywiki/boot/boot.js").TiddlyWiki($tw);
console.log(
	"[TiddlyDesktop] folder wiki: TiddlyWiki() sync took " +
		(Date.now() - _tdBootStart) +
		"ms",
);
setTimeout(function () {
	console.log(
		"[TiddlyDesktop] folder wiki: first tick at " +
			(Date.now() - _tdBootStart) +
			"ms",
	);
}, 0);

$tw.wiki.addTiddler({ title: "$:/status/IsReadOnly", text: "no" });

// Intercept cross-browser drag-drop imports (same fix as wiki-file windows).
// In the folder window the wiki document IS this window, so contentWindow
// and the document are the window itself.
$tw.desktop.utils.dragdrop.installImportInterceptor(
	containerWindow.window.document,
	containerWindow.window,
	{ parentWindow: containerWindow.window },
);

// Browser-style find-in-page (Ctrl/Cmd+F). The folder wiki document IS this
// window, so host and content are the same window. It defers to any focused
// editor that claims the shortcut (e.g. CodeMirror 6).
try {
	$tw.desktop.utils.findbar.installFindBar({
		hostWindow: containerWindow.window,
		hostDocument: containerWindow.window.document,
		getContentWindow: function () {
			return containerWindow.window;
		},
		getContentDocument: function () {
			return containerWindow.window.document;
		},
	});
} catch (e) {
	console.error("[TiddlyDesktop] find bar install failed:", e);
}

// Mirror this wiki's title and favicon to the file the backstage watches, so the
// wiki-list entry tracks $:/SiteTitle / $:/SiteSubtitle / $:/favicon.ico live. TiddlyWiki
// keeps document.title and the #faviconLink href in sync with those tiddlers; we observe
// both and write a small JSON payload (in place, so the backstage's fs.watch keeps its
// inode), debounced and de-duplicated so the burst of changes during boot doesn't thrash
// the file.
(function () {
	var stateFile = queryObject.stateFile,
		win = containerWindow.window,
		doc = win.document;
	if (!stateFile) {
		return;
	}
	var lastWritten = null,
		writeTimer = null;
	function currentState() {
		var title = doc.title || "",
			faviconType = "",
			faviconText = "",
			faviconLink = doc.getElementById("faviconLink"),
			href = faviconLink && faviconLink.getAttribute("href");
		// faviconLink href is a data URI: "data:<type>;base64,<text>"
		if (href && href.indexOf("data:") === 0) {
			var posColon = href.indexOf(":"),
				posSemiColon = href.indexOf(";"),
				posComma = href.indexOf(",");
			if (posSemiColon !== -1 && posComma !== -1) {
				faviconType = href.substring(
					posColon + 1,
					posSemiColon,
				);
				faviconText = href.substring(posComma + 1);
			}
		}
		return {
			title: title,
			faviconType: faviconType,
			faviconText: faviconText,
		};
	}
	function writeState() {
		var payload = JSON.stringify(currentState());
		if (payload === lastWritten) {
			return;
		}
		lastWritten = payload;
		try {
			fs.writeFileSync(stateFile, payload, "utf8");
		} catch (e) {}
	}
	function schedule() {
		if (writeTimer) {
			clearTimeout(writeTimer);
		}
		writeTimer = setTimeout(writeState, 50);
	}
	if (win.MutationObserver) {
		var titleNode = doc.getElementsByTagName("title")[0];
		if (titleNode) {
			new win.MutationObserver(schedule).observe(titleNode, {
				childList: true,
				characterData: true,
				subtree: true,
			});
		}
		// The favicon <link> is created/updated by the core favicon startup; observe its
		// href so a changed $:/favicon.ico is reflected. It may not exist yet at this point,
		// so also watch <head> for it being added.
		var faviconLink = doc.getElementById("faviconLink");
		if (faviconLink) {
			new win.MutationObserver(schedule).observe(
				faviconLink,
				{ attributes: true, attributeFilter: ["href"] },
			);
		} else if (doc.head) {
			var headObserver = new win.MutationObserver(
				function () {
					var link =
						doc.getElementById(
							"faviconLink",
						);
					if (link) {
						headObserver.disconnect();
						new win.MutationObserver(
							schedule,
						).observe(link, {
							attributes: true,
							attributeFilter: [
								"href",
							],
						});
						schedule();
					}
				},
			);
			headObserver.observe(doc.head, { childList: true });
		}
	}
	schedule();
})();

// External attachments for folder wikis (part 2 of 2 — resolution is set up before boot, above).
//
// (1) IMPORT. On desktop we do NOT copy the dropped file into the wiki; we reference it IN PLACE,
// exactly like the stock external-attachments plugin — the file stays where the user has it. The
// stock plugin can't do this for a folder wiki, though: it only fires on a file:// wiki document
// and computes the path relative to document.location, which here is the html/ app page, not the
// wiki. We have Node, so we compute the _canonical_uri ourselves against the WIKI FOLDER, honouring
// the same relative/absolute settings the plugin exposes (descendents default to relative, non-
// descendents to absolute — a relative path that climbs out of the wiki tree is fragile). Relative
// results resolve at render time via the setAttribute rebasing installed before boot; absolute
// file:// results are used as-is.
//
// $tw.hooks.invokeHook pipes each hook's RETURN VALUE into the next hook and returns the LAST
// hook's value; wiki.readFile then runs a normal (inline) import unless that final value is exactly
// true. So a single "handle it and return true" hook is not enough: the stock hook, registered
// after ours, would be handed our boolean, return false, and the importer would ALSO import the
// file inline — and being async that inline import wins, embedding the bytes. We therefore split
// into two hooks around a shared flag: `claim` runs FIRST (so it receives the real info object) and
// does the work; `settle` runs LAST and forces the final return value to true whenever we claimed,
// so no inline import follows. When we don't claim, `settle` passes the piped value through
// untouched, leaving other importers unaffected.
(function () {
	if (!$tw.hooks || !$tw.hooks.addHook) {
		return;
	}
	// Forward-slash relative path FROM the wiki folder TO an absolute file path (both forward-slash).
	function relativeToWikiFolder(baseDir, absPath) {
		var a = baseDir.split("/"),
			b = absPath.split("/"),
			i = 0;
		while (i < a.length && i < b.length && a[i] === b[i]) {
			i++;
		}
		var up = [];
		for (var j = i; j < a.length; j++) {
			up.push("..");
		}
		return up.concat(b.slice(i)).join("/") || ".";
	}
	// The _canonical_uri for a dropped file, referenced in place and resolved against the wiki
	// folder. Mirrors the stock plugin's makePathRelative, but rooted at the wiki folder (not the
	// app page) and reading the plugin's own UseAbsolute settings.
	function canonicalUriForDroppedFile(filePath) {
		var abs = String(filePath).replace(/\\/g, "/");
		if (abs.charAt(0) !== "/") {
			abs = "/" + abs;
		} // C:/… -> /C:/…
		var baseDir = String(wikiFolderPath).replace(/\\/g, "/").replace(/\/+$/, "");
		if (baseDir.charAt(0) !== "/") {
			baseDir = "/" + baseDir;
		}
		var isDescendent = abs === baseDir || abs.indexOf(baseDir + "/") === 0;
		var useAbsolute =
			$tw.wiki.getTiddlerText(
				isDescendent
					? "$:/config/ExternalAttachments/UseAbsoluteForDescendents"
					: "$:/config/ExternalAttachments/UseAbsoluteForNonDescendents",
				isDescendent ? "no" : "yes",
			) === "yes";
		// encodeURI matches how TiddlyWiki's external-attachments records URIs (spaces -> %20 etc.).
		return useAbsolute
			? "file://" + encodeURI(abs)
			: encodeURI(relativeToWikiFolder(baseDir, abs));
	}
	var claimed = false;
	function claim(info) {
		claimed = false;
		try {
			if (
				info &&
				info.isBinary &&
				info.file &&
				info.file.path &&
				wikiFolderPath &&
				$tw.wiki.getTiddlerText(
					"$:/config/ExternalAttachments/Enable",
					"",
				) === "yes"
			) {
				info.callback([
					{
						title: info.file.name,
						type: info.type,
						_canonical_uri: canonicalUriForDroppedFile(info.file.path),
					},
				]);
				claimed = true;
				return true;
			}
		} catch (e) {
			console.error(
				"[TiddlyDesktop] folder-wiki external attachment failed:",
				e,
			);
		}
		return false;
	}
	function settle(value) {
		if (claimed) {
			claimed = false;
			return true;
		}
		return value;
	}
	var arr = $tw.hooks.names && $tw.hooks.names["th-importing-file"];
	if (arr && typeof arr.unshift === "function") {
		arr.unshift(claim); // runs first: receives the real info object
	} else {
		$tw.hooks.addHook("th-importing-file", claim);
	}
	$tw.hooks.addHook("th-importing-file", settle); // runs last: controls the final return value
})();

// Fullscreen: F11 and the fullscreen page-control button toggle the native window.
try {
	require("../js/utils/fullscreen.js").install(
		containerWindow,
		containerWindow.window.document,
		function () {
			return $tw.rootWidget;
		},
	);
} catch (e) {
	console.error("[TiddlyDesktop] fullscreen install failed:", e);
}

// Page zoom: Ctrl/Cmd +/-/0 and Ctrl/Cmd+wheel, with a reset control while not at 100%.
try {
	require("../js/utils/zoom.js").install(
		containerWindow,
		containerWindow.window.document,
	);
} catch (e) {
	console.error("[TiddlyDesktop] zoom install failed:", e);
}

// Grey out permalink/permaview — no shareable URL in a desktop wiki window.
try {
	require("../js/utils/disable-permalinks.js").install(
		containerWindow.window.document,
	);
} catch (e) {
	console.error("[TiddlyDesktop] disable-permalinks install failed:", e);
}

// Safe external embeds (YouTube etc.): allowlisted media is routed through a loopback http
// shim (real origin -> the provider plays instead of rejecting a file:// referer).
try {
	require("../js/utils/embeds.js").install(
		containerWindow.window.document,
		containerWindow.window,
	);
} catch (e) {
	console.error("[TiddlyDesktop] embeds install failed:", e);
}

// ── popup windows (tm-open-window) ────────────────────────────────────────────
// TiddlyWiki's tm-open-window calls window.open() from within the folder wiki.
// new-win-policy fires at the native NW.js level (not the JS level), so it
// reliably catches every popup request, and we install TiddlyDesktop features on
// the resulting window (see the two branches below).

// Install the embed shim + link trapping on any tm-open-window "single tiddler window" the
// wiki has opened. TiddlyWiki opens these with window.open("","external-<id>") and renders
// into them live, so there is no URL to intercept and no NW.js window handle — we reach each
// popup through the wiki's own $tw.windows registry and install once TW has written the popup's
// document. embeds.install is idempotent per document, so this is safe to call repeatedly.
function installEmbedsOnTiddlerWindows() {
	var attempts = 0;
	function tick() {
		attempts++;
		var pending = false;
		try {
			var wins = $tw && $tw.windows;
			if (wins) {
				Object.keys(wins).forEach(function (id) {
					var w = wins[id];
					if (!w || w.__tdPopupFeatures) {
						return;
					}
					// Wait until TW has written the popup's <body> before installing.
					if (!w.document || !w.document.body) {
						pending = true;
						return;
					}
					w.__tdPopupFeatures = true;
					// Honour the same per-wiki $:/config/TiddlyDesktop/EmbedHosts as the wiki.
					try {
						if (!w.$tw) {
							w.$tw = $tw;
						}
					} catch (e) {}
					require("../js/utils/embeds.js").install(
						w.document,
						w,
					);
					require("../js/utils/links.js").trapLinks(
						w.document,
					);
				});
			} else {
				pending = true;
			}
		} catch (e) {
			console.error(
				"[TiddlyDesktop] tiddler-window embeds install failed:",
				e,
			);
		}
		// TW writes/renders the popup synchronously right after window.open() returns, so the
		// first deferred tick normally finds it ready; retry a few times only as a safety net.
		if (pending && attempts < 10) {
			setTimeout(tick, 50);
		}
	}
	setTimeout(tick, 0);
}

try {
	containerWindow.on("new-win-policy", function (frame, url, policy) {
		if (url && /^file:\/\//i.test(url)) {
			policy.ignore(); // we open it ourselves below
			require("nw.gui").Window.open(
				url,
				{ show: true },
				function (newWin) {
					newWin.once("loaded", function () {
						try {
							require("../js/utils/embeds.js").install(
								newWin.window
									.document,
								newWin.window,
							);
							require("../js/utils/links.js").trapLinks(
								newWin.window
									.document,
							);
						} catch (e) {
							console.error(
								"[TiddlyDesktop] popup feature install failed:",
								e,
							);
						}
					});
					try {
						newWin.focus();
					} catch (e) {}
				},
			);
		} else if (!url || /^about:blank/i.test(url)) {
			// tm-open-window ("single tiddler window"): TiddlyWiki calls
			// window.open("","external-<id>") and renders the tiddler LIVE into the resulting
			// about:blank window. There is no URL to load and we must NOT cancel it (TW needs
			// the window.open() return value to render into). So let it open and install the
			// embed shim on it ourselves once TW has written its content — otherwise allowlisted
			// media (YouTube etc.) hits the file:// referer error (153) in these windows too.
			installEmbedsOnTiddlerWindows();
		}
	});
} catch (e) {
	console.error("[TiddlyDesktop] new-win-policy install failed:", e);
}
