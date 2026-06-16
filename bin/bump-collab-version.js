/*
Bump the patch version of the collaborative-editing plugin's plugin.info.

The collab plugin carries its OWN version (decoupled from the TiddlyDesktop app version,
see propagate-version.js), so that a wiki holding an older embedded copy can detect that a
newer one is bundled and offer to update it. The pre-push hook (bin/hooks/pre-push) runs
this whenever the plugin's source changed in the commits being pushed.

Usage: node bin/bump-collab-version.js   (bumps patch, prints the new version)
*/

"use strict";

var fs = require("fs");

var infoPath = "plugins/codemirror-6-collab-nwjs/plugin.info";
var info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
var parts = String(info.version || "0.0.0").split(".").map(function(n) { return parseInt(n, 10) || 0; });
while(parts.length < 3) { parts.push(0); }
parts[2] += 1;
info.version = parts.join(".");
fs.writeFileSync(infoPath, JSON.stringify(info, null, 4) + "\n");
console.log("collab plugin version -> " + info.version);
