/*
Class for wiki file windows
*/

"use strict";

var windowBase = require("../js/window-base.js"),
	hash = require("../js/utils/hash.js"),
	spellcheck = require("../js/utils/spellcheck.js"),
	wikiServer = require("../js/utils/wiki-server.js"),
	fs = require("fs"),
	pathMod = require("path");

// Constructor
function WikiFileWindow(options) {
	var self = this;
	options = options || {};
	// Save the options
	this.windowList = options.windowList;
	this.info = options.info || {};
	this.pathname = options.info.pathname;
	this.mustQuitOnClose = options.mustQuitOnClose;
	console.log("Opening window with id", this.getIdentifier());
	// The window is served over loopback HTTP rather than loaded from file:// — see
	// utils/wiki-server.js and DESIGN-http-wiki-origin.md. The shell keeps Node (its path
	// matches the manifest's node-remote), the wiki one path segment away does not, and both
	// share an origin so the parent's cross-document access still works.
	//
	// The server has to be listening before the window opens, so the open moves inside its
	// callback. If it cannot start there is no safe fallback — loading the wiki from file://
	// would silently reinstate the ambient file access this exists to remove — so we report and
	// give up on the window rather than degrade quietly.
	wikiServer.start(
		{
			appDir: pathMod.resolve(__dirname, ".."),
			wikiDir: pathMod.dirname(this.pathname),
			wikiFile: pathMod.basename(this.pathname),
			identifier: this.getIdentifier(),
		},
		function (err, handle) {
			if (err || !handle) {
				console.error(
					"[TiddlyDesktop] could not start the wiki server:",
					err && err.message,
				);
				$tw.desktop.utils.wiki.alert(
					"Could not open this wiki: its local server failed to start. " +
						((err && err.message) || ""),
				);
				return;
			}
			self.server = handle;
			$tw.desktop.gui.Window.open(
				handle.shellUrl,
				self.applyGeometryToOpenOptions({
					id: hash.simpleHash(
						self.getIdentifier(),
					),
					show: true,
					icon: "images/app-icon256.png",
				}),
				function (win) {
					self.window_nwjs = win;
					self.window_nwjs.once(
						"loaded",
						self.onloaded.bind(self),
					);
					self.window_nwjs.on(
						"close",
						self.onclose.bind(self),
					);
					self.trackGeometry();
					self.restoreMaximizedState();
				},
			);
		},
	);
}

// Static method for getting the identifier for the specified info
WikiFileWindow.getIdentifierFromInfo = function (info) {
	return "wikifile://" + info.pathname;
};

// Static method for getting the path for the specified info
WikiFileWindow.getPathnameFromInfo = function (info) {
	return info.pathname;
};

// Static method to indicate that this window generates backups
WikiFileWindow.hasBackups = function () {
	return true;
};

windowBase.addBaseMethods(WikiFileWindow.prototype);

// Returns true if the provided parameters are the same as the ones used to create this window
WikiFileWindow.prototype.matchInfo = function (info) {
	return info.pathname === this.pathname;
};

// The identifier for wiki file windows is the prefix `wikifile://` plus the pathname of the file
WikiFileWindow.prototype.getIdentifier = function () {
	return WikiFileWindow.getIdentifierFromInfo({
		pathname: this.pathname,
	});
};

// Load handler for window
WikiFileWindow.prototype.onloaded = function (event) {
	this.window_nwjs.window.$tw = $tw;
	// Show dev tools on F12
	$tw.desktop.utils.devtools.trapDevTools(
		this.window_nwjs,
		this.window_nwjs.window.document,
	);
	// Add menu
	$tw.desktop.utils.menu.createMenuBar(this.window_nwjs);
	// Point the iframe at the wiki on our own loopback origin. The server URL-encodes the
	// filename, so the "#" escaping the old file:// URL needed is handled there.
	this.iframe = this.window_nwjs.window.document.getElementById(
		"tid-main-wiki-file-viewer",
	);
	this.iframe.src = this.server.wikiUrl;
	this.iframe.onload = this.onloadiframe.bind(this);
	// Show dev tools
	// this.window_nwjs.showDevTools(this.iframe);
	// Save the wiki list tiddler
	this.saveWikiListTiddler();
	// ── popup windows (tm-open-window) ──────────────────────────────────────────
	// TiddlyWiki's tm-open-window calls window.open() from within the nwdisable
	// iframe. Patching iframe.contentWindow.open at the JS level is unreliable
	// (NW.js can bypass it for nwdisable frames). new-win-policy fires at the
	// native NW.js level and is guaranteed to catch every popup request. We
	// open the window ourselves with gui.Window.open() so we have a real window
	// reference and can install TiddlyDesktop features from the backstage.
	try {
		var self = this;
		this.window_nwjs.on(
			"new-win-policy",
			function (frame, url, policy) {
				// INVARIANT: nothing on the shell path may ever open outside the
				// nwdisable subtree. That path is Node-enabled (it is what the
				// manifest's node-remote matches), and a top-level window or a
				// plain sibling frame on it gets full Node — measured, with
				// arbitrary execution confirmed. The wiki must never be able to
				// navigate itself there, so refuse outright rather than open it.
				if (self.server && self.server.isShellUrl(url)) {
					console.warn(
						"[TiddlyDesktop] refused to open a shell-path URL from the wiki:",
						url,
					);
					policy.ignore();
					return;
				}
				if (url && /^file:\/\//i.test(url)) {
					policy.ignore(); // we open it ourselves below
					$tw.desktop.gui.Window.open(
						url,
						{ show: true },
						function (newWin) {
							newWin.once(
								"loaded",
								function () {
									try {
										require("./utils/embeds.js").install(
											newWin
												.window
												.document,
											newWin.window,
										);
										require("./utils/links.js").trapLinks(
											newWin
												.window
												.document,
										);
									} catch (e) {
										console.error(
											"[TiddlyDesktop] popup feature install failed:",
											e,
										);
									}
								},
							);
							try {
								newWin.focus();
							} catch (e) {}
						},
					);
				} else if (!url || /^about:blank/i.test(url)) {
					// tm-open-window ("single tiddler window"): TiddlyWiki calls
					// window.open("","external-<id>") from inside the nwdisable iframe and
					// renders the tiddler LIVE into the resulting about:blank window. There is
					// no URL to load and no NW.js handle to grab, and we must NOT cancel it (TW
					// needs the window.open() return value to render into). So let it open and
					// install the embed shim on it ourselves once TW has written its content —
					// otherwise allowlisted media (YouTube etc.) hits the file:// referer error
					// (153) in these windows too.
					self.installEmbedsOnTiddlerWindows();
				}
			},
		);
	} catch (e) {
		console.error(
			"[TiddlyDesktop] new-win-policy install failed:",
			e,
		);
	}
	// Show the window
	this.window_nwjs.show();
	this.window_nwjs.focus();
};

