#!/usr/bin/env node
/*
Embed the TiddlyDesktop icon and version metadata into a Windows nw.js executable.

Usage: node bin/set-win-icon.js <exe-path> <ico-path> <version>

Runs on any platform (pure JS, via resedit) so it works on the Linux CI runners
that build the Windows packages. The Windows taskbar / Explorer / Start-menu /
pinned-shortcut icon comes from the icon resource embedded in the .exe, so this
is what brands those (the per-window icon in package.json handles the running
window's title-bar / taskbar-button icon separately).
*/

"use strict";

var fs = require("fs");
var ResEdit = require("resedit");

var exePath = process.argv[2];
var icoPath = process.argv[3];
var version = process.argv[4] || "0.0.0";

if(!exePath || !icoPath) {
	console.error("Usage: node bin/set-win-icon.js <exe-path> <ico-path> <version>");
	process.exit(1);
}

var LANG = 1033;      // en-US
var CODEPAGE = 1200;  // Unicode

var exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
var res = ResEdit.NtExecutableResource.from(exe);

// --- Icon ---------------------------------------------------------------------
var iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
var iconImages = iconFile.icons.map(function(item) { return item.data; });

// Replace every existing icon group so that whichever group Windows picks as the
// application icon is ours; if the exe has none, create group id 1.
var existingGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
if(existingGroups.length > 0) {
	existingGroups.forEach(function(group) {
		ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, iconImages);
	});
} else {
	ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, LANG, iconImages);
}

// --- Version info -------------------------------------------------------------
var parts = version.split(".").map(function(n) { return parseInt(n, 10) || 0; });
while(parts.length < 4) { parts.push(0); }

var viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
var vi = viList.length > 0 ? viList[0] : ResEdit.Resource.VersionInfo.createEmpty();
vi.setFileVersion(parts[0], parts[1], parts[2], parts[3], LANG);
vi.setProductVersion(parts[0], parts[1], parts[2], parts[3], LANG);
vi.setStringValues({ lang: LANG, codepage: CODEPAGE }, {
	ProductName: "TiddlyDesktop",
	FileDescription: "TiddlyDesktop",
	CompanyName: "TiddlyWiki",
	OriginalFilename: "TiddlyDesktop.exe",
	InternalName: "TiddlyDesktop",
	ProductVersion: version,
	FileVersion: version
});
vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log("[set-win-icon] Embedded icon + version " + version + " into " + exePath);
