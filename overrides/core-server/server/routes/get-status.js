/*\
title: $:/core/modules/server/routes/get-status.js
type: application/javascript
module-type: route

GET /status

REPLACES the core route of the same name (bld.sh copies this over it). The only change is which
username is reported — see below. Keep the rest in step with core when updating TiddlyWiki.

\*/
"use strict";

exports.methods = ["GET"];

exports.path = /^\/status$/;

exports.info = {
	priority: 100
};

exports.handler = function(request,response,state) {
	// The username reported here is not cosmetic: the tiddlyweb syncadaptor copies it into
	// $:/status/UserName, and TiddlyWiki stamps THAT into the modifier/creator field of every
	// tiddler the user edits. So it has to carry the user's identity, and nothing else.
	//
	// TiddlyDesktop locks its internal loopback binding with a generated username/password —
	// on Android any app holding INTERNET can reach 127.0.0.1, and on desktop any local process
	// can — so there is always an authenticated user, whether or not anyone chose to be one.
	// That credential is plumbing. Left as-is it signed every edit "td".
	//
	// A binding declares its credential's username as `system-username`, and it is then excluded
	// from the reported identity. An empty username is what core already treats as "logged in,
	// but nobody in particular": the syncer stays logged in (so the wiki still saves), and
	// getModificationFields writes no modifier field at all rather than a placeholder one.
	//
	// Only the reported identity changes. Authorization, read_only and anonymous keep using the
	// real authenticated username, and a binding that declares no `system-username` — the user's
	// LAN sharing, or stock TiddlyWiki — behaves exactly as before, so real logins over LAN still
	// report their real names.
	var systemUsername = state.server.get("system-username"),
		authenticatedUsername = state.authenticatedUsername;
	if(systemUsername && authenticatedUsername === systemUsername) {
		authenticatedUsername = null;
	}
	var text = JSON.stringify({
		username: authenticatedUsername || state.server.get("anon-username") || "",
		anonymous: !state.authenticatedUsername,
		read_only: !state.server.isAuthorized("writers",state.authenticatedUsername),
		logout_is_available: false,
		space: {
			recipe: "default"
		},
		tiddlywiki_version: $tw.version
	});
	state.sendResponse(200,{"Content-Type": "application/json"},text,"utf8");
};
