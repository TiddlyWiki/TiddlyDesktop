/*
Starts a folder wiki's TiddlyWiki SERVER as a confined child process.

Folder wikis used to boot TiddlyWiki straight into this page, which rendered the UI here and ran
the wiki's own JavaScript with full Node — a downloaded folder wiki was arbitrary code execution
by design. TiddlyWiki now runs as a SERVER only, and its UI is rendered by the sandboxed iframe
next door, which has no Node.

Why a child process, when this file used to boot in-window
---------------------------------------------------------
It previously booted TiddlyWiki inside this shell window in node-only mode, on the stated grounds
that "NW.js ships no node binary, so the Android approach of spawning a separate process is not
available here". That premise was wrong. The nw binary IS a Node binary: with NWJS_START_AS_NODE=1
in the environment it runs as plain Node — measured on our own build, `process.version` reports
v26.1.0 — and it serves a folder wiki exactly as `node tiddlywiki.js … --listen` does.

That matters because booting in-window put TiddlyWiki, and therefore every module-type tiddler the
wiki carries, in a context with unrestricted Node. Node's permission model cannot be applied to an
already-running process, so confinement was impossible there. In a child it is just process flags,
and a wiki's own code can no longer reach the filesystem outside its folder.

The permission flags, and why reads are NOT scoped
-------------------------------------------------
	--permission --allow-net --allow-fs-read=* --allow-fs-write=<wiki folder> --allow-fs-write=<tmp>

Reads are deliberately left open, and this must not be "tightened" without re-measuring:

  * Node's module resolution stats every ANCESTOR directory of the script and the wiki, walking up
    looking for node_modules — /home, /home/simon, /home/simon/Code, … So a scoped read list has to
    include those ancestors.
  * `--allow-fs-read=<dir>` grants that directory RECURSIVELY, and Node offers no "this directory
    but not its contents" form. Granting /home/simon to satisfy one stat grants the whole home
    directory, so a "scoped" read list is either incomplete or pointless.
  * Worse, an incomplete list does not fail softly. On this NW.js build a denied access aborts the
    process on an internal assertion (NodePlatform::UnregisterIsolate) instead of raising a
    catchable ERR_ACCESS_DENIED — the wiki's server simply dies. Measured both ways: scoped reads
    crash instantly, `--allow-fs-read=*` serves correctly.

Writes are what actually contain a hostile wiki, and those ARE scoped — to the wiki's own folder
plus the temp directory. This matches what the Android app already ships.

Access
------
The internal server binds loopback on an OS-assigned port and requires a generated
username/password, because any local process can reach a loopback port. TiddlyWiki's
readers/writers then default to that user, so anonymous requests are refused. The parent's
per-window server is the only thing holding the credential, and it is reached through an
unguessable token — see utils/wiki-server.js.

`system-username` marks that credential as plumbing rather than a person, so /status does not
report it as the logged-in user and edits are not signed "td" — see overrides/core-server/.

It deliberately runs with NO path-prefix. TiddlyWiki's prefix support is server-side only — the
client's tiddlyweb adaptor builds its URLs from $protocol$/$host$ and knows nothing about it — so
under a prefix the wiki loads but its syncer 404s on /status and 405s on every save. The parent
serves it at the origin root instead and gates access with a session cookie.

Lifetime
--------
An in-window server died with the window for free. A child does not, so tdStopWikiServer() exists
and the window MUST call it — see wiki-folder-window.js's close handler. Anything that leaves a
child alive leaves a wiki writable by whatever finds the port.
*/

"use strict";

