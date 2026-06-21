/*
NW.js node-main entry — runs in the browser (main) process Node context BEFORE the first window
loads. This is the earliest JavaScript hook in the app, and the only one that runs before Chromium
spins up the GPU / renderer for a window. We use it for the startup work that genuinely benefits
from running that early:

  - remove a STALE Chromium Singleton lock left behind by a dead instance, so this launch isn't
    wrongly treated as a secondary instance and left hanging with no window; and
  - clear Chromium's disposable GPU / shader caches when the Chromium (NW.js) version changed,
    BEFORE the GPU process opens them — the common cause of a blank / no-window launch after an
    upgrade.

It deliberately does NOT terminate other TiddlyDesktop processes. node-main can also execute in a
SECONDARY launch before NW.js routes it to the primary, so killing from here could take down a
healthy running instance (and on Windows there is no Singleton symlink to detect one). Stale-process
termination therefore stays in main.js, which only ever runs in the primary instance. See
utils/startup-guard.js.

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
	require("./utils/startup-guard.js").guardProfile(resolveProfileDir());
} catch(e) {
	try { console.error("[TiddlyDesktop] node-main guard failed:", e); } catch(_e) {}
}
