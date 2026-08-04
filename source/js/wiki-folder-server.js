/*
Boots a folder wiki's TiddlyWiki SERVER inside this shell window.

Phase 9 of DESIGN-http-wiki-origin.md.

Folder wikis used to boot TiddlyWiki straight into this page, which rendered the UI here and ran
the wiki's own JavaScript with full Node — a downloaded folder wiki was arbitrary code execution
by design. Now TiddlyWiki runs here only as a SERVER, and its UI is rendered by the sandboxed
iframe next door, which has no Node.

Why the server runs in a window at all
--------------------------------------
NW.js ships no `node` binary (only `nw`, `nwjc`, `chromedriver`), so the Android approach of
spawning `tiddlywiki --listen` as a separate process is not available here. TiddlyWiki has to boot
inside an NW.js context, and this shell is the one that has Node.

Booting it naively would defeat the whole exercise: in a renderer both `$tw.browser` and `$tw.node`
are truthy, so TiddlyWiki would render the wiki's UI *and execute the wiki's browser-side modules*
in this Node-enabled page. Forcing node-only mode avoids that. `bootprefix.js` assigns the platform
only when the key is absent:

	if(!("browser" in $tw)) { $tw.browser = … }

so passing `{browser: null}` in is supported rather than a trick — but it must be PRE-set, not
overwritten afterwards. Measured: with it, the wiki folder loads and the server runs while nothing
is rendered into this page.

Boot has to use suppressBoot + boot(callback). Reading state straight after TiddlyWiki($tw) sees an
unfinished boot, which looks exactly like a server that failed to start.

Access
------
The internal server binds loopback on an OS-assigned port and requires a generated
username/password, because any local process can reach a loopback port. TiddlyWiki's
readers/writers then default to that user, so anonymous requests are refused. The parent's
per-window server is the only thing holding the credential, and it is reached through an
unguessable token — see utils/wiki-server.js.

It also runs with `path-prefix=/wiki/<token>` so the URLs TiddlyWiki generates already match what
the parent forwards, which is what keeps that a plain forwarder rather than a rewriting proxy.
*/

"use strict";

(function () {
	var fs = require("fs"),
		net = require("net"),
		crypto = require("crypto"),
		path = require("path");

	// Find a free loopback port by binding one and letting go. There is a theoretical race
	// between releasing it and TiddlyWiki claiming it; nothing else on the machine is hunting
	// for this port, and the alternative (patching TiddlyWiki's listen to accept port 0 and
	// report back) is a great deal more invasive.
	function findFreePort(cb) {
		var probe = net.createServer();
		probe.on("error", function (err) {
			cb(err, 0);
		});
		probe.listen(0, "127.0.0.1", function () {
			var port = probe.address().port;
			probe.close(function () {
				cb(null, port);
			});
		});
	}

	/*
	Start the wiki's server.

		options.appDir      absolute path of the application directory
		options.wikiPath    the wiki folder
		options.pathPrefix  the prefix the parent forwards, e.g. /wiki/<token>
		options.lan         optional {host, port, credentials, readers, writers, pathPrefix,
		                    rootTiddler, anonUsername, gzip} for the user's LAN sharing feature

	cb(err, {origin, authHeader}) — what the parent needs to forward to us.
	*/
	window.tdStartWikiServer = function (options, cb) {
		findFreePort(function (portErr, port) {
			if (portErr) {
				cb(portErr, null);
				return;
			}
			var user = "td",
				pass = crypto.randomBytes(24).toString("hex");
			try {
				// Pre-set browser:null so bootprefix leaves us in node-only mode.
				var $tw = { browser: null };
				// Absolute requires, not relative. This script runs inside a page SERVED over
				// http, and NW.js resolves a relative require against the URL path rather than
				// the file it came from — so "../tiddlywiki/…" points at a directory that does
				// not exist. The parent passes the real application directory in.
				var boot = options.appDir + "/tiddlywiki/boot/";
				require(boot + "bootprefix.js").bootprefix($tw);
				$tw.boot = $tw.boot || {};
				$tw.boot.suppressBoot = true;
				var argv = [
					// Guarantee the two plugins a served wiki needs to save, WITHOUT touching
					// the user's tiddlywiki.info. boot.js treats a leading "+" as an extra
					// plugin reference held in memory for this boot only, so this works even
					// for a folder wiki created elsewhere that never went through
					// ensureFolderWikiPlugins.
					//
					// INVARIANT: opening a folder wiki must not modify tiddlywiki.info.
					// Verified by hashing the file across a full open-and-save cycle — it is
					// byte-identical, mtime included, for a wiki declaring no plugins at all
					// while still saving correctly. Do not "fix" a missing plugin by writing
					// to that file on open; the only writes belong to wikis TiddlyDesktop
					// itself generates (ensureFolderWikiPlugins, on create/clone/convert),
					// where declaring them keeps the result usable with stock TiddlyWiki too.
					//
					// This matters more than it looks: the browser half now saves through the
					// tiddlyweb sync adaptor, so a wiki missing that plugin would load and
					// render but silently fail to save. In-page booting never needed it.
					// The name must be "plugins/<publisher>/<name>": boot.js only acts on a
					// three-part reference whose first part is plugins/themes/languages, and
					// SILENTLY IGNORES anything else — a two-part name looks right, does
					// nothing, and leaves the wiki serving happily while saving nowhere.
					"+plugins/tiddlywiki/filesystem",
					"+plugins/tiddlywiki/tiddlyweb",
					options.wikiPath,
					"--listen",
					"host=127.0.0.1",
					"port=" + port,
					"username=" + user,
					"password=" + pass,
					"path-prefix=" + options.pathPrefix,
				];
				// The user's LAN sharing is a SEPARATE binding with its own credentials and
				// principals. It must never carry the internal one, and it must never serve the
				// shell path — which it cannot, being a different server on a different port.
				var lan = options.lan;
				if (lan && lan.host && lan.port) {
					argv.push(
						"--listen",
						"host=" + lan.host,
						"port=" + lan.port,
						"credentials=" + (lan.credentials || "users.csv"),
						"readers=" + (lan.readers || "(anon)"),
						"writers=" + (lan.writers || "(authenticated)"),
					);
					if (lan.pathPrefix) {
						argv.push("path-prefix=" + lan.pathPrefix);
					}
					if (lan.rootTiddler) {
						argv.push("root-tiddler=" + lan.rootTiddler);
					}
					if (lan.anonUsername) {
						argv.push("anon-username=" + lan.anonUsername);
					}
					if (lan.gzip === "yes") {
						argv.push("gzip=yes");
					}
				}
				$tw.boot.argv = argv;
				window.$twServer = $tw;
				require(boot + "boot.js").TiddlyWiki($tw);
				$tw.boot.boot(function () {
					cb(null, {
						origin: "http://127.0.0.1:" + port,
						authHeader:
							"Basic " +
							Buffer.from(user + ":" + pass).toString(
								"base64",
							),
						wikiPath: String($tw.boot.wikiPath || ""),
					});
				});
			} catch (e) {
				console.error(
					"[TiddlyDesktop] folder wiki server failed to boot:",
					e,
				);
				cb(e, null);
			}
		});
	};
})();
