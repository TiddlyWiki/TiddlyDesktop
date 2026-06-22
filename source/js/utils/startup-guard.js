/*
Startup guard for TiddlyDesktop.

Two jobs, both run synchronously at the very start of main.js (before the TiddlyWiki boot):

1. killStaleInstances() — after an unclean shutdown, a crash, or an upgrade from an older build,
   orphaned TiddlyDesktop processes can linger and keep holding the Chromium profile's Singleton
   lock / file handles. The next launch then hangs with no window and no error. Because
   TiddlyDesktop is single-instance per profile (source/package.json sets no "single-instance":
   false), so a second launch against the SAME profile is forwarded to the first and never reaches
   here. A launch with a different --user-data-dir, however, is the primary of its own profile and
   does run main.js — that is a legitimate parallel instance, NOT a stale one. We therefore only
   terminate other TiddlyDesktop trees that share OUR profile: any same-profile tree we can see
   here cannot be a healthy running instance (the live one would have absorbed our launch), so it
   is stale. Each tree's profile is read from the --user-data-dir on its root (browser) process.
   Our own process tree is always identified and spared.

2. guardProfile() — detect a Chromium version change (i.e. an NW.js upgrade) and clear the
   disposable GPU / shader / code caches that commonly cause a blank or no-window launch after
   Chromium jumps several versions, plus remove a stale Singleton lock left behind by a dead
   instance. It NEVER touches TiddlyDesktop's own data (the user-config-tiddlywiki backstage wiki,
   FolderWikiState, FolderWikiTitles) — only Chromium's regenerable caches.

Everything is wrapped defensively: a failure anywhere in here must never prevent the app starting.
*/

"use strict";

var fs = require("fs"),
	path = require("path"),
	cp = require("child_process");

// The built launcher binary is renamed to "TiddlyDesktop" on every platform (see bld.sh). When
// running unbuilt from the NW.js SDK the binary is "nw", so the matcher below simply finds nothing
// and the killer no-ops — which is the right behaviour in development.
var EXE_NAME = "TiddlyDesktop";
var OUR_EXEC = (process.execPath || "");

// Chromium caches that are safe to delete — they are regenerated on demand. A cache left over from
// a different Chromium build is a classic cause of a blank/garbled/no-window launch after upgrade.
// (Anything NOT in this list — Local Storage, IndexedDB, Cookies, History, and TiddlyDesktop's own
// wiki folders — is left strictly untouched.)
var DISPOSABLE_CACHES = [
	"GPUCache", "ShaderCache", "GraphiteDawnCache", "DawnGraphiteCache",
	"DawnWebGPUCache", "GPUPersistentCache", "Code Cache"
];

function rmrf(p) {
	try { fs.rmSync(p, {recursive: true, force: true}); } catch(e) {}
}

function pidAlive(pid) {
	if(!pid || pid <= 0) { return false; }
	try { process.kill(pid, 0); return true; }		// signal 0 just probes existence
	catch(e) { return e && e.code === "EPERM"; }	// alive but not ours to signal
}

// --- Process enumeration ---------------------------------------------------------------------

// Returns [{pid, ppid, cmd}] for processes that look like TiddlyDesktop, or null if the platform
// query failed (→ caller skips quietly).
function enumerateTiddlyDesktop() {
	try {
		if(process.platform === "win32") {
			// PowerShell CIM is available on all supported Windows and gives a stable, parseable
			// table. Already filtered to our image name, so every row is a TiddlyDesktop process.
				// CommandLine is included so the kill can read each tree's --user-data-dir (empty when
				// the process is elevated and unreadable — treated as the default profile downstream).
			var psOut = cp.execFileSync("powershell.exe", [
				"-NoProfile", "-NonInteractive", "-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='" + EXE_NAME + ".exe'\"" +
					" | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"
			], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true});
			return psOut.split(/\r?\n/).map(function(line) {
				var m = /^(\d+)\t(\d+)\t(.*)$/.exec(line.replace(/\r$/, ""));
				return m ? {pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), cmd: m[3]} : null;
			}).filter(Boolean);
		}
		// POSIX (Linux, macOS): -A lists every process on both BSD and procps ps.
		var out = cp.execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="],
			{encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024});
		var rows = [];
		out.split(/\r?\n/).forEach(function(line) {
			var m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if(!m) { return; }
			var cmd = m[3];
			if(looksLikeTiddlyDesktop(cmd)) {
				rows.push({pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), cmd: cmd});
			}
		});
		return rows;
	} catch(e) {
		return null;
	}
}

