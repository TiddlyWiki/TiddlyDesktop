/*
Startup guard for TiddlyDesktop.

Two jobs, both run synchronously at the very start of main.js (before the TiddlyWiki boot):

1. killStaleInstances() — after an unclean shutdown, a crash, or an upgrade from an older build,
   orphaned TiddlyDesktop processes can linger and keep holding the Chromium profile's Singleton
   lock / file handles. The next launch then hangs with no window and no error. Because
   TiddlyDesktop is single-instance (source/package.json sets no "single-instance": false),
   main.js only ever runs in the PRIMARY instance — a second launch is forwarded to the first and
   never reaches here. So any OTHER TiddlyDesktop process tree we can see at this point is, by
   definition, not a healthy running instance of this profile; it is stale, and we terminate it.
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
			var psOut = cp.execFileSync("powershell.exe", [
				"-NoProfile", "-NonInteractive", "-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='" + EXE_NAME + ".exe'\"" +
					" | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)\" }"
			], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true});
			return psOut.split(/\r?\n/).map(function(line) {
				var m = /^(\d+)\t(\d+)$/.exec(line.trim());
				return m ? {pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), cmd: EXE_NAME} : null;
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

// --- 1. Kill stale instances -----------------------------------------------------------------

exports.killStaleInstances = function() {
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
		// Every TiddlyDesktop pid whose instance root isn't ours belongs to a stale tree.
		var stalePids = rows.map(function(r) { return r.pid; })
			.filter(function(pid) { return rootOf(pid) !== ourRoot; });
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
