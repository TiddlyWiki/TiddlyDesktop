/*
Utilities concerned with TiddlyWiki internals
*/

"use strict";

var fs = require("fs"),
	path = require("path");

exports.alert = function (text, topic) {
	new $tw.utils.Logger(topic || "TiddlyDesktop").alert(text);
};

// Every language TiddlyWiki5 ships, so the wiki list is translatable into all of them
// (the Language toolbar switcher lists whatever language plugins are loaded). Read from
// the bundled core's languages folder so it stays in sync automatically as TW adds more.
// wiki.js lives at <app>/js/utils, the TW core at <app>/tiddlywiki, both in dev and built.
function getBundledLanguages() {
	try {
		var langDir = path.resolve(
			__dirname,
			"..",
			"..",
			"tiddlywiki",
			"languages",
		);
		return fs
			.readdirSync(langDir)
			.filter(function (name) {
				try {
					return fs
						.statSync(
							path.resolve(
								langDir,
								name,
							),
						)
						.isDirectory();
				} catch (e) {
					return false;
				}
			})
			.sort();
	} catch (e) {
		return [];
	}
}

// Get the path of the backstage wiki folder, creating it if needed
exports.getBackstageWikiFolder = function (appDataPath) {
	// Create a user configuration wiki folder if it doesn't exist
	var wikiFolder = path.resolve(appDataPath, "user-config-tiddlywiki"),
		packageFilename = path.resolve(wikiFolder, "tiddlywiki.info"),
		packageJson;
	if (fs.existsSync(wikiFolder) && fs.existsSync(packageFilename)) {
		packageJson = JSON.parse(
			fs.readFileSync(packageFilename, "utf8") || {},
		);
		packageJson.plugins = packageJson.plugins || [];
		if (
			packageJson.plugins.indexOf(
				"tiddlywiki/tiddlydesktop",
			) === -1
		) {
			packageJson.plugins.push("tiddlywiki/tiddlydesktop");
		}
		packageJson.includeWikis = [];
	} else {
		packageJson = {
			description:
				"TiddlyDesktop backstage user configuration wiki",
			plugins: [
				"tiddlywiki/filesystem",
				"tiddlywiki/tiddlydesktop",
			],
			themes: [
				"tiddlywiki/vanilla",
				"tiddlywiki/snowwhite",
			],
		};
	}
	// Bundled languages are (re)set on every launch so an app upgrade that adds languages picks them
	// up — the backstage language switcher needs them present. MERGED, not replaced: an entry the
	// user installed through the PluginChooser (e.g. from TIDDLYWIKI_LANGUAGE_PATH) must survive,
	// and this array used to be overwritten wholesale.
	var allLanguages = getBundledLanguages();
	(packageJson.languages || []).forEach(function (l) {
		if (allLanguages.indexOf(l) === -1) {
			allLanguages.push(l);
		}
	});
	packageJson.languages = allLanguages;
	// Ensure the default themes are present. Nothing else is added here.
	//
	// This deliberately does NOT go looking for themes on TIDDLYWIKI_THEME_PATH. It used to, and
	// scanned without checking for a plugin.info, so pointing that variable at a broad folder wrote
	// every directory it found — .git, .github, unrelated checkouts — into this file as an
	// unresolvable theme name. Discovery belongs to the PluginChooser: it is what presents the
	// available themes and what the user chooses from. This function's only job is to guarantee the
	// wiki can boot, so it guarantees the defaults and otherwise leaves the user's choices alone.
	var defaultThemes = [
		"tiddlywiki/vanilla",
		"tiddlywiki/snowwhite",
	];
	var allThemes = defaultThemes.slice();
	(packageJson.themes || []).forEach(function (t) {
		if (allThemes.indexOf(t) === -1) {
			allThemes.push(t);
		}
	});
	packageJson.themes = allThemes;
	if (!fs.existsSync(wikiFolder)) {
		fs.mkdirSync(wikiFolder);
	}
	fs.writeFileSync(packageFilename, JSON.stringify(packageJson, null, 4));
	return wikiFolder;
};
