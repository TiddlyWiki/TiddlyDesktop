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

// Additional language plugins from TIDDLYWIKI_LANGUAGE_PATH (colon-separated list of
// directories, each containing language-plugin subdirectories). Returns bare language
// names like "fr-FR" — TW resolves them against the configured library paths at boot.
function getExtraLanguages() {
	try {
		var langPath = process.env.TIDDLYWIKI_LANGUAGE_PATH;
		if (!langPath) {
			return [];
		}
		var results = [],
			seen = Object.create(null);
		langPath.split(path.delimiter).forEach(function (dir) {
			dir = (dir || "").trim();
			if (!dir) {
				return;
			}
			try {
				fs.readdirSync(dir).forEach(function (name) {
					try {
						if (seen[name]) {
							return;
						}
						if (
							fs
								.statSync(
									path.resolve(
										dir,
										name,
									),
								)
								.isDirectory()
						) {
							seen[name] = true;
							results.push(name);
						}
					} catch (e) {}
				});
			} catch (e) {}
		});
		return results;
	} catch (e) {
		return [];
	}
}

// Additional themes from TIDDLYWIKI_THEME_PATH (colon-separated list of directories,
// each containing <author>/<name> subdirectory pairs). Returns "author/name" strings
// that TW resolves against the configured theme library paths at boot.
function getExtraThemes() {
	try {
		var themePath = process.env.TIDDLYWIKI_THEME_PATH;
		if (!themePath) {
			return [];
		}
		var results = [],
			seen = Object.create(null);
		themePath.split(path.delimiter).forEach(function (dir) {
			dir = (dir || "").trim();
			if (!dir) {
				return;
			}
			try {
				fs.readdirSync(dir).forEach(function (author) {
					var authorDir = path.resolve(
						dir,
						author,
					);
					try {
						if (
							!fs
								.statSync(
									authorDir,
								)
								.isDirectory()
						) {
							return;
						}
						fs.readdirSync(
							authorDir,
						).forEach(function (name) {
							var key =
								author +
								"/" +
								name;
							try {
								if (seen[key]) {
									return;
								}
								if (
									fs
										.statSync(
											path.resolve(
												authorDir,
												name,
											),
										)
										.isDirectory()
								) {
									seen[
										key
									] =
										true;
									results.push(
										key,
									);
								}
							} catch (e) {}
						});
					} catch (e) {}
				});
			} catch (e) {}
		});
		return results;
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
				"tiddlywiki/elegant",
				"tiddlywiki/noir",
				"tiddlywiki/workbench",
				"tiddlywiki/lucid",
				"tiddlywiki/quietude",
				"tiddlywiki/opaline",
				"tiddlywiki/modern",
			],
		};
	}
	// Always (re)bundle every available language — set unconditionally so an upgrade that
	// adds languages picks them up on the next launch without touching the user's wiki.
	// Also includes any extra language plugins found in TIDDLYWIKI_LANGUAGE_PATH.
	var allLanguages = getBundledLanguages();
	getExtraLanguages().forEach(function (l) {
		if (allLanguages.indexOf(l) === -1) {
			allLanguages.push(l);
		}
	});
	packageJson.languages = allLanguages;
	// Ensure the default themes are always present and add any from TIDDLYWIKI_THEME_PATH.
	var defaultThemes = [
		"tiddlywiki/vanilla",
		"tiddlywiki/snowwhite",
		"tiddlywiki/elegant",
		"tiddlywiki/noir",
		"tiddlywiki/workbench",
		"tiddlywiki/lucid",
		"tiddlywiki/quietude",
		"tiddlywiki/opaline",
		"tiddlywiki/modern",
	];
	var currentThemes = packageJson.themes || [];
	var allThemes = defaultThemes.slice();
	currentThemes.forEach(function (t) {
		if (allThemes.indexOf(t) === -1) {
			allThemes.push(t);
		}
	});
	getExtraThemes().forEach(function (t) {
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
