/*
The detached spellcheck pref-writer.

Chromium owns the profile's Preferences file while it runs and re-flushes it on the way out, so the
spellcheck opt-in and dictionary language only survive if they are written AFTER the app instance
that set them has fully exited. Nothing inside that instance can do it — by the time it could, it is
gone. So main.js quitApp() spawns this script detached; it outlives the app, waits for it to die,
writes, and exits.

Run by OUR OWN BINARY as a plain Node interpreter (NWJS_START_AS_NODE=1 — see
utils/spellcheck.js spawnPrefWriter, and wiki-folder-server.js, which starts a folder wiki's
TiddlyWiki server the same way). NW.js ships no separate node binary, so process.execPath is the
only interpreter guaranteed to be present.

Node mode is not an optimisation, it is the whole point. Spawned as an APP the helper boots Chromium:
it then takes the profile's Singleton lock — measured on Linux, a helper still alive 68s later owning
that lock and having re-flushed use_spelling_service back to true, undoing the opt-out it had just
written — so the next launch is refused as a secondary, and if for any reason it fails to locate the
app package (an argv-less launch resolved against whatever the app's cwd happened to be, or an
AppImage mount already torn down) NW.js falls back to its own default window: the blank "NW.JS"
window users saw after quitting. In node mode no window can exist and no profile is opened, so both
failures are gone by construction and no self-termination dance is needed — the script simply ends.

Everything here is best-effort: failing to write a preference must never leave a process behind.
*/

"use strict";

var spellcheck = require("./utils/spellcheck.js");

var profileDir = process.env.TD_SPELLCHECK_PROFILE || "",
	allowed = process.env.TD_SPELLCHECK_ALLOWED === "1",
	lang = process.env.TD_SPELLCHECK_LANG || "en-GB",
	parentPid = parseInt(process.env.TD_SPELLCHECK_PARENT_PID, 10) || 0;

var POLL_MS = 100,		// how often to re-check the parent
	TIMEOUT_MS = 15000,	// give up waiting and write anyway — better a lost write than a stuck helper
	GRACE_MS = 200,		// let the OS release the Preferences file after the parent exits
	waited = 0;

// EPERM means the pid exists but is not ours to signal, i.e. still alive.
function parentAlive() {
	if(!parentPid) { return false; }
	try { process.kill(parentPid, 0); return true; }
	catch(e) { return !!e && e.code === "EPERM"; }
}

function write() {
	try {
		spellcheck.writeSpellingPrefsAtQuit(profileDir, allowed, lang);
	} catch(e) {
		try { console.error("[TiddlyDesktop] spellcheck pref-writer failed:", e); } catch(_e) {}
	}
	process.exit(0);
}

(function waitForParent() {
	if(parentAlive() && waited < TIMEOUT_MS) {
		waited += POLL_MS;
		setTimeout(waitForParent, POLL_MS);
		return;
	}
	setTimeout(write, GRACE_MS);
}());
