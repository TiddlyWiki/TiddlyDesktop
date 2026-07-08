/*
Give every bundled TiddlyWiki language plugin plugin-priority 100.

Most TW language plugins ship no `plugin-priority` (so it defaults to 1), which ties the
tiddlydesktop plugin (also default 1); on a tie TiddlyWiki breaks by plugin title, and
"$:/plugins/tiddlywiki/tiddlydesktop" sorts after "$:/languages/<x>", so the tiddlydesktop
plugin's ENGLISH `$:/language/TiddlyDesktop/*` strings overwrite the language's translation.

Bumping every language plugin to 100 (a few — de-*, zh-* — already are) makes the active
language always win its strings, including the injected WikiList translations. Run by
bld.sh after the TW core is copied into source/tiddlywiki.

Usage: node translations/set-language-priority.js <languages-dir>
*/

"use strict";

var fs = require("fs"), path = require("path");

var dir = process.argv[2];
if(!dir) { console.error("usage: set-language-priority.js <languages-dir>"); process.exit(1); }

var n = 0;
fs.readdirSync(dir).forEach(function(name) {
	var infoPath = path.join(dir, name, "plugin.info");
	if(!fs.existsSync(infoPath)) { return; }
	try {
		var info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
		// Write the priority as the STRING "100", not the number 100. TiddlyWiki tiddler fields must
		// be strings: a numeric plugin-priority survives into a single-file wiki's JSON store as a
		// JSON number and white-screens the wiki on boot (the plugin unpacker does string ops on it).
		// Core itself ships "plugin-priority": "0" (a string) for the same reason; several upstream
		// languages ship the number 100, which this normalises too.
		if(info["plugin-type"] === "language" && info["plugin-priority"] !== "100") {
			info["plugin-priority"] = "100";
			fs.writeFileSync(infoPath, JSON.stringify(info, null, 4));
			n++;
		}
	} catch(e) {
		console.warn("set-language-priority: skipping " + name + " (" + e.message + ")");
	}
});
console.log("set-language-priority: ensured plugin-priority 100 on " + n + " language plugins");