(function () {
	var fs = require("fs"),
		net = require("net"),
		os = require("os"),
		path = require("path"),
		crypto = require("crypto"),
		childProcess = require("child_process");

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
	Poll until the server accepts a connection.

	The child reports readiness by binding, not by anything it prints: TiddlyWiki's "Serving on …"
	line goes to stdout, and waiting on log text would couple us to its wording.
	*/
	function waitForPort(port, timeoutMs, cb) {
		var deadline = Date.now() + timeoutMs;
		(function attempt() {
			var sock = net.connect(port, "127.0.0.1");
			sock.once("connect", function () {
				sock.destroy();
				cb(null);
			});
			sock.once("error", function () {
				sock.destroy();
				if (Date.now() > deadline) {
					cb(new Error("timed out waiting for the wiki server to accept connections"));
				} else {
					setTimeout(attempt, 100);
				}
			});
		})();
	}

	// The child's output, kept to a bounded tail purely for diagnostics. It MUST be drained:
	// TiddlyWiki logs a line per save, and an unread pipe eventually fills and blocks the server.
	function drain(stream, sink) {
		if (!stream) return;
		stream.setEncoding("utf8");
		stream.on("data", function (chunk) {
			sink.text = (sink.text + chunk).slice(-4000);
		});
		stream.on("error", function () {});
	}

	// Kill one server process. Split out because the failure path has to stop a SPECIFIC
	// process rather than whichever one is current.
	function stopProcess(proc) {
		if (!proc) return;
		try {
			proc.kill();
		} catch (e) {}
		// Force it if it does not go quietly, so a wedged server cannot outlive its window.
		setTimeout(function () {
			try {
				if (!proc.killed) proc.kill("SIGKILL");
			} catch (e) {}
		}, 3000);
	}

	var child = null,
		childLog = {text: ""};

	/*
	Start the wiki's server.

		options.appDir      absolute path of the application directory
		options.wikiPath    the wiki folder
		options.lan         optional {host, port, credentials, readers, writers, pathPrefix,
		                    rootTiddler, anonUsername, gzip} for the user's LAN sharing feature

	cb(err, {origin, authHeader}) — what the parent needs to forward to us.
	*/
	window.tdStartWikiServer = function (options, cb) {
		// A shell reload calls this again. Without stopping the previous one first, the old
		// server keeps its port and its write access to the wiki folder with nothing pointing
		// at it any more.
		window.tdStopWikiServer();
		findFreePort(function (portErr, port) {
			if (portErr) {
				cb(portErr, null);
				return;
			}
			var user = "td",
				pass = crypto.randomBytes(24).toString("hex");
			try {
				var tiddlywikiJs = path.join(options.appDir, "tiddlywiki", "tiddlywiki.js");

				// Node's own flags, which must precede the script path.
				var argv = [
					"--permission",
					// Node 26 gates networking too; without this the server cannot listen.
					"--allow-net",
					// See the header: NOT scoped, deliberately.
					"--allow-fs-read=*",
					"--allow-fs-write=" + options.wikiPath,
					"--allow-fs-write=" + os.tmpdir(),
					tiddlywikiJs,
					// Guarantee the two plugins a served wiki needs to save, WITHOUT touching
					// the user's tiddlywiki.info. boot.js consumes leading "+" arguments as extra
					// plugin references held in memory for this boot only, so this works even for
					// a folder wiki created elsewhere that never went through
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
					// This matters more than it looks: the browser half saves through the
					// tiddlyweb sync adaptor, so a wiki missing that plugin would load and
					// render but silently fail to save. The name must be
					// "plugins/<publisher>/<name>": boot.js only acts on a three-part reference
					// whose first part is plugins/themes/languages, and SILENTLY IGNORES
					// anything else — a two-part name looks right, does nothing, and leaves the
					// wiki serving happily while saving nowhere.
					"+plugins/tiddlywiki/filesystem",
					"+plugins/tiddlywiki/tiddlyweb",
					options.wikiPath,
					"--listen",
					"host=127.0.0.1",
					"port=" + port,
					"username=" + user,
					"password=" + pass,
					// Declares the above as a credential rather than a person, so /status does
					// not report it as the user's identity and edits are not signed "td".
					// Scoped to THIS binding: the LAN one below never sees it, so real logins
					// there keep reporting real names.
					"system-username=" + user
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
						"readers=" + (lan.readers || "(anon)"),
						"writers=" + (lan.writers || "(authenticated)"),
					);
					// Only name a credentials file that actually exists. TiddlyWiki's basic
					// authenticator reads it with readFileSync and, when that fails, returns an
					// error string which the node-mode error path turns into process.exit — so a
					// configured-but-absent users.csv does not fail the LAN binding, it kills
					// the whole server and takes the wiki with it. The settings default is a
					// placeholder rather than a promise that the file is there.
					var credPath = lan.credentials || "";
					if (credPath) {
						var resolved = path.resolve(options.wikiPath, credPath);
						if (fs.existsSync(resolved)) {
							argv.push("credentials=" + credPath);
						} else {
							console.warn(
								"[TiddlyDesktop] ignoring credentials file (not found): " +
									resolved,
							);
						}
					}
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

				// NWJS_START_AS_NODE is what turns our own binary into a plain Node interpreter.
				// process.execPath is that binary; there is no separate node to point at.
				var env = {};
				Object.keys(process.env).forEach(function (k) {
					env[k] = process.env[k];
				});
				env.NWJS_START_AS_NODE = "1";

				childLog = {text: ""};
				child = childProcess.spawn(process.execPath, argv, {
					cwd: options.appDir,
					env: env,
					stdio: ["ignore", "pipe", "pipe"],
				});
				// Captured for the handlers below. A shell reload starts a second server while the
				// first is still exiting, and handlers that touched the shared `child` would then
				// null out the NEW process's handle — orphaning it. They compare identity instead.
				var proc = child,
					log = childLog;
			} catch (e) {
				console.error("[TiddlyDesktop] folder wiki server failed to spawn:", e);
				cb(e, null);
				return;
			}

			var settled = false;
			function settle(err, result) {
				if (settled) return;
				settled = true;
				cb(err, result);
			}

			drain(proc.stdout, log);
			drain(proc.stderr, log);

			proc.on("error", function (err) {
				console.error("[TiddlyDesktop] folder wiki server error:", err);
				settle(err, null);
			});

			proc.on("exit", function (code, signal) {
				var how = "code=" + code + (signal ? " signal=" + signal : "");
				if (!settled) {
					// Died before it ever listened. The tail is the only clue the user can be
					// given, and on a permission fault it is the assertion described in the
					// header rather than a tidy error.
					console.error(
						"[TiddlyDesktop] folder wiki server exited before listening (" + how + "):\n" +
							log.text,
					);
					settle(new Error("the wiki server exited before it started listening (" + how + ")"), null);
				} else {
					// Died while serving: the iframe is now pointing at a dead origin. Nothing
					// here can recover it, but say so rather than leaving a silently broken wiki.
					console.error(
						"[TiddlyDesktop] folder wiki server stopped (" + how + "):\n" + log.text,
					);
				}
				// Only if this is still the current server — see the capture above.
				if (child === proc) { child = null; }
			});

			waitForPort(port, 30000, function (waitErr) {
				if (waitErr) {
					console.error(
						"[TiddlyDesktop] folder wiki server did not come up:\n" + log.text,
					);
					// Stop THIS process, not whatever is current: a reload may already have
					// replaced it, and the global handle would take out the new one.
					if (child === proc) { child = null; }
					stopProcess(proc);
					settle(waitErr, null);
					return;
				}
				settle(null, {
					origin: "http://127.0.0.1:" + port,
					authHeader:
						"Basic " + Buffer.from(user + ":" + pass).toString("base64"),
					wikiPath: String(options.wikiPath || ""),
				});
			});
		});
	};

	/*
	Stop the server. Idempotent, and safe to call before it ever started.

	The window's close handler must call this: unlike the old in-window server, a child outlives
	the window that started it, and an orphan keeps the wiki folder writable through a port that
	nothing is watching any more.
	*/
	window.tdStopWikiServer = function () {
		var proc = child;
		child = null;
		stopProcess(proc);
	};

	// Backstop for paths that tear the window down without going through the close handler
	// (a reload, or a crash in the parent). Killing twice is harmless; leaking a server is not.
	window.addEventListener("unload", function () {
		try { window.tdStopWikiServer(); } catch (e) {}
	});
})();
