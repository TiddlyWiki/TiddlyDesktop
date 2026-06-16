/*
Stamp the collaborative-editing plugin's version at BUILD time.

The collab plugin carries its OWN version (decoupled from the TiddlyDesktop app version — see
propagate-version.js) so that a wiki holding an older embedded copy can detect a newer bundled
one and offer to update it. To keep that version monotonic and automatic WITHOUT depending on a
developer-side git hook, the build derives it (this script is run by bld.sh):

    version = <major>.<minor>.<commits touching the plugin since this major.minor.0 was set>

`major.minor` are hand-controlled in plugins/codemirror-6-collab-nwjs/plugin.info. To open a new
line, set the version there to e.g. `0.2.0` and commit it — that commit is the ANCHOR (it ships
as 0.2.0). Every later commit that touches the plugin's source then bumps the patch: 0.2.1,
0.2.2, 0.2.3, … So the patch resets to 0 at each new major.minor, and only advances when the
plugin actually changes. (Unrelated commits elsewhere in the repo never move it.)

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

var patch;
try {
	if(git(["rev-parse", "--is-shallow-repository"]) === "true") {
		keepExisting("shallow git clone (use fetch-depth: 0 in CI)");
	}
	// The anchor: the commit that set the version to <major>.<minor>.0 in plugin.info (pickaxe
	// on that exact field value — the most recent commit that changed its occurrence count).
	var anchor = git(["log", "-1", "--format=%H",
		"-S", "\"version\": \"" + major + "." + minor + ".0\"", "--", SRC]);
	// Count plugin-touching commits AFTER the anchor (exclusive) → 0 at the anchor itself, so it
	// ships as major.minor.0 and increments from there. No anchor found (e.g. the base was never
	// committed as major.minor.0) → fall back to the full plugin commit count, still monotonic.
	var range = anchor ? (anchor + "..HEAD") : "HEAD";
	var count = parseInt(git(["rev-list", "--count", "--no-merges", range, "--", PLUGIN_DIR]), 10);
	if(isNaN(count)) { keepExisting("could not count plugin commits"); }
	patch = count;
} catch(e) {
	keepExisting("git history unavailable");
}

var version = major + "." + minor + "." + patch;
targetInfo.version = version;
fs.writeFileSync(target, JSON.stringify(targetInfo, null, 4) + "\n");
console.log("[stamp-collab-version] collab plugin version -> " + version + "  (" + target + ")");
