/*

Propogate the version number from package.json to:

* plugin.info for the TiddlyDesktop plugin
* $:/plugins/tiddlywiki/tiddlydesktop/version

*/

"use strict";

var fs = require("fs"),
	path = require("path");

// Get package.info
var packageInfo = require("./package.json");

// Insert version number in the nwjs package.json
var nwAppPackageInfo = JSON.parse(fs.readFileSync("./source/package.json","utf8") || {});
nwAppPackageInfo.version = packageInfo.version;
fs.writeFileSync("./source/package.json",JSON.stringify(nwAppPackageInfo,null,4));

// Insert version number in plugin.info
var pluginInfo = JSON.parse(fs.readFileSync("./source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/plugin.info","utf8") || {});
pluginInfo.version = packageInfo.version;
fs.writeFileSync("./source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/plugin.info",JSON.stringify(pluginInfo,null,4));

// Create $:/plugins/tiddlywiki/tiddlydesktop/version
fs.writeFileSync("./source/tiddlywiki/plugins/tiddlywiki/tiddlydesktop/system/version.txt",packageInfo.version);

// NOTE: the collaborative-editing plugin keeps its OWN independent version (see its
// plugin.info), derived at build time by bin/stamp-collab-version.js (run from bld.sh) as
// major.minor + git commit count of its source. We deliberately no longer overwrite it with
// the app version here, so that a wiki can detect a newer bundled collab plugin and offer to
// update it.
