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

// External attachments for folder wikis. The stock external-attachments plugin only
// activates when the wiki document is itself a file:// URL (single-file wikis) and
// computes the path relative to document.location — neither holds for a folder wiki,
// which renders from a fixed app page (html/wiki-folder-window.html), not the wiki file.
// Here we have Node and the app's --allow-file-access flags, so we can reference the
// dropped file in place via an ABSOLUTE file:// URI that the renderer loads directly —
// no HTTP server needed. Honours the same Enable switch. We register this hook FIRST so
// it authoritatively handles binary imports before the stock plugin (whose relative-path
// logic would otherwise produce a broken _canonical_uri here).
(function () {
	if (!$tw.hooks || !$tw.hooks.addHook) {
		return;
	}
	function folderExternalAttachmentHook(info) {
		try {
			if (
				info &&
				info.isBinary &&
				info.file &&
				info.file.path &&
				$tw.wiki.getTiddlerText(
					"$:/config/ExternalAttachments/Enable",
					"",
				) === "yes"
			) {
				var p = String(info.file.path).replace(
					/\\/g,
					"/",
				);
				if (p.charAt(0) !== "/") {
					p = "/" + p;
				} // -> file:///C:/... on Windows
				info.callback([
					{
						title: info.file.name,
						type: info.type,
						_canonical_uri:
							"file://" +
							encodeURI(p),
					},
				]);
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
	var arr = $tw.hooks.names && $tw.hooks.names["th-importing-file"];
	if (arr && typeof arr.unshift === "function") {
		arr.unshift(folderExternalAttachmentHook); // run before the stock plugin's hook
	} else {
		$tw.hooks.addHook(
			"th-importing-file",
			folderExternalAttachmentHook,
		);
	}
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
