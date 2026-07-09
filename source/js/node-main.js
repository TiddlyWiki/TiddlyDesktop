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

try {
	var guard = require("./utils/startup-guard.js");
	var profileDir = resolveProfileDir();
	// Windows only (no-op elsewhere): clear a hung primary before NW.js forwards this launch to it.
	guard.killHungPrimary(profileDir);
	guard.guardProfile(profileDir);
} catch(e) {
	try { console.error("[TiddlyDesktop] node-main guard failed:", e); } catch(_e) {}
}

// Force Chromium's remote (Google) spelling service off before the profile is opened. --enable-spell-checking
// (source/package.json) otherwise makes NW.js send typed text to Google by default; we keep only the local
// Hunspell spellcheck. Isolated from the guard above so a failure here can't affect startup recovery.
try {
	require("./utils/spellcheck.js").disableSpellingService(resolveProfileDir());
} catch(e) {
	try { console.error("[TiddlyDesktop] disable-spelling-service failed:", e); } catch(_e) {}
}
