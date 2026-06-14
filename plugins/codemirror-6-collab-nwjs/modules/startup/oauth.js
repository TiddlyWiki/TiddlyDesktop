/*\
title: $:/plugins/tiddlywiki/codemirror-6-collab-nwjs/oauth.js
type: application/javascript
module-type: startup

OAuth login flow for the codemirror-6-collab-nwjs relay.

Supports GitHub, GitLab, and OIDC via the relay server's server-side
callback + polling flow (desktop doesn't receive the tiddlydesktop:// deep link):
  1. Fetch available providers from relay GET /api/auth/providers
  2. Build provider authorize URL with redirect_uri = relay callback endpoint
  3. Open system browser (nw.Shell.openExternal)
  4. Poll relay GET /api/auth/result?state={state} every 2 s until token arrives
  5. Store access_token + provider in config tiddlers (triggers transport reconnect)

Config tiddlers written on success:
  $:/config/codemirror-6-collab/auth-token      - OAuth access token (Bearer)
  $:/config/codemirror-6-collab/auth-provider   - "github" | "gitlab" | "oidc"
  $:/config/codemirror-6-collab/auth-username   - display username
  $:/config/codemirror-6-collab/auth-user-id    - prefixed id "github:12345"

Temp tiddlers:
  $:/temp/collab/auth-status                    - progress/error message for UI
  $:/temp/collab/auth-providers/{name}          - one per available provider
\*/

"use strict";

var _nodeHttps = null;
var _nodeHttp  = null;

exports.name = "codemirror-6-collab-nwjs-oauth";
exports.after = ["startup","rootwidget"];
exports.synchronous = true;
exports.platforms = ["browser"];

var POLL_INTERVAL_MS  = 2000;
var OAUTH_TIMEOUT_MS  = 300000; // 5 minutes

// Pending HTTP request callbacks keyed by sequence id (used by queue bridge and
// direct Node.js path).
var _httpCallbacks = {};
var _httpCallbackSeq = 0;
// setInterval handle for draining _nwjsHttpResults written by the parent.
var _resultPollTimer = null;

exports.startup = function() {
	// Wiki-folder: resolve Node.js http modules.
	// Single-file wiki: these stay null; the parent's HTTP queue is used instead.
	try {
		var _parentTw = window.parent && window.parent.$tw;
		var _utils = _parentTw && _parentTw.desktop && _parentTw.desktop.utils;
		_nodeHttps = (_utils && _utils.https) || null;
		_nodeHttp  = (_utils && _utils.http)  || null;
	} catch(_e) {}
	if(!_nodeHttps) { try { _nodeHttps = require("https"); } catch(_e2) {} }
	if(!_nodeHttp)  { try { _nodeHttp  = require("http");  } catch(_e2) {} }

	// Re-verify the saved token whenever the relay connection opens (covers both
	// auto-connect on startup and reconnects after token/config changes).
	window.addEventListener("collab-relay-opened", function() { _verifyAuth(); });

	// Transport gave up reconnecting because the relay rejected our token (401 at the
	// WS upgrade — typically after the machine slept and the OAuth session lapsed).
	// Re-verify over HTTP: if the token is in fact still valid, the 401 was transient
	// so reconnect; if it's truly expired, sign out and prompt re-login (which, on a
	// fresh token, reconnects automatically via transport's auth-token watcher).
	window.addEventListener("collab-auth-expired", function() { _handleAuthExpired(); });

	// Single-file wiki: wiki-file-window.js calls this after initialising the queue.
	window._nwjsHttpQueueReady = function() {
		// Start polling _nwjsHttpResults written by the parent queue processor.
		if(!_resultPollTimer) {
			_resultPollTimer = setInterval(function() {
				var results = window._nwjsHttpResults;
				if(!results) return;
				var ids = Object.keys(results);
				for(var i = 0; i < ids.length; i++) {
					var id = parseInt(ids[i], 10);
					var r  = results[id];
					delete results[id];
					var cb = _httpCallbacks[id];
					delete _httpCallbacks[id];
					if(cb) { cb(r.err || null, r.data || null); }
				}
			}, 200);
		}
		if(_cfg("relay-url")) { _refreshProviders(); }
		if(_cfg("relay-url") && _cfg("auth-token")) { _verifyAuth(); }
	};

	// Fetch providers whenever relay-url changes.
	$tw.wiki.addEventListener("change", function(changes) {
		if(changes["$:/config/codemirror-6-collab/relay-url"]) {
			_refreshProviders();
		}
	});

	// Wiki-folder: fetch providers and verify auth at startup if already configured.
	if(_cfg("relay-url") && (_nodeHttps || _nodeHttp)) {
		_refreshProviders();
		if(_cfg("auth-token")) { _verifyAuth(); }
	}

	$tw.rootWidget.addEventListener("codemirror-6-collab-oauth-start", function(event) {
		_startOAuthFlow(event.param || "github");
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-oauth-signout", function(event) {
		_signOut();
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-generate-invite", function(event) {
		_generateInvite();
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-apply-invite", function(event) {
		_applyInvite();
		return false;
	});

	$tw.rootWidget.addEventListener("codemirror-6-collab-leave-room", function(event) {
		_leaveRoom();
		return false;
	});
};

