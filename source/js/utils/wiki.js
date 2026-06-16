/*
Utilities concerned with TiddlyWiki internals
*/

"use strict";

var fs = require("fs"),
	path = require("path");

exports.alert = function(text,topic) {
	(new $tw.utils.Logger(topic || "TiddlyDesktop")).alert(text);
};

// Every language TiddlyWiki5 ships, so the wiki list is translatable into all of them
// (the Language toolbar switcher lists whatever language plugins are loaded). Read from
// the bundled core's languages folder so it stays in sync automatically as TW adds more.
// wiki.js lives at <app>/js/utils, the TW core at <app>/tiddlywiki, both in dev and built.
function getBundledLanguages() {
	try {
		var langDir = path.resolve(__dirname,"..","..","tiddlywiki","languages");
		return fs.readdirSync(langDir).filter(function(name) {
			try { return fs.statSync(path.resolve(langDir,name)).isDirectory(); } catch(e) { return false; }
		}).sort();
	} catch(e) {
		return [];
	}
}

// Get the path of the backstage wiki folder, creating it if needed
exports.getBackstageWikiFolder = function(appDataPath) {
	// Create a user configuration wiki folder if it doesn't exist
	var wikiFolder = path.resolve(appDataPath,"user-config-tiddlywiki"),
		packageFilename = path.resolve(wikiFolder,"tiddlywiki.info"),
		packageJson;
	if(fs.existsSync(wikiFolder) && fs.existsSync(packageFilename)) {
		packageJson = JSON.parse(fs.readFileSync(packageFilename,"utf8") || {});
		packageJson.plugins = packageJson.plugins || [];
		if(packageJson.plugins.indexOf("tiddlywiki/tiddlydesktop") === -1) {
			packageJson.plugins.push("tiddlywiki/tiddlydesktop");
		}
		packageJson.includeWikis = [];
	} else {
		packageJson = {
			"description": "TiddlyDesktop backstage user configuration wiki",
			"plugins": [
				"tiddlywiki/filesystem",
				"tiddlywiki/tiddlydesktop"
			],
			"themes": [
				"tiddlywiki/vanilla",
				"tiddlywiki/snowwhite"
			]
		};
	}
	// Always (re)bundle every available language — set unconditionally so an upgrade that
	// adds languages picks them up on the next launch without touching the user's wiki.
	packageJson.languages = getBundledLanguages();
	if(!fs.existsSync(wikiFolder)) {
		fs.mkdirSync(wikiFolder);
	}
	fs.writeFileSync(packageFilename,JSON.stringify(packageJson,null,4));
	return wikiFolder;
};
