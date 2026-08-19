/*
Node-backed bridges for a wiki rendering in an nwdisable iframe.

The wiki has no Node — that is the whole point of the iframe — so the parent performs the few
privileged operations the collab plugin needs on its behalf: HTTP, WebSocket, the LAN node, a
file read/write bridge and Shell.openExternal. Each is driven by a queue the parent drains from
its OWN event loop, because nwdisable also suppresses I/O initiated from the iframe's call stack.

Extracted from wiki-file-window.js so folder wikis can use it too. Before phase 9 they did not
need it: they ran with full Node in-page, which is exactly what that phase removed. This is what
collapses asset-util.js's nodeFs-or-bridge split into one path in practice — both wiki kinds now
take the bridge.

	install({
		iframe, window_nwjs, pathname, identifier,
		wikiDir,     // the directory the wiki may reach without a grant; see below
		teardowns,   // array; cleanup functions are pushed onto it
		owner        // the window object, for $tw.desktop.oauthOriginWindow
	})

Every path constraint lives in utils/trust.js; see the comments below and
docs/security-model.md.
*/

"use strict";

exports.install = function(host) {
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
	host.iframe.contentWindow._nwjsHttpQueue = [];
	host.iframe.contentWindow._nwjsHttpResults = {};
	// Parent-side queue processor — runs entirely in parent context.
	var _queueTimer = setInterval(function () {
		try {
			var cw = host.iframe.contentWindow;
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
	host.teardowns.push(function () {
		clearInterval(_queueTimer);
	});
	// Shell.openExternal bridge (GUI call — not affected by nwdisable).
	host.iframe.contentWindow._nwjsOpenExternal = function (url) {
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
			$tw.desktop.oauthOriginWindow = host.owner;
		} catch (e) {}
		$tw.desktop.gui.Shell.openExternal(url);
	};
	// Notify oauth.js that the queue is ready.
	if (
		typeof host.iframe.contentWindow._nwjsHttpQueueReady ===
		"function"
	) {
		host.iframe.contentWindow._nwjsHttpQueueReady();
	}
	// File read/write bridge for the collab asset-transfer feature. The nwdisable
	// iframe can't use fs; the parent performs the op (relative paths resolved
	// against the wiki's own directory) and returns the result via the same
	// polled results-store pattern as the HTTP bridge.
	var _fsMod = require("fs"),
		_pathMod = require("path");
	// Supplied by the caller, never derived: a single-file wiki's pathname is a FILE inside its
	// directory, a folder wiki's pathname IS the directory. Deriving with dirname() would be
	// right for one and grant a folder wiki its parent directory — and everything beside it.
	var _wikiDir = host.wikiDir;
	host.iframe.contentWindow._nwjsWikiDir = _wikiDir;
	// Machine hostname for a stable, clone-proof collab device name.
	try {
		host.iframe.contentWindow._nwjsHostname =
			require("os").hostname();
	} catch (_e) {}
	host.iframe.contentWindow._nwjsFileCmdQueue = [];
	host.iframe.contentWindow._nwjsFileResults = {};
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
	var _trust = require("./trust.js");
	var _trustId = host.identifier;
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
	host.iframe.contentWindow._nwjsChooseSavePath = function (
		suggestedName,
		cb,
	) {
		var hostDoc = host.window_nwjs.window.document;
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
			var cw = host.iframe.contentWindow;
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
	host.teardowns.push(function () {
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
	host.iframe.contentWindow._nwjsWsCmdQueue = [];
	host.iframe.contentWindow._nwjsWsEventQueue = [];
	var _wsTimer = setInterval(function () {
		try {
			var cw = host.iframe.contentWindow;
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
	host.teardowns.push(function () {
		clearInterval(_wsTimer);
		Object.keys(_wsPool).forEach(function (id) {
			try {
				_wsPool[id].terminate();
			} catch (_e) {}
		});
		_wsPool = {};
	});
	// Iframe interface: push commands to the queue; the setInterval handles them.
	host.iframe.contentWindow._nwjsWsCreate = function (
		url,
		headers,
	) {
		var id = ++_wsIdSeq;
		host.iframe.contentWindow._nwjsWsCmdQueue.push({
			op: "create",
			id: id,
			url: url,
			headers: headers || {},
		});
		return id;
	};
	host.iframe.contentWindow._nwjsWsSend = function (id, data) {
		host.iframe.contentWindow._nwjsWsCmdQueue.push({
			op: "send",
			id: id,
			data: data,
		});
	};
	host.iframe.contentWindow._nwjsWsTerminate = function (id) {
		host.iframe.contentWindow._nwjsWsCmdQueue.push({
			op: "terminate",
			id: id,
		});
	};
	// Notify transport.js that the WebSocket bridge is ready.
	if (
		typeof host.iframe.contentWindow._nwjsWsBridgeReady ===
		"function"
	) {
		host.iframe.contentWindow._nwjsWsBridgeReady();
	}
	// ── LAN bridge ──
	// The iframe (nwdisable) can't listen on a socket or run Node crypto, so the
	// parent runs the LAN node (lan-node.js) on its behalf. The iframe pushes
	// commands (init/addpeer/broadcast/close) to a queue and receives events
	// (ready/message/peers); all socket + crypto work happens inside the parent's
	// setInterval tick, never the iframe's call stack (which nwdisable suppresses).
	var _lanNode = null;
	host.iframe.contentWindow._nwjsLanCmdQueue = [];
	host.iframe.contentWindow._nwjsLanEventQueue = [];
	var _lanTimer = setInterval(function () {
		try {
			var cw = host.iframe.contentWindow;
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
							require("./lan-node.js").createLanNode(
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
	host.teardowns.push(function () {
		clearInterval(_lanTimer);
		if (_lanNode) {
			try {
				_lanNode.close();
			} catch (_e) {}
			_lanNode = null;
		}
	});
	host.iframe.contentWindow._nwjsLanInit = function (
		roomKeyHex,
		did,
	) {
		host.iframe.contentWindow._nwjsLanCmdQueue.push({
			op: "init",
			roomKeyHex: roomKeyHex,
			deviceId: did,
		});
	};
	host.iframe.contentWindow._nwjsLanAddPeer = function (
		did,
		pubKeyB64,
		endpoints,
	) {
		host.iframe.contentWindow._nwjsLanCmdQueue.push({
			op: "addpeer",
			deviceId: did,
			pubKeyB64: pubKeyB64,
			endpoints: endpoints,
		});
	};
	host.iframe.contentWindow._nwjsLanBroadcast = function (json) {
		host.iframe.contentWindow._nwjsLanCmdQueue.push({
			op: "broadcast",
			json: json,
		});
	};
	host.iframe.contentWindow._nwjsLanClose = function () {
		host.iframe.contentWindow._nwjsLanCmdQueue.push({
			op: "close",
		});
	};
	// Notify transport.js that the LAN bridge is ready.
	if (
		typeof host.iframe.contentWindow._nwjsLanBridgeReady ===
		"function"
	) {
		host.iframe.contentWindow._nwjsLanBridgeReady();
	}
} catch (_bridgeErr) {
	console.error(
		"[TiddlyDesktop] Bridge injection failed:",
		_bridgeErr,
	);
}
};