// ── helpers ───────────────────────────────────────────────────────────────────

function _cfg(key) {
	return $tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/" + key, "");
}

function _setStatus(text) {
	$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-status", text: text}));
}

function _relayHttpBase(relayUrl) {
	return relayUrl
		.replace(/^wss:\/\//, "https://")
		.replace(/^ws:\/\//, "http://")
		.replace(/\/+$/, "");
}

function _generateState() {
	var arr = new Uint8Array(32);
	window.crypto.getRandomValues(arr);
	return Array.from(arr).map(function(b) { return ("0" + b.toString(16)).slice(-2); }).join("");
}

function _fetchJson(url, reqHeaders) {
	// Single-file wiki: parent owns the HTTP queue, iframe just enqueues requests
	// and polls _nwjsHttpResults. No Node.js initiated from iframe call stack.
	if(Array.isArray(window._nwjsHttpQueue)) {
		var id = ++_httpCallbackSeq;
		return new Promise(function(resolve, reject) {
			_httpCallbacks[id] = function(err, data) {
				if(err) { reject(new Error(err)); } else { resolve(data); }
			};
			window._nwjsHttpQueue.push({id: id, url: url, headers: reqHeaders || {}});
		});
	}
	// Wiki-folder: direct Node.js modules.
	var mod = url.startsWith("https://") ? _nodeHttps : _nodeHttp;
	if(mod) {
		return new Promise(function(resolve, reject) {
			var req = mod.get(url, {headers: reqHeaders || {}}, function(res) {
				if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					_fetchJson(res.headers.location, reqHeaders).then(resolve, reject);
					return;
				}
				if(res.statusCode < 200 || res.statusCode >= 300) {
					res.resume();
					reject(new Error("HTTP " + res.statusCode));
					return;
				}
				var data = "";
				res.setEncoding("utf8");
				res.on("data", function(chunk) { data += chunk; });
				res.on("end", function() {
					try { resolve(JSON.parse(data)); }
					catch(e) { reject(new Error("Invalid JSON")); }
				});
			});
			req.on("error", reject);
		});
	}
	// Fallback: browser fetch (CORS-limited, only works if relay has CORS headers)
	return fetch(url, {headers: reqHeaders || {}}).then(function(r) {
		if(!r.ok) throw new Error("HTTP " + r.status);
		return r.json();
	});
}

function _openBrowser(url) {
	// _nwjsOpenExternal is injected by wiki-file-window.js (single-file wikis).
	// For wiki-folder windows, window.parent.$tw.desktop.gui is accessible directly.
	if(typeof window._nwjsOpenExternal === "function") {
		window._nwjsOpenExternal(url);
		return;
	}
	try {
		window.parent.$tw.desktop.gui.Shell.openExternal(url);
	} catch(_e) {
		window.open(url, "_blank");
	}
}

// ── provider discovery ────────────────────────────────────────────────────────

function _refreshProviders() {
	// Clear existing provider tiddlers
	$tw.wiki.filterTiddlers("[prefix[$:/temp/collab/auth-providers/]]").forEach(function(t) {
		$tw.wiki.deleteTiddler(t);
	});

	var relayUrl = _cfg("relay-url");
	if(!relayUrl) return;

	// Don't touch the auth-status line if the user is already signed in -
	// otherwise joining a room would wipe the "Signed in as @…" message.
	var signedIn = !!$tw.wiki.getTiddlerText("$:/temp/collab/auth-username", "");
	var apiBase = _relayHttpBase(relayUrl);
	if(!signedIn) { _setStatus("Fetching sign-in options from relay…"); }
	_fetchJson(apiBase + "/api/auth/providers")
		.then(function(data) {
			var providers = (data && data.providers) ? data.providers : (Array.isArray(data) ? data : []);
			if(!providers.length) {
				if(!signedIn) { _setStatus("Relay has no OAuth providers configured."); }
				return;
			}
			if(!signedIn) { _setStatus(""); }
			providers.forEach(function(p) {
				$tw.wiki.addTiddler(new $tw.Tiddler({
					title: "$:/temp/collab/auth-providers/" + p.name,
					name: p.name,
					"client-id": p.client_id || "",
					"display-name": p.display_name || _defaultDisplayName(p.name),
					url: p.url || "",
					"discovery-url": p.discovery_url || ""
				}));
			});
		})
		.catch(function(err) {
			if(!signedIn) { _setStatus("Could not fetch providers: " + (err && err.message ? err.message : String(err))); }
		});
}

function _defaultDisplayName(name) {
	var names = {github: "GitHub", gitlab: "GitLab", oidc: "SSO"};
	return names[name] || name;
}

// ── sign out ──────────────────────────────────────────────────────────────────

function _signOut() {
	["auth-token", "auth-provider"].forEach(function(key) {
		$tw.wiki.deleteTiddler("$:/config/codemirror-6-collab/" + key);
	});
	["auth-username", "auth-provider-display", "auth-user-id"].forEach(function(key) {
		$tw.wiki.deleteTiddler("$:/temp/collab/" + key);
	});
	_setStatus("");
}

function _setConfigIfChanged(key, value) {
	if($tw.wiki.getTiddlerText("$:/config/codemirror-6-collab/" + key, "") !== value) {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/" + key, text: value}));
	}
}

function _verifyAuth() {
	var relayUrl  = _cfg("relay-url");
	var authToken = _cfg("auth-token");
	var authProvider = _cfg("auth-provider");
	if(!relayUrl || !authToken) return;
	var apiBase = _relayHttpBase(relayUrl);
	var headers = {"Authorization": "Bearer " + authToken};
	if(authProvider) { headers["X-Auth-Provider"] = authProvider; }
	_fetchJson(apiBase + "/api/auth/user", headers)
		.then(function(data) {
			// auth-provider is a watched config tiddler - use _setConfigIfChanged to
			// avoid triggering transport.js reconnect on every re-verification.
			// auth-username, auth-provider-display, auth-user-id are $:/temp/ and
			// are never persisted, so simple writes are fine.
			if(data.username) {
				$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-username", text: data.username}));
			}
			if(data.provider) {
				$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-provider-display", text: _defaultDisplayName(data.provider)}));
				_setConfigIfChanged("auth-provider", data.provider);
			}
			if(data.user_id) {
				$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-user-id", text: data.user_id}));
			}
			_setStatus("Signed in as @" + data.username + " via " + _defaultDisplayName(data.provider || authProvider));
		})
		.catch(function(err) {
			var msg = (err && err.message) ? err.message : String(err);
			if(msg.indexOf("401") !== -1 || msg.indexOf("Unauthorized") !== -1) {
				_signOut();
				_setStatus("Session expired - please sign in again.");
			}
		});
}

// Recover from transport's 401 reconnect bail-out (see the collab-auth-expired
// listener above). Distinguish a transient relay 401 from a genuinely expired token
// by re-checking over HTTP, and act accordingly.
function _handleAuthExpired() {
	var relayUrl  = _cfg("relay-url");
	var authToken = _cfg("auth-token");
	var authProvider = _cfg("auth-provider");
	if(!relayUrl || !authToken) { return; }
	var apiBase = _relayHttpBase(relayUrl);
	var headers = {"Authorization": "Bearer " + authToken};
	if(authProvider) { headers["X-Auth-Provider"] = authProvider; }
	_fetchJson(apiBase + "/api/auth/user", headers)
		.then(function(data) {
			// Token still accepted over HTTP → the WS 401 was transient (e.g. a relay
			// restart racing the reconnect). Reconnect to the same room.
			if(data && data.username) {
				$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-username", text: data.username}));
			}
			$tw.wiki.deleteTiddler("$:/temp/collab/error");
			setTimeout(function() {
				$tw.rootWidget.dispatchEvent({type: "codemirror-6-collab-connect"});
			}, 500);
		})
		.catch(function(err) {
			var msg = (err && err.message) ? err.message : String(err);
			if(msg.indexOf("401") !== -1 || msg.indexOf("Unauthorized") !== -1) {
				// Token genuinely expired. Sign out and prompt re-login; transport has
				// already stopped reconnecting, so there is no loop to break here.
				_signOut();
				_setStatus("Session expired — please sign in again.");
				$tw.wiki.addTiddler(new $tw.Tiddler({
					title: "$:/temp/collab/error",
					text:  "Session expired — please sign in again via the Account section."
				}));
			}
			// Any other error (relay unreachable) is left alone: the user can retry
			// Connect once the relay is back.
		});
}

function _generateInvite() {
	var relayUrl  = _cfg("relay-url");
	var roomCode  = _cfg("room-code");
	var roomToken = _cfg("room-token");
	if(!relayUrl || !roomCode) {
		_setStatus("Cannot generate invite: relay URL and room code are required.");
		return;
	}
	// Generating an invite is the moment collaborators are onboarded, so make it
	// the moment the room becomes end-to-end encrypted: if no room token is set,
	// mint a strong random one. It rides along in the invite code (shared out of
	// band, never sent to the relay), and setting it reconnects this client into
	// the same room with end-to-end encryption.
	if(!roomToken) {
		roomToken = _generateRoomToken();
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/room-token", text: roomToken}));
	}
	var data = {u: relayUrl, c: roomCode, t: roomToken};
	var code = "collab1:" + btoa(JSON.stringify(data));
	$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/invite-code", text: code}));
}

// 256-bit cryptographically random hex token for end-to-end encryption.
function _generateRoomToken() {
	var arr = new Uint8Array(32);
	window.crypto.getRandomValues(arr);
	return Array.from(arr).map(function(b) { return ("0" + b.toString(16)).slice(-2); }).join("");
}

function _applyInvite() {
	var raw = ($tw.wiki.getTiddlerText("$:/temp/collab/paste-invite", "") || "").trim();
	if(!raw) { return; }
	$tw.wiki.deleteTiddler("$:/temp/collab/paste-invite");
	$tw.wiki.deleteTiddler("$:/temp/collab/invite-code");
	if(raw.indexOf("collab1:") === 0) {
		try {
			var data = JSON.parse(atob(raw.slice(8)));
			if(data.u) { $tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/relay-url",  text: data.u})); }
			if(data.c) { $tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/room-code",   text: data.c})); }
			if(data.t) { $tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/room-token",  text: data.t})); }
		} catch(e) {
			_setStatus("Invalid invite code.");
			return;
		}
	} else {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/room-code", text: raw}));
	}
	// Joining via invite is an explicit user action - connect immediately.
	setTimeout(function() {
		$tw.rootWidget.dispatchEvent({type: "codemirror-6-collab-connect"});
	}, 0);
}

function _leaveRoom() {
	$tw.wiki.deleteTiddler("$:/config/codemirror-6-collab/room-code");
	$tw.wiki.deleteTiddler("$:/temp/collab/invite-code");
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

function _startOAuthFlow(providerName) {
	var relayUrl = _cfg("relay-url");
	if(!relayUrl) {
		_setStatus("Error: set the relay server URL first.");
		return;
	}

	var apiBase = _relayHttpBase(relayUrl);
	var providerTid = $tw.wiki.getTiddler("$:/temp/collab/auth-providers/" + providerName);
	var clientId = providerTid ? (providerTid.fields["client-id"] || "") : "";
	var discoveryUrl = providerTid ? (providerTid.fields["discovery-url"] || "") : "";
	var providerUrl = providerTid ? (providerTid.fields["url"] || "") : "";

	var state = _generateState();
	var redirectUri = apiBase + "/api/auth/callback/" + providerName;
	var deadline = Date.now() + OAUTH_TIMEOUT_MS;

	_setStatus("Opening browser for " + _defaultDisplayName(providerName) + " login…");

	_resolveAuthUrl(providerName, clientId, providerUrl, discoveryUrl, redirectUri, state)
		.then(function(authUrl) {
			_openBrowser(authUrl);
			_setStatus("Waiting for browser login… (times out in 5 min)");
			return _pollForResult(apiBase, state, deadline);
		})
		.then(function(result) {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/auth-token",   text: result.access_token || ""}));
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/config/codemirror-6-collab/auth-provider", text: result.provider || providerName}));
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-provider-display", text: _defaultDisplayName(result.provider || providerName)}));
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-username",         text: result.username || ""}));
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/collab/auth-user-id",          text: result.user_id || ""}));
			// auth-token change triggers transport.js reconnect automatically via its change watcher
			_setStatus("Signed in as @" + (result.username || "?") + " via " + (result.provider || providerName));
		})
		.catch(function(err) {
			_setStatus("Sign-in failed: " + err.message);
		});
}

function _resolveAuthUrl(providerName, clientId, providerUrl, discoveryUrl, redirectUri, state) {
	if(providerName === "oidc") {
		if(!discoveryUrl) return Promise.reject(new Error("OIDC provider has no discovery URL"));
		return _fetchJson(discoveryUrl).then(function(doc) {
			var endpoint = doc.authorization_endpoint;
			if(!endpoint) throw new Error("OIDC discovery document missing authorization_endpoint");
			return _buildAuthUrl(endpoint, clientId, "openid profile email", redirectUri, state);
		});
	}

	var baseUrl;
	if(providerName === "github") {
		baseUrl = "https://github.com/login/oauth/authorize";
	} else if(providerName === "gitlab") {
		baseUrl = (providerUrl || "https://gitlab.com").replace(/\/+$/, "") + "/oauth/authorize";
	} else {
		return Promise.reject(new Error("Unknown provider: " + providerName));
	}
	var scope = providerName === "github" ? "read:user" : "read_user";
	return Promise.resolve(_buildAuthUrl(baseUrl, clientId, scope, redirectUri, state));
}

function _buildAuthUrl(baseUrl, clientId, scope, redirectUri, state) {
	return baseUrl +
		"?client_id=" + encodeURIComponent(clientId) +
		"&redirect_uri=" + encodeURIComponent(redirectUri) +
		"&scope=" + encodeURIComponent(scope) +
		"&response_type=code" +
		"&state=" + encodeURIComponent(state);
}

function _pollForResult(apiBase, state, deadline) {
	return new Promise(function(resolve, reject) {
		function poll() {
			if(Date.now() >= deadline) {
				reject(new Error("OAuth timed out after 5 minutes. Please try again."));
				return;
			}
			_fetchJson(apiBase + "/api/auth/result?state=" + encodeURIComponent(state))
				.then(function(body) {
					resolve(body);
				})
				.catch(function(err) {
					var msg = err && err.message ? err.message : String(err);
					if(msg.indexOf("404") === -1) {
						_setStatus("Sign-in error: " + msg + " - retrying…");
					}
					setTimeout(poll, POLL_INTERVAL_MS);
				});
		}
		poll();
	});
}
