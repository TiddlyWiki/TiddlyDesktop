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

// Stamp the collaborative-editing plugin with the same version, so that two
// wikis carrying different builds of it are distinguishable (the version was
// previously pinned at 0.0.1 and never changed, which hid build skew between
// wikis and made collab bugs hard to diagnose).
var collabPluginInfoPath = "./source/tiddlywiki/plugins/tiddlywiki/codemirror-6-collab-nwjs/plugin.info";
if(fs.existsSync(collabPluginInfoPath)) {
	var collabPluginInfo = JSON.parse(fs.readFileSync(collabPluginInfoPath,"utf8") || {});
	collabPluginInfo.version = packageInfo.version;
	fs.writeFileSync(collabPluginInfoPath,JSON.stringify(collabPluginInfo,null,4));
}
