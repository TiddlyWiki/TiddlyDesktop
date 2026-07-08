/*
Remove any plugin-priority from the shared (user-facing) bundled language plugins.

The PluginChooser installs languages into user wikis from source/tiddlywiki/languages, and folder
wikis resolve them from there at boot, so those must be plain plugins. Several upstream language
plugins (de-DE, zh-*) ship plugin-priority 100, which we do NOT want an installed language to carry.
The backstage's OWN translated language set (source/tiddlywiki/languages-backstage) keeps the bump —
see set-language-priority.js — so only the shared copy is stripped here. Run by bld.sh.

Usage: node translations/strip-language-priority.js <languages-dir>
*/

"use strict";

var fs = require("fs"), path = require("path");

var dir = process.argv[2];
if(!dir) { console.error("usage: strip-language-priority.js <languages-dir>"); process.exit(1); }

var n = 0;
fs.readdirSync(dir).forEach(function(name) {
	var infoPath = path.join(dir, name, "plugin.info");
	if(!fs.existsSync(infoPath)) { return; }
	try {
		var info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
		if(info["plugin-type"] === "language" && ("plugin-priority" in info)) {
			delete info["plugin-priority"];
			fs.writeFileSync(infoPath, JSON.stringify(info, null, 4));
			n++;
		}
	} catch(e) {
		console.warn("strip-language-priority: skipping " + name + " (" + e.message + ")");
	}
});
console.log("strip-language-priority: removed plugin-priority from " + n + " language plugins");
