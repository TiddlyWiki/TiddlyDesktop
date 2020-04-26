/*
Utilities concerned with TiddlyWiki internals
*/

(function(){

/*jslint browser: true */
"use strict";

var fs = require("fs"),
	path = require("path");

exports.alert = function(text,topic) {
	(new $tw.utils.Logger(topic || "TiddlyDesktop")).alert(text);
};

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
	if(!fs.existsSync(wikiFolder)) {
		fs.mkdirSync(wikiFolder);
	}
	fs.writeFileSync(packageFilename,JSON.stringify(packageJson,null,4));
	return wikiFolder;
};

})();