// Install the embed shim + link trapping on any tm-open-window "single tiddler window" the
// wiki has opened. TiddlyWiki opens these with window.open("","external-<id>") and renders
// into them live, so there is no URL to intercept and no NW.js window handle — we reach each
// popup through the wiki's own $tw.windows registry (which, for a single-file wiki, lives in
// the iframe's TiddlyWiki) and install once TW has written the popup's document. embeds.install
// is idempotent per document, so this is safe to call on every popup request.
WikiFileWindow.prototype.installEmbedsOnTiddlerWindows = function () {
	var self = this;
	var attempts = 0;
	function tick() {
		attempts++;
		var pending = false;
		try {
			var iframeWin =
				self.iframe && self.iframe.contentWindow;
			var tw = iframeWin && iframeWin.$tw;
			var wins = tw && tw.windows;
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
							w.$tw = tw;
						}
					} catch (e) {}
					require("./utils/embeds.js").install(
						w.document,
						w,
					);
					require("./utils/links.js").trapLinks(
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
};

// Apply the current local-spellcheck setting and language to the wiki's iframe document. Safe to call any time.
WikiFileWindow.prototype.applySpellcheck = function () {
	try {
		spellcheck.applyToDocument(this.iframe && this.iframe.contentDocument,
			spellcheck.isEnabled($tw), spellcheck.getLanguage($tw));
	} catch (e) {}
};

// Load handler for iframe
WikiFileWindow.prototype.onloadiframe = function () {
	var self = this;
	// onloadiframe runs on EVERY iframe load, including in-place reloads (Ctrl-R) — the
	// NW window survives, only the iframe's document/window is replaced. The bridges
	// below each own a setInterval drain loop (and the WS/LAN ones own live sockets);
	// previously they were torn down only when the NW window CLOSED, so every reload
	// stacked another full set on top of the old ones. Two WS drain loops then raced
	// over the same (new) command queue with different socket pools, so send/terminate
	// ops landed in the wrong pool and were silently dropped — and the pre-reload relay
	// socket was never closed — which is why collab could not reconnect after a reload.
	// Run the previous load's teardown first, then rebuild from a clean slate. A single
	// close handler (bound once) drains whatever is registered for the current load.
	if (self._iframeTeardowns) {
		self._iframeTeardowns.forEach(function (fn) {
			try {
				fn();
			} catch (_e) {}
		});
	}
	self._iframeTeardowns = [];
	// Apply the local-spellcheck toggle to this (re)loaded document. Runs on every load and can be
	// re-run live via applySpellcheck() when the setting changes.
	self.applySpellcheck();
	if (!self._iframeCloseBound) {
		self._iframeCloseBound = true;
		self.window_nwjs.once("close", function () {
			(self._iframeTeardowns || []).forEach(function (fn) {
				try {
					fn();
				} catch (_e) {}
			});
			self._iframeTeardowns = [];
		});
	}
	// Get the mutation observer prototype for the window
	var MutationObserver = this.window_nwjs.window.MutationObserver;
	// Enable saving
	var areBackupsEnabledFn = function () {
			return (
				$tw.wiki.getTiddlerText(
					self.getConfigTitle("disable-backups"),
					"no",
				) !== "yes"
			);
		},
		loadFileTextFn = function () {
			return fs.readFileSync(self.pathname, "utf8");
		},
		backupCountFn = function () {
			return $tw.wiki.getTiddlerText(
				self.getConfigTitle("backup-count"),
				"",
			);
		},
		// The one file this window owns — the only path the saver will ever write to,
		// whatever path the wiki's own scripts put on the TiddlyFox save message.
		getPathnameFn = function () {
			return self.pathname;
		};
	$tw.desktop.utils.saving.enableSaving(
		this.iframe.contentDocument,
		areBackupsEnabledFn,
		loadFileTextFn,
		backupCountFn,
		getPathnameFn,
	);
	// Trap links
	$tw.desktop.utils.links.trapLinks(this.iframe.contentDocument);
	// Intercept cross-browser drag-drop imports so tiddlers dragged from Firefox
	// (which Chromium otherwise hands to TW as text/html) keep their fields
	$tw.desktop.utils.dragdrop.installImportInterceptor(
		this.iframe.contentDocument,
		this.iframe.contentWindow,
		{
			parentDocument: this.window_nwjs.window.document,
			parentWindow: this.window_nwjs.window,
		},
	);
	// ── grant-on-add ────────────────────────────────────────────────────────────
	// A file the user drags into the wiki, or picks in its import dialog, is a path
	// they chose — and we witness it here in the parent. Record it as trusted so the
	// attachment renders later without asking again. Same gesture-based rule as the
	// save dialog, applied on the way in rather than the way out.
	//
	// Scoped to exactly what was picked: the file, never its folder. Widening "I
	// chose this image" into "this wiki may read ~/Pictures" would claim authority
	// the user never gave; folder trust stays an explicit choice.
	//
	// Script cannot manufacture these grants. NW.js sets `path` only on File objects
	// that came from a real user selection, so a File built in script has none and
	// grants nothing. The isTrusted check is a second line, not the basis.
	try {
		var _trustMod = require("./utils/trust.js");
		var _wikiId = self.getIdentifier();
		var _grantFiles = function (files) {
			if (!files) {
				return;
			}
			for (var i = 0; i < files.length; i++) {
				var p = files[i] && files[i].path;
				if (p) {
					_trustMod.grant(_wikiId, p, "file");
				}
			}
		};
		var _onDrop = function (ev) {
			if (!ev || !ev.isTrusted) {
				return;
			}
			try {
				_grantFiles(ev.dataTransfer && ev.dataTransfer.files);
			} catch (e) {}
		};
		var _onFileInput = function (ev) {
			var t = ev && ev.target;
			if (!ev.isTrusted || !t || t.tagName !== "INPUT") {
				return;
			}
			if (String(t.type).toLowerCase() !== "file") {
				return;
			}
			try {
				_grantFiles(t.files);
			} catch (e) {}
		};
		var _gdoc = this.iframe.contentDocument;
		// Capture phase, so a wiki that stops propagation on its own handlers cannot
		// prevent the grant being recorded for a file the user really did choose.
		_gdoc.addEventListener("drop", _onDrop, true);
		_gdoc.addEventListener("change", _onFileInput, true);
		self._iframeTeardowns.push(function () {
			try {
				_gdoc.removeEventListener("drop", _onDrop, true);
			} catch (e) {}
			try {
				_gdoc.removeEventListener("change", _onFileInput, true);
			} catch (e) {}
		});
	} catch (e) {
		console.error("[TiddlyDesktop] grant-on-add install failed:", e);
	}
	// Browser-style find-in-page (Ctrl/Cmd+F). The bar lives in the outer wiki
	// window and searches the iframe content; it defers to any focused editor that
	// claims the shortcut (e.g. CodeMirror 6).
	try {
		$tw.desktop.utils.findbar.installFindBar({
			hostWindow: this.window_nwjs.window,
			hostDocument: this.window_nwjs.window.document,
			getContentWindow: function () {
				return self.iframe.contentWindow;
			},
			getContentDocument: function () {
				return self.iframe.contentDocument;
			},
		});
	} catch (e) {
		console.error("[TiddlyDesktop] find bar install failed:", e);
	}
	// Fullscreen (F11 + the wiki's fullscreen button → native window) is handled in the wiki
	// window's OWN process by wiki-file-fullscreen.js (loaded from wiki-file-window.html), NOT
	// here in backstage: window state/events/timers are not reliably observable across the
	// process boundary, which is why the backstage approach never worked for single-file wikis.
	// Page zoom: shortcuts bound on both the outer window and the iframe, with the reset
	// control living in the outer window (outside the wiki content, like the find bar).
	try {
		require("./utils/zoom.js").install(
			this.window_nwjs,
			this.window_nwjs.window.document,
			this.iframe.contentDocument,
		);
	} catch (e) {
		console.error("[TiddlyDesktop] zoom install failed:", e);
	}
	// Grey out permalink/permaview — no shareable URL in a desktop wiki window. The wiki
	// renders inside the iframe, so the style goes into the iframe's document.
	try {
		require("./utils/disable-permalinks.js").install(
			this.iframe.contentDocument,
		);
	} catch (e) {
		console.error(
			"[TiddlyDesktop] disable-permalinks install failed:",
			e,
		);
	}
	// Route absolute file:// attachments onto the attachment origin, which serves them only if
	// the user has trusted the path for this wiki. Relative attachments need nothing — they
	// resolve against the wiki's own URL and the wiki server serves them.
	try {
		require("./utils/attachments.js").install(
			this.iframe.contentDocument,
			this.iframe.contentWindow,
			this.server,
		);
	} catch (e) {
		console.error("[TiddlyDesktop] attachment routing install failed:", e);
	}
	// In-wiki offer to trust an attachment's location. The panel only ASKS; the picker below is
	// opened, held and read by the parent, so nothing is granted without a real selection.
	try {
		var _tuSelf = this;
		var _trustUi = require("./utils/trust-ui.js").install(
			this.iframe.contentDocument,
			this.iframe.contentWindow,
			{
				identifier: this.getIdentifier(),
				wikiDir: pathMod.dirname(this.pathname),
				openPicker: function (kind, seedPath, cb) {
					var hostDoc =
						_tuSelf.window_nwjs.window.document;
					var input = hostDoc.createElement("input");
					input.type = "file";
					if (kind === "dir") {
						input.setAttribute("nwdirectory", "");
					}
					if (seedPath) {
						input.setAttribute(
							"nwworkingdir",
							String(seedPath),
						);
					}
					input.style.display = "none";
					hostDoc.body.appendChild(input);
					input.addEventListener("change", function () {
						var chosen = input.value
							? pathMod.resolve(input.value)
							: null;
						try {
							input.parentNode.removeChild(
								input,
							);
						} catch (e) {}
						try {
							cb(chosen);
						} catch (e) {}
					});
					input.click();
				},
			},
		);
		if (_trustUi) {
			self._iframeTeardowns.push(_trustUi.teardown);
		}
	} catch (e) {
		console.error("[TiddlyDesktop] trust UI install failed:", e);
	}
	// Safe external embeds: enforce the allowlist and route allowlisted media iframes through
	// a loopback http shim (real origin -> avoids YouTube's file:// error 153). The wiki
	// document stays file://, so saving and the collab bridges below are unaffected.
	try {
		require("./utils/embeds.js").install(
			this.iframe.contentDocument,
			this.iframe.contentWindow,
		);
	} catch (e) {
		console.error("[TiddlyDesktop] embeds install failed:", e);
	}
	// tm-open-window popups: besides the native new-win-policy hook (set up in onloaded), also
	// listen for TiddlyWiki's own "window:opened" signal from inside the iframe. new-win-policy
	// from an nwdisable iframe has been unreliable in some NW.js versions, whereas this fires
	// exactly when TW opens a "single tiddler window" — so the embed shim gets installed there
	// too and allowlisted media (YouTube etc.) plays instead of hitting the file:// error 153.
	// Feature-detected: older wikis without an eventBus just rely on new-win-policy. Removed on
	// the next iframe (re)load via the teardown list.
	try {
		var iframeTw =
			self.iframe.contentWindow &&
			self.iframe.contentWindow.$tw;
		if (iframeTw && iframeTw.eventBus && iframeTw.eventBus.on) {
			var onPopupOpened = function () {
				self.installEmbedsOnTiddlerWindows();
			};
			iframeTw.eventBus.on("window:opened", onPopupOpened);
			self._iframeTeardowns.push(function () {
				try {
					iframeTw.eventBus.off(
						"window:opened",
						onPopupOpened,
					);
				} catch (e) {}
			});
		}
	} catch (e) {
		console.error(
			"[TiddlyDesktop] tiddler-window watch failed:",
			e,
		);
	}
	// Observe mutations of the title element of the iframe
	this.titleObserver = new MutationObserver(
		this.extractIframeTitle.bind(this),
	);
	var iframeTitleNode =
		this.iframe.contentDocument.getElementsByTagName("title")[0];
	this.extractIframeTitle();
	this.titleObserver.observe(iframeTitleNode, {
		attributes: true,
		childList: true,
		characterData: true,
	});
	// Observe mutations of the favicon element of the iframe
	var faviconLink =
		this.iframe.contentDocument.getElementById("faviconLink");
	this.favIconObserver = new MutationObserver(
		this.extractIframeFavicon.bind(this),
	);
	this.extractIframeFavicon();
	if (faviconLink) {
		this.favIconObserver.observe(faviconLink, {
			attributes: true,
			childList: true,
			characterData: true,
		});
	}
	// HTTP queue bridge for plugins running inside the nwdisable iframe.
	// nwdisable strips Node.js and suppresses any network I/O initiated from the
	// iframe's call stack. Solution: the parent owns a setInterval that drains a
	// shared request queue entirely from its own event loop tick. The iframe pushes
	// requests and polls results as plain window properties — no cross-context
	// function calls needed during async operations.
	try {
		var _httpsM = require("https"),
			_httpM = require("http");
		// Initialise the shared queue/results store visible to the iframe.
		self.iframe.contentWindow._nwjsHttpQueue = [];
		self.iframe.contentWindow._nwjsHttpResults = {};
		// Parent-side queue processor — runs entirely in parent context.
		var _queueTimer = setInterval(function () {
			try {
				var cw = self.iframe.contentWindow;
				var queue = cw._nwjsHttpQueue;
				if (!queue || !queue.length) return;
				var item = queue.shift();
				// Web schemes only. This bridge answers with the raw response body, so it
				// is a CORS-free fetch — a real capability the file:// page does not
				// otherwise have. It is NOT host-scoped: collab relays are frequently
				// self-hosted on a LAN or on localhost, so pinning to a host list would
				// break legitimate setups. The residual surface is reads of whatever HTTP
				// endpoints the machine can reach; see the note in the audit.
				if (!/^https?:\/\//i.test(String(item.url || ""))) {
					var _r = cw._nwjsHttpResults;
					if (_r) {
						_r[item.id] = { err: "URL scheme not permitted" };
					}
					return;
				}
				var mod =
					item.url.substr(0, 8) === "https://"
						? _httpsM
						: _httpM;
				mod.get(
					item.url,
					{ headers: item.headers || {} },
					function (res) {
						var body = "";
						res.setEncoding("utf8");
						res.on("data", function (c) {
							body += c;
						});
						res.on("end", function () {
							var results =
								cw._nwjsHttpResults;
							if (!results) return;
							if (
								res.statusCode <
									200 ||
								res.statusCode >=
									300
							) {
								results[
									item.id
								] = {
									err:
										"HTTP " +
										res.statusCode,
								};
							} else {
								try {
									results[
										item.id
									] = {
										data: JSON.parse(
											body,
										),
									};
								} catch (e) {
									results[
										item.id
									] = {
										err: "Invalid JSON",
									};
								}
							}
						});
					},
				).on("error", function (e) {
					var results = cw._nwjsHttpResults;
					if (results)
						results[item.id] = {
							err:
								e.message ||
								String(e),
						};
				});
			} catch (_e) {}
		}, 200);
		self._iframeTeardowns.push(function () {
			clearInterval(_queueTimer);
		});
		// Shell.openExternal bridge (GUI call — not affected by nwdisable).
		self.iframe.contentWindow._nwjsOpenExternal = function (url) {
			// Only ever hand the OS a web URL. openExternal invokes the system handler for
			// whatever scheme it is given, so an unrestricted bridge would let wiki script
			// launch local files (file://), UNC paths, and any exotic scheme the OS has
			// registered. The only caller is the OAuth flow, which opens https:// provider
			// pages, so an allowlist costs nothing.
			if (!/^https?:\/\//i.test(String(url))) {
				console.warn(
					"[TiddlyDesktop] refusing to open a non-web URL:",
					url,
				);
				return;
			}
			// Remember which window opened an external URL, so the OAuth deep-link return
			// (tiddlydesktop://auth…) re-focuses THIS window — the one sign-in was started
			// from — rather than the backstage window.
			try {
				$tw.desktop.oauthOriginWindow = self;
			} catch (e) {}
			$tw.desktop.gui.Shell.openExternal(url);
		};
		// Notify oauth.js that the queue is ready.
		if (
			typeof self.iframe.contentWindow._nwjsHttpQueueReady ===
			"function"
		) {
			self.iframe.contentWindow._nwjsHttpQueueReady();
		}
		// File read/write bridge for the collab asset-transfer feature. The nwdisable
		// iframe can't use fs; the parent performs the op (relative paths resolved
		// against the wiki's own directory) and returns the result via the same
		// polled results-store pattern as the HTTP bridge.
		var _fsMod = require("fs"),
			_pathMod = require("path");
		var _wikiDir = _pathMod.dirname(self.pathname);
		self.iframe.contentWindow._nwjsWikiDir = _wikiDir;
		// Machine hostname for a stable, clone-proof collab device name.
		try {
			self.iframe.contentWindow._nwjsHostname =
				require("os").hostname();
		} catch (_e) {}
		self.iframe.contentWindow._nwjsFileCmdQueue = [];
		self.iframe.contentWindow._nwjsFileResults = {};
		var _resolveAssetPath = function (p) {
			p = String(p || "");
			if (/^file:\/\//i.test(p)) {
				p = p.replace(/^file:\/\//i, "");
			}
			// _canonical_uri is URL-encoded (spaces as %20, etc.); decode it for BOTH file:// and
			// relative paths, otherwise a relative attachment with a space resolves to a literal
			// "Screenshot%20bla.png" that doesn't exist.
			try {
				p = decodeURI(p);
			} catch (e) {}
			return _pathMod.isAbsolute(p)
				? p
				: _pathMod.resolve(_wikiDir, p);
		};
		// ── which paths this bridge may touch ────────────────────────────────
		// The wiki renders in an nwdisable iframe precisely so its scripts get no
		// filesystem access; this bridge hands a slice of that back for the collab
		// asset feature. So the PARENT decides what is reachable, never the iframe:
		//
		//   • anything inside the wiki's own directory — the wiki can already write
		//     there through the saver, so this grants nothing new; and
		//   • anything else only if the USER picked it in a dialog the parent opened
		//     and whose result the parent read itself (_nwjsChooseSavePath below).
		//
		// Without this, any script in any wiki you open could read or write any file
		// the user can — an arbitrary-write primitive, since the wiki controls the
		// path string completely.
		//
		// Grants persist in the backstage wiki, keyed by this wiki's identifier — see
		// utils/trust.js. They were previously an in-memory map cleared on every iframe
		// load: right for a one-shot save dialog, useless for anything re-read on each
		// render, and it meant the user was re-asked after every reload.
		var _trust = require("./utils/trust.js");
		var _trustId = self.getIdentifier();
		var _pathAllowed = function (abs) {
			// The wiki's own directory is trusted implicitly: the wiki can already write
			// there through the saver, so allowing it grants nothing new.
			return _trust.isTrusted(_trustId, abs, [_wikiDir]);
		};
		// An earlier version asked window.confirm() here before allowing a read outside the
		// wiki folder. That gate does not hold: measured against NW.js 0.114, the parent
		// window's confirm() returns TRUE with no user present and no dialog shown,
		// depending on the window's state at the moment it is called — so a wiki could
		// read any file simply by asking at the right time. It is removed rather than
		// patched, because a dialog that sometimes auto-approves is worse than no dialog:
		// it looks like consent.
		//
		// Out-of-wiki reads are now simply refused unless the path is already trusted.
		// Trust is minted only where the user's choice is unforgeable — the drop/import
		// listener above, and the parent-owned save picker below — never from a prompt
		// whose return value we cannot rely on.
		var _denyFileOp = function (cw, id, abs) {
			console.warn(
				"[TiddlyDesktop] file bridge refused a path outside the wiki folder:",
				abs,
			);
			var r = cw._nwjsFileResults;
			if (r) {
				r[id] = { err: "path not permitted" };
			}
		};
		// Open a native "save as" dialog and approve whatever the user picks. The input
		// is created, held and read by the PARENT, and a file input's value cannot be set
		// by script — so the path that comes back is genuinely the user's choice and the
		// iframe cannot substitute one. This is the only way a path outside the wiki
		// directory ever becomes writable.
		self.iframe.contentWindow._nwjsChooseSavePath = function (
			suggestedName,
			cb,
		) {
			var hostDoc = self.window_nwjs.window.document;
			var input = hostDoc.createElement("input");
			input.type = "file";
			input.setAttribute("nwsaveas", String(suggestedName || ""));
			input.style.display = "none";
			hostDoc.body.appendChild(input);
			input.addEventListener("change", function () {
				var chosen = input.value
					? _pathMod.resolve(input.value)
					: null;
				if (chosen) {
					// The user picked this path in a dialog we opened, so it is a
					// genuine grant and persists — which is also what lets the
					// attachment render later without asking again.
					_trust.grant(_trustId, chosen, "file");
				}
				try {
					input.parentNode.removeChild(input);
				} catch (e) {}
				try {
					cb(chosen);
				} catch (e) {}
			});
			input.click();
		};
		var _fileTimer = setInterval(function () {
			try {
				var cw = self.iframe.contentWindow;
				var q = cw && cw._nwjsFileCmdQueue;
				if (!q || !q.length) return;
				var item = q.shift();
				if (item.op === "read") {
					var src = _resolveAssetPath(item.path);
					if (!_pathAllowed(src)) {
						_denyFileOp(cw, item.id, src);
						return;
					}
					_fsMod.readFile(
						src,
						function (err, buf) {
							var r =
								cw._nwjsFileResults;
							if (!r) return;
							r[item.id] = err
								? {
										err: err.message,
									}
								: {
										data: buf.toString(
											"base64",
										),
									};
						},
					);
				} else if (item.op === "write") {
					var dest = _resolveAssetPath(item.path);
					if (!_pathAllowed(dest)) {
						_denyFileOp(cw, item.id, dest);
						return;
					}
					try {
						_fsMod.mkdirSync(
							_pathMod.dirname(dest),
							{ recursive: true },
						);
					} catch (_e) {}
					_fsMod.writeFile(
						dest,
						Buffer.from(
							item.base64,
							"base64",
						),
						function (err) {
							var r =
								cw._nwjsFileResults;
							if (!r) return;
							r[item.id] = err
								? {
										err: err.message,
									}
								: {
										data: dest,
									};
						},
					);
				}
			} catch (_e) {}
		}, 100);
		self._iframeTeardowns.push(function () {
			clearInterval(_fileTimer);
		});
		// WebSocket bridge — same queue-drain pattern as the HTTP bridge above.
		// All socket creation and event dispatch happen inside the parent's setInterval
		// tick (browser context) to avoid NW.js cross-context callback issues.
		// The iframe pushes commands to _nwjsWsCmdQueue; the parent processes them and
		// pushes events to _nwjsWsEventQueue; the setInterval drains both queues.
		var _wsLib = require("ws");
		var _wsPool = {};
		var _wsIdSeq = 0;
		self.iframe.contentWindow._nwjsWsCmdQueue = [];
		self.iframe.contentWindow._nwjsWsEventQueue = [];
		var _wsTimer = setInterval(function () {
			try {
				var cw = self.iframe.contentWindow;
				if (!cw) return;
				// Process commands queued by the iframe
				var cmds = cw._nwjsWsCmdQueue;
				while (cmds && cmds.length) {
					var cmd = cmds.shift();
					if (cmd.op === "create") {
						// WebSocket schemes only (same reasoning as the HTTP
						// bridge above: not host-scoped, because a self-hosted
						// or localhost relay is a normal setup).
						if (
							!/^wss?:\/\//i.test(
								String(cmd.url || ""),
							)
						) {
							if (cw._nwjsWsEventQueue) {
								cw._nwjsWsEventQueue.push({
									id: cmd.id,
									type: "error",
									data: "URL scheme not permitted",
								});
							}
							continue;
						}
						(function (id, url, hdrs) {
							var wsHeaders = {
								"User-Agent":
									"TiddlyDesktop/1.0 NW.js",
							};
							Object.keys(
								hdrs || {},
							).forEach(function (k) {
								wsHeaders[k] =
									hdrs[k];
							});
							console.log(
								"[ws-bridge] Creating id=" +
									id +
									" url=" +
									url,
							);
							try {
								var sock =
									new _wsLib(
										url,
										{
											headers: wsHeaders,
											perMessageDeflate: false,
											handshakeTimeout: 15000,
										},
									);
								_wsPool[id] =
									sock;
								sock.on(
									"open",
									function () {
										if (
											cw._nwjsWsEventQueue
										)
											cw._nwjsWsEventQueue.push(
												{
													id: id,
													type: "open",
													data: null,
												},
											);
									},
								);
								sock.on(
									"message",
									function (
										d,
										meta,
									) {
										if (
											cw._nwjsWsEventQueue
										)
											cw._nwjsWsEventQueue.push(
												{
													id: id,
													type: "message",
													data:
														meta &&
														meta.binary
															? d
															: d.toString(
																	"utf8",
																),
												},
											);
									},
								);
								// Forward server pings so the iframe's transport has a liveness signal on
								// an otherwise-idle room (ws auto-replies with a pong; we just observe).
								sock.on(
									"ping",
									function () {
										if (
											cw._nwjsWsEventQueue
										)
											cw._nwjsWsEventQueue.push(
												{
													id: id,
													type: "ping",
													data: null,
												},
											);
									},
								);
								sock.on(
									"close",
									function () {
										delete _wsPool[
											id
										];
										if (
											cw._nwjsWsEventQueue
										)
											cw._nwjsWsEventQueue.push(
												{
													id: id,
													type: "close",
													data: null,
												},
											);
									},
								);
								sock.on(
									"error",
									function (
										e,
									) {
										console.error(
											"[ws-bridge] Error id=" +
												id +
												":",
											e &&
												e.message,
										);
										if (
											cw._nwjsWsEventQueue
										)
											cw._nwjsWsEventQueue.push(
												{
													id: id,
													type: "error",
													data:
														(e &&
															e.message) ||
														"",
												},
											);
									},
								);
							} catch (e) {
								console.error(
									"[ws-bridge] create failed:",
									e.message,
								);
								if (
									cw._nwjsWsEventQueue
								)
									cw._nwjsWsEventQueue.push(
										{
											id: id,
											type: "error",
											data: e.message,
										},
									);
							}
						})(
							cmd.id,
							cmd.url,
							cmd.headers,
						);
					} else if (cmd.op === "send") {
						var _s = _wsPool[cmd.id];
						if (_s && _s.readyState === 1) {
							try {
								_s.send(
									cmd.data,
								);
							} catch (_e) {}
						}
					} else if (cmd.op === "terminate") {
						var _t = _wsPool[cmd.id];
						if (_t) {
							try {
								_t.terminate();
							} catch (_e) {}
							delete _wsPool[cmd.id];
						}
					}
				}
				// Dispatch events from ws sockets to the iframe
				var evts = cw._nwjsWsEventQueue;
				if (
					evts &&
					evts.length &&
					typeof cw._nwjsWsOnEvent === "function"
				) {
					while (evts.length) {
						var ev = evts.shift();
						try {
							cw._nwjsWsOnEvent(
								ev.id,
								ev.type,
								ev.data,
							);
						} catch (_e) {}
					}
				}
			} catch (_e) {}
		}, 50);
		self._iframeTeardowns.push(function () {
			clearInterval(_wsTimer);
			Object.keys(_wsPool).forEach(function (id) {
				try {
					_wsPool[id].terminate();
				} catch (_e) {}
			});
			_wsPool = {};
		});
		// Iframe interface: push commands to the queue; the setInterval handles them.
		self.iframe.contentWindow._nwjsWsCreate = function (
			url,
			headers,
		) {
			var id = ++_wsIdSeq;
			self.iframe.contentWindow._nwjsWsCmdQueue.push({
				op: "create",
				id: id,
				url: url,
				headers: headers || {},
			});
			return id;
		};
		self.iframe.contentWindow._nwjsWsSend = function (id, data) {
			self.iframe.contentWindow._nwjsWsCmdQueue.push({
				op: "send",
				id: id,
				data: data,
			});
		};
		self.iframe.contentWindow._nwjsWsTerminate = function (id) {
			self.iframe.contentWindow._nwjsWsCmdQueue.push({
				op: "terminate",
				id: id,
			});
		};
		// Notify transport.js that the WebSocket bridge is ready.
		if (
			typeof self.iframe.contentWindow._nwjsWsBridgeReady ===
			"function"
		) {
			self.iframe.contentWindow._nwjsWsBridgeReady();
		}
		// ── LAN bridge ──
		// The iframe (nwdisable) can't listen on a socket or run Node crypto, so the
		// parent runs the LAN node (lan-node.js) on its behalf. The iframe pushes
		// commands (init/addpeer/broadcast/close) to a queue and receives events
		// (ready/message/peers); all socket + crypto work happens inside the parent's
		// setInterval tick, never the iframe's call stack (which nwdisable suppresses).
		var _lanNode = null;
		self.iframe.contentWindow._nwjsLanCmdQueue = [];
		self.iframe.contentWindow._nwjsLanEventQueue = [];
		var _lanTimer = setInterval(function () {
			try {
				var cw = self.iframe.contentWindow;
				if (!cw) return;
				var cmds = cw._nwjsLanCmdQueue;
				while (cmds && cmds.length) {
					var cmd = cmds.shift();
					if (cmd.op === "init") {
						if (_lanNode) {
							try {
								_lanNode.close();
							} catch (_e) {}
							_lanNode = null;
						}
						try {
							_lanNode =
								require("../js/utils/lan-node.js").createLanNode(
									{
										deviceId: cmd.deviceId,
										roomKey: cmd.roomKeyHex
											? Buffer.from(
													cmd.roomKeyHex,
													"hex",
												)
											: null,
										onReady: function (
											pub,
											eps,
										) {
											if (
												cw._nwjsLanEventQueue
											)
												cw._nwjsLanEventQueue.push(
													{
														type: "ready",
														pub: pub,
														eps: eps,
													},
												);
										},
										onMessage: function (
											peerId,
											json,
										) {
											if (
												cw._nwjsLanEventQueue
											)
												cw._nwjsLanEventQueue.push(
													{
														type: "message",
														peerId: peerId,
														json: json,
													},
												);
										},
										onPeerCount:
											function (
												n,
											) {
												if (
													cw._nwjsLanEventQueue
												)
													cw._nwjsLanEventQueue.push(
														{
															type: "peers",
															n: n,
														},
													);
											},
									},
								);
						} catch (e) {
							console.error(
								"[lan-bridge] init failed:",
								e && e.message,
							);
						}
					} else if (cmd.op === "addpeer") {
						if (_lanNode) {
							_lanNode.addPeer(
								cmd.deviceId,
								cmd.pubKeyB64,
								cmd.endpoints,
							);
						}
					} else if (cmd.op === "broadcast") {
						if (_lanNode) {
							_lanNode.broadcast(
								cmd.json,
							);
						}
					} else if (cmd.op === "close") {
						if (_lanNode) {
							try {
								_lanNode.close();
							} catch (_e) {}
							_lanNode = null;
						}
					}
				}
				var evts = cw._nwjsLanEventQueue;
				while (evts && evts.length) {
					var ev = evts.shift();
					try {
						if (
							ev.type === "ready" &&
							typeof cw._nwjsLanOnReady ===
								"function"
						) {
							cw._nwjsLanOnReady(
								ev.pub,
								ev.eps,
							);
						} else if (
							ev.type === "message" &&
							typeof cw._nwjsLanOnMessage ===
								"function"
						) {
							cw._nwjsLanOnMessage(
								ev.peerId,
								ev.json,
							);
						} else if (
							ev.type === "peers" &&
							typeof cw._nwjsLanOnPeers ===
								"function"
						) {
							cw._nwjsLanOnPeers(
								ev.n,
							);
						}
					} catch (_e) {}
				}
			} catch (_e) {}
		}, 50);
		self._iframeTeardowns.push(function () {
			clearInterval(_lanTimer);
			if (_lanNode) {
				try {
					_lanNode.close();
				} catch (_e) {}
				_lanNode = null;
			}
		});
		self.iframe.contentWindow._nwjsLanInit = function (
			roomKeyHex,
			did,
		) {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({
				op: "init",
				roomKeyHex: roomKeyHex,
				deviceId: did,
			});
		};
		self.iframe.contentWindow._nwjsLanAddPeer = function (
			did,
			pubKeyB64,
			endpoints,
		) {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({
				op: "addpeer",
				deviceId: did,
				pubKeyB64: pubKeyB64,
				endpoints: endpoints,
			});
		};
		self.iframe.contentWindow._nwjsLanBroadcast = function (json) {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({
				op: "broadcast",
				json: json,
			});
		};
		self.iframe.contentWindow._nwjsLanClose = function () {
			self.iframe.contentWindow._nwjsLanCmdQueue.push({
				op: "close",
			});
		};
		// Notify transport.js that the LAN bridge is ready.
		if (
			typeof self.iframe.contentWindow._nwjsLanBridgeReady ===
			"function"
		) {
			self.iframe.contentWindow._nwjsLanBridgeReady();
		}
	} catch (_bridgeErr) {
		console.error(
			"[TiddlyDesktop] Bridge injection failed:",
			_bridgeErr,
		);
	}
	// Run any registered plugin hooks (e.g. collab transport shim)
	($tw.desktop.pluginHooks || []).forEach(function (hook) {
		try {
			hook(self);
		} catch (e) {
			console.error("[TiddlyDesktop] Plugin hook error:", e);
		}
	});
};

// Reopen this window
WikiFileWindow.prototype.reopen = function () {
	this.window_nwjs.focus();
};

// Extract the iframe title
WikiFileWindow.prototype.extractIframeTitle = function () {
	this.wikiTitle = this.iframe.contentDocument.title;
	this.window_nwjs.window.document.title = this.wikiTitle;
	this.onTitleChange();
};

// Get the wiki title
WikiFileWindow.prototype.getWikiTitle = function () {
	return this.wikiTitle;
};

// Extract the iframe favicon
WikiFileWindow.prototype.extractIframeFavicon = function () {
	var faviconLink =
			this.iframe.contentDocument.getElementById(
				"faviconLink",
			),
		href = faviconLink && faviconLink.getAttribute("href");
	// Only a real data: URI is a favicon. A wiki with no $:/favicon.ico leaves the link at
	// its static "favicon.ico" placeholder; writing that as the favicon config left a
	// broken thumbnail in the wiki list instead of the missing-favicon placeholder. Clear
	// it so the list falls back to the placeholder, like folder wikis already do.
	if (href && href.indexOf("data:") === 0) {
		// data URIs look like "data:<type>;base64,<text>"
		var posColon = href.indexOf(":"),
			posSemiColon = href.indexOf(";"),
			posComma = href.indexOf(",");
		this.wikiFavIconType = href.substring(
			posColon + 1,
			posSemiColon,
		);
		this.wikiFavIconText = href.substring(posComma + 1);
		this.onFavIconChange();
	} else {
		this.clearFavIcon();
	}
};

// Extract the wiki favicon text
WikiFileWindow.prototype.getWikiFavIconText = function () {
	return this.wikiFavIconText;
};

// Extract the wiki favicon type
WikiFileWindow.prototype.getWikiFavIconType = function () {
	return this.wikiFavIconType;
};

// Close handler for window
WikiFileWindow.prototype.onclose = function (event) {
	// Check the hosted wiki is happy to close
	var onbeforeunload = this.iframe.contentWindow.onbeforeunload;
	if (onbeforeunload) {
		var msg = onbeforeunload({});
		if (
			msg &&
			!this.window_nwjs.window.confirm(
				msg +
					"\n\nAre you sure you wish to close this wiki?",
			)
		) {
			return false;
		}
	}
	// Delete the mutation observers for the title and the favicon
	this.titleObserver.disconnect();
	this.favIconObserver.disconnect();
	// Stop serving this wiki. The server is per-window and its token dies with it, so a
	// closed wiki is no longer reachable by anything else on the machine.
	if (this.server) {
		try {
			this.server.close();
		} catch (e) {}
		this.server = null;
	}
	// Close the window, remove it from the window list
	this.windowList.handleClose(this, this.mustRemoveFromWikiListOnClose);
};

// Save a tiddler to the backstage wiki describing this wiki file
WikiFileWindow.prototype.saveWikiListTiddler = function () {
	var fields = {
		title: this.getIdentifier(),
		tags: ["wikilist", "wikifile"],
		text: "",
	};
	$tw.wiki.addTiddler(
		new $tw.Tiddler(
			$tw.wiki.getCreationFields(),
			fields,
			$tw.wiki.getModificationFields(),
		),
	);
};

exports.WikiFileWindow = WikiFileWindow;
