/*
NW.js node-main entry — runs in the browser (main) process Node context BEFORE the first window
loads. This is the earliest JavaScript hook in the app, and the only one that runs before Chromium
spins up the GPU / renderer for a window. We use it for the startup work that genuinely benefits
from running that early:

  - remove a STALE Chromium Singleton lock left behind by a dead instance, so this launch isn't
    wrongly treated as a secondary instance and left hanging with no window;
  - clear Chromium's disposable GPU / shader caches when the Chromium (NW.js) version changed,
    BEFORE the GPU process opens them — the common cause of a blank / no-window launch after an
    upgrade; and
  - on Windows, terminate a HUNG primary that would otherwise trap this launch (see below).

It does NOT do general stale-process termination: node-main also executes in a SECONDARY launch
before NW.js routes it to the primary, so broad killing from here could take down a healthy running
instance. That stays in main.js, which only ever runs in the primary. The single, narrow exception
is Windows, where there is no Singleton symlink to clear and a forwarded launch trapped by a hung
primary never reaches main.js — so killHungPrimary() runs here to terminate ONLY a primary that is
demonstrably hung (owns a window yet reports Responding == false). A healthy primary responds and is
left alone, and our launch forwards to it as normal. See utils/startup-guard.js.

Everything is wrapped so a failure here can never stop the app from starting.
*/

"use strict";

// Detached pref-writer mode (spawned by main.js quitApp): this process exists only to write the
// spellcheck prefs into the profile Preferences AFTER the app instance that spawned us has fully
// exited — the one moment they survive, since Chromium owns and re-flushes those prefs while it runs,
// so the in-process pre-seed below loses that race. It runs before NW.js opens a window or forwards to
// a primary, blocks until the parent is gone, writes, and exits; the app never boots in this process.
if(process.env.TD_SPELLCHECK_WRITER === "1") {
	runSpellcheckPrefWriter();
}

// Resolve the active Chromium profile directory (e.g. .../TiddlyDesktop/Default).
function resolveProfileDir() {
	// Prefer the live value if the App API is already available this early.
	try {
		var dp = require("nw.gui").App.dataPath;
		if(dp) { return dp; }
	} catch(e) {}
	// Otherwise derive the platform-default user-data root for our app and append the Default
	// profile. A wrong guess simply means the targets don't exist and every operation no-ops — it
	// can never delete the wrong thing (guardProfile only removes known Chromium caches/locks).
	var os = require("os"), p = require("path"), name = "TiddlyDesktop", home = os.homedir(), root;
	if(process.platform === "win32") {
		root = p.join(process.env.LOCALAPPDATA || p.join(home, "AppData", "Local"), name);
	} else if(process.platform === "darwin") {
		root = p.join(home, "Library", "Application Support", name);
	} else {
		root = p.join(process.env.XDG_CONFIG_HOME || p.join(home, ".config"), name);
	}
	return p.join(root, "Default");
}

// Synchronous sleep so the writer mode blocks node-main — and therefore NW.js booting a window — until
// it is done. Atomics.wait avoids a busy-loop; the busy-wait is only a fallback if it is unavailable.
function sleepSync(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch(e) {
		var end = Date.now() + ms;
		while(Date.now() < end) { /* fallback busy-wait */ }
	}
}

// Wait for the app instance that spawned us (TD_SPELLCHECK_PARENT_PID) to exit — so Chromium's final
// Preferences flush is done and ours is the last write — then write the spellcheck prefs and quit.
// Synchronous throughout, so NW.js never proceeds to boot the app in this process.
function runSpellcheckPrefWriter() {
	try {
		var spellcheck = require("./utils/spellcheck.js");
		var profileDir = process.env.TD_SPELLCHECK_PROFILE || resolveProfileDir();
		var allowed = process.env.TD_SPELLCHECK_ALLOWED === "1";
		var lang = process.env.TD_SPELLCHECK_LANG || "en-GB";
		var parentPid = parseInt(process.env.TD_SPELLCHECK_PARENT_PID, 10) || 0;
		var waited = 0, TIMEOUT = 15000;
		while(parentPid && waited < TIMEOUT) {
			try { process.kill(parentPid, 0); } catch(e) { break; } // throws once the pid is gone
			sleepSync(100);
			waited += 100;
		}
		sleepSync(200); // brief grace for the OS to release the Preferences file after the parent exits
		spellcheck.writeSpellingPrefsAtQuit(profileDir, allowed, lang);
	} catch(e) {
		try { console.error("[TiddlyDesktop] spellcheck pref-writer failed:", e); } catch(_e) {}
	}
	try { process.exit(0); } catch(e) {}
}

try {
	var guard = require("./utils/startup-guard.js");
	var profileDir = resolveProfileDir();
	// Windows only (no-op elsewhere): clear a hung primary before NW.js forwards this launch to it.
	guard.killHungPrimary(profileDir);
	guard.guardProfile(profileDir);
} catch(e) {
	try { console.error("[TiddlyDesktop] node-main guard failed:", e); } catch(_e) {}
}

// Sync Chromium's remote (Google) spelling-service preference and the spellcheck dictionary language
// before the profile is opened. --enable-spell-checking (source/package.json) otherwise makes NW.js
// send typed text to Google by default; we keep it OFF unless the user opted in (an on-disk marker
// written by the settings UI, since this runs before TiddlyWiki boots). The spellcheck language is
// also read from a marker file and written into Preferences so Chromium loads the right dictionary.
// Changing either setting takes effect on the NEXT launch. Fail-safe and idempotent.
try {
	var _spellcheck = require("./utils/spellcheck.js");
	var _profileDir = resolveProfileDir();
	_spellcheck.syncSpellingServicePref(_profileDir, _spellcheck.readLanguageMarker(_profileDir));
} catch(e) {
	try { console.error("[TiddlyDesktop] sync-spelling-service failed:", e); } catch(_e) {}
}
