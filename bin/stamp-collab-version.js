/*
Stamp the collaborative-editing plugin's version at BUILD time.

The collab plugin carries its OWN version (decoupled from the TiddlyDesktop app version — see
propagate-version.js) so that a wiki holding an older embedded copy can detect a newer bundled
one and offer to update it. To keep that version monotonic and automatic WITHOUT depending on a
developer-side git hook, the build derives it (this script is run by bld.sh):

    version = <major>.<minor>.<commits touching the plugin since this major.minor.0 was set>

`major.minor` are hand-controlled in plugins/codemirror-6-collab-nwjs/plugin.info. To open a new
line, set the version there to e.g. `0.2.0` — the commit that introduces that major.minor is the
ANCHOR (it ships as 0.2.0). Every later commit that touches the plugin's source then bumps the
patch: 0.2.1, 0.2.2, 0.2.3, … So the patch resets to 0 at each new major.minor, and only advances
when the plugin actually changes. (Unrelated commits elsewhere in the repo never move it.)

The anchor is found by reading the version field's major.minor at each commit that touched
plugin.info and taking the OLDEST commit in the current contiguous run of the working-tree
major.minor — i.e. the commit where this minor line was introduced. (An earlier version used
git's `-S` pickaxe on the literal `M.m.0` string, but `-S` matches a commit whenever that
string's COUNT changes — so it also matched the later commit that REMOVED the string when
bumping to the next version, and matched nothing at all when the bump hadn't been committed
yet, falling back to counting EVERY plugin commit. Walking the actual value avoids both traps.)
If you've bumped the minor in the working tree but not committed it, it ships as M.m.0 (the
bump commit becomes the anchor once committed).

Usage: node bin/stamp-collab-version.js [targetPluginInfoPath]
  - reads the base (major.minor) from the SOURCE plugin.info (plugins/codemirror-6-collab-nwjs)
  - writes the computed version into targetPluginInfoPath (default: the source file itself;
    bld.sh passes the bundled copy under source/tiddlywiki/…)

If full git history isn't available (a source tarball with no .git, or a SHALLOW clone), the
target's existing version is kept unchanged — better a stale version than a bogus count that
could look like a downgrade. CI must therefore check out full history (actions/checkout with
fetch-depth: 0).
*/

"use strict";

var fs = require("fs"),
	cp = require("child_process");

var SRC        = "plugins/codemirror-6-collab-nwjs/plugin.info";
var PLUGIN_DIR = "plugins/codemirror-6-collab-nwjs";
var target     = process.argv[2] || SRC;

var srcInfo = JSON.parse(fs.readFileSync(SRC, "utf8"));
var parts = String(srcInfo.version || "0.0.0").split(".").map(function(n) { return parseInt(n, 10) || 0; });
while(parts.length < 3) { parts.push(0); }
var major = parts[0], minor = parts[1];

// The target may be a different file (the bundled copy) — write into its own object so we
// don't clobber any unrelated fields it carries.
var targetInfo = (target === SRC) ? srcInfo : JSON.parse(fs.readFileSync(target, "utf8"));

// Run git without a shell (array args → no quoting pitfalls). Returns trimmed stdout, or
// throws on non-zero exit (caught below).
function git(args) {
	return cp.execFileSync("git", args, {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
}

function keepExisting(why) {
	console.warn("[stamp-collab-version] " + why + " — keeping version " + targetInfo.version);
	process.exit(0);
}

// Read the version field's "major.minor" from SRC as it stood at a given commit-ish, or null
// if the file (or a parseable version) wasn't there. `git show <commit>:<path>` throws when the
// path is absent at that commit — treated as null.
function majorMinorAt(commitish) {
	var content;
	try {
		content = cp.execFileSync("git", ["show", commitish + ":" + SRC],
			{encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
	} catch(e) { return null; }
	var m = /"version"\s*:\s*"(\d+)\.(\d+)/.exec(content);
	return m ? (m[1] + "." + m[2]) : null;
}

var currentMM = major + "." + minor;
var patch;
try {
	if(git(["rev-parse", "--is-shallow-repository"]) === "true") {
		keepExisting("shallow git clone (use fetch-depth: 0 in CI)");
	}
	if(majorMinorAt("HEAD") !== currentMM) {
		// The working-tree minor line isn't committed to HEAD yet (you just bumped it). It ships
		// as M.m.0; the bump commit becomes the anchor once committed.
		patch = 0;
	} else {
		// Walk the commits that touched plugin.info newest→oldest; the anchor is the OLDEST commit
		// in the leading run still carrying the current major.minor — i.e. where this minor line
		// was introduced. (Robust against the next bump's removal and against uncommitted bumps;
		// see the header comment.)
		var commits = git(["log", "--format=%H", "--", SRC]).split("\n").filter(Boolean);
		var anchor = null;
		for(var i = 0; i < commits.length; i++) {
			if(majorMinorAt(commits[i]) === currentMM) { anchor = commits[i]; }
			else { break; }
		}
		// Count plugin-touching commits AFTER the anchor (exclusive) → 0 at the anchor itself, so it
		// ships as M.m.0 and increments from there. No anchor (history doesn't reach the
		// introduction) → fall back to the full plugin commit count, still monotonic.
		var range = anchor ? (anchor + "..HEAD") : "HEAD";
		var count = parseInt(git(["rev-list", "--count", "--no-merges", range, "--", PLUGIN_DIR]), 10);
		if(isNaN(count)) { keepExisting("could not count plugin commits"); }
		patch = count;
	}
} catch(e) {
	keepExisting("git history unavailable");
}

var version = major + "." + minor + "." + patch;
targetInfo.version = version;
fs.writeFileSync(target, JSON.stringify(targetInfo, null, 4) + "\n");
console.log("[stamp-collab-version] collab plugin version -> " + version + "  (" + target + ")");