function looksLikeTiddlyDesktop(cmd) {
	if(!cmd) { return false; }
	// Match the renamed launcher binary as a path component (argv[0] of the browser process and
	// every renderer/GPU child), or an exact match on our own executable path.
	if(/(^|[\/\\])TiddlyDesktop(\.exe)?(\s|$)/.test(cmd)) { return true; }
	return OUR_EXEC && cmd.indexOf(OUR_EXEC) !== -1;
}

// --- Profile identification ------------------------------------------------------------------

// Normalise a filesystem path for cross-process comparison: absolute, no trailing separator,
// case-folded on the case-insensitive platforms (Windows, and macOS by default).
function normPath(p) {
	if(!p) { return ""; }
	var r = path.resolve(p).replace(/[\/\\]+$/, "");
	return (process.platform === "win32" || process.platform === "darwin") ? r.toLowerCase() : r;
}

function stripQuotes(s) {
	return s.replace(/^["']/, "").replace(/["']$/, "");
}

// Extract the --user-data-dir value from a process command line, or "" when the flag is absent
// (the instance is running on Chromium's default profile location). Chromium normalises the flag
// to the --user-data-dir=VALUE form, and VALUE may itself contain spaces (e.g. the macOS default
// ".../Application Support/..."), so for that form we read up to the next " --flag" or end of line.
function userDataDirOf(cmd) {
	if(!cmd) { return ""; }
	var m = /--user-data-dir=(.*?)(?=\s+--|$)/.exec(cmd);
	if(m) { return stripQuotes(m[1].trim()); }
	// Space-separated form (--user-data-dir PATH), as a user might type it on the launcher: one token.
	m = /--user-data-dir\s+("[^"]*"|'[^']*'|\S+)/.exec(cmd);
	return m ? stripQuotes(m[1]) : "";
}

// --- 1. Kill stale instances -----------------------------------------------------------------

// dataPath is the active Chromium profile dir (gui.App.dataPath, e.g. .../TiddlyDesktop/Default);
// its parent is the --user-data-dir root we compare other instances against.
exports.killStaleInstances = function(dataPath) {
	try {
		var rows = enumerateTiddlyDesktop();
		if(!rows || !rows.length) { return; }

		var byPid = {};
		rows.forEach(function(r) { byPid[r.pid] = r; });

		// If we can't see our OWN process among the candidates, we cannot reliably tell which tree
		// is ours — abort rather than risk killing ourselves.
		if(!byPid[process.pid]) { return; }

		// Climb to the topmost TiddlyDesktop ancestor — the browser/root process of an instance.
		// Stops as soon as the parent isn't a TiddlyDesktop process (or isn't listed), so it never
		// leaves the instance it started in. Guarded against pid cycles.
		function rootOf(pid) {
			var seen = {}, cur = pid;
			while(byPid[cur] && byPid[cur].ppid && byPid[byPid[cur].ppid] && !seen[cur]) {
				seen[cur] = true;
				cur = byPid[cur].ppid;
			}
			return cur;
		}

		var ourRoot = rootOf(process.pid);

		// Our own profile, taken authoritatively from gui.App.dataPath, plus whether we run on the
		// platform-default profile (our root process carries no explicit --user-data-dir).
		var ourProfile = normPath(path.dirname(dataPath || ""));
		var weOnDefault = !userDataDirOf((byPid[ourRoot] && byPid[ourRoot].cmd) || "");

		// A tree shares our profile when its root's --user-data-dir resolves to ours; a tree with no
		// flag is on the default profile, which is ours only if we too launched without the flag.
		function sharesOurProfile(root) {
			var dir = userDataDirOf((byPid[root] && byPid[root].cmd) || "");
			return dir ? (normPath(dir) === ourProfile) : weOnDefault;
		}

		// A pid is stale only if its instance root isn't ours AND that instance shares our profile.
		// Parallel instances launched with a different --user-data-dir are legitimate and spared.
		var stalePids = rows.map(function(r) { return r.pid; })
			.filter(function(pid) {
				var root = rootOf(pid);
				return root !== ourRoot && sharesOurProfile(root);
			});
		if(!stalePids.length) { return; }

		if(process.platform === "win32") {
			// taskkill /T tears down each stale tree by its root pid.
			var staleRoots = {};
			stalePids.forEach(function(pid) { staleRoots[rootOf(pid)] = true; });
			Object.keys(staleRoots).forEach(function(root) {
				try { cp.execFileSync("taskkill", ["/F", "/T", "/PID", root], {stdio: "ignore", windowsHide: true}); } catch(e) {}
			});
		} else {
			// SIGKILL each stale pid directly (killing the browser root tears its renderers down,
			// but signalling every listed pid is belt-and-braces against reparented children).
			stalePids.forEach(function(pid) {
				try { process.kill(pid, "SIGKILL"); } catch(e) {}
			});
		}
		console.log("[TiddlyDesktop] terminated " + stalePids.length + " stale process(es)");
	} catch(e) {
		// Never let cleanup break startup.
	}
};

// --- 2. Profile / cache guard ----------------------------------------------------------------

// Remove a Singleton lock left behind by a dead instance. On Linux/macOS the lock is a symlink
// "<host>-<pid>" at the user-data root; if its owning pid is gone we clear the lock trio so the
// new instance isn't blocked. (No-op on Windows, where the symlink doesn't exist.)
function removeStaleSingletonLock(userDataRoot) {
	try {
		var lockPath = path.join(userDataRoot, "SingletonLock");
		var target;
		try { target = fs.readlinkSync(lockPath); } catch(e) { return; }	// no lock → nothing to do
		var m = /-(\d+)$/.exec(target);
		if(m && pidAlive(parseInt(m[1], 10))) { return; }					// a live owner — leave it alone
		["SingletonLock", "SingletonSocket", "SingletonCookie"].forEach(function(n) {
			try { fs.unlinkSync(path.join(userDataRoot, n)); } catch(e) {}
		});
	} catch(e) {}
}

// dataPath is the active Chromium profile dir (gui.App.dataPath, e.g. .../TiddlyDesktop/Default).
exports.guardProfile = function(dataPath) {
	try {
		if(!dataPath) { return; }
		var userDataRoot = path.dirname(dataPath);	// .../TiddlyDesktop

		removeStaleSingletonLock(userDataRoot);

		// Detect a Chromium version change via our own marker (Chromium's "Last Version" is owned
		// by Chromium and already rewritten by the time we run).
		var marker = path.join(dataPath, "td-chromium-version");
		var current = (process.versions && process.versions.chrome) || "";
		if(!current) { return; }
		var previous = "";
		try { previous = fs.readFileSync(marker, "utf8").trim(); } catch(e) {}
		if(previous === current) { return; }

		// Version changed → clear disposable caches in both the profile dir and the user-data root
		// (Chromium keeps some at each level). Regenerated automatically; safe to delete.
		DISPOSABLE_CACHES.forEach(function(name) {
			rmrf(path.join(dataPath, name));
			rmrf(path.join(userDataRoot, name));
		});
		try { fs.writeFileSync(marker, current); } catch(e) {}
		console.log("[TiddlyDesktop] Chromium " + (previous || "?") + " -> " + current + ": cleared GPU/shader caches");
	} catch(e) {
		// Never let the guard break startup.
	}
};
