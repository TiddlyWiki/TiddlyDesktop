/*\
title: $:/TiddlyDesktop/startup/plugin-manager.js
type: application/javascript
module-type: startup

Plugin manager for the wiki list.

Handles enumerating available plugins (from bundled TW and TIDDLYWIKI_PLUGIN_PATH)
and installing/removing them in single-file wikis (HTML store injection) or
folder wikis (tiddlywiki.info plugins array).

State tiddlers (all temp, deleted on close):
  $:/temp/TiddlyDesktop/PluginChooser/target          — wiki URL being managed
  $:/temp/TiddlyDesktop/PluginChooser/available/*     — one tiddler per available plugin
  $:/temp/TiddlyDesktop/PluginChooser/selected/*      — one tiddler per plugin, text=yes/no
  $:/temp/TiddlyDesktop/PluginChooser/search          — current search string
  $:/temp/TiddlyDesktop/PluginChooser/status          — feedback after apply
\*/

"use strict";

exports.name = "tiddlydesktop-plugin-manager";
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	var fs   = require("fs"),
		path = require("path");

	// Use $tw.getLibraryItemSearchPaths — this is exactly what TW uses internally
	// to locate bundled plugins (resolves relative to $tw.boot.corePath which is
	// the "core" subdirectory, not the package root) plus TIDDLYWIKI_PLUGIN_PATH.
	// __dirname is NOT reliable here — TW executes startup modules through its own
	// module system where __dirname is derived from the tiddler title, not the
	// physical file path.
	// The three library kinds TiddlyWiki resolves at boot, each with its own search paths
	// (bundled dir + env var). Plugins and THEMES are author-nested (`<root>/<author>/<name>`);
	// LANGUAGES are flat (`<root>/<lang>`) and referenced by bare name — hence the per-kind flag.
	var pluginPaths   = $tw.getLibraryItemSearchPaths($tw.config.pluginsPath,   $tw.config.pluginsEnvVar);
	var themePaths    = $tw.getLibraryItemSearchPaths($tw.config.themesPath,    $tw.config.themesEnvVar);
	var languagePaths = $tw.getLibraryItemSearchPaths($tw.config.languagesPath, $tw.config.languagesEnvVar);
	var LIBRARY_KINDS = [
		{paths: pluginPaths,   flat: false},
		{paths: themePaths,    flat: false},
		{paths: languagePaths, flat: true}
	];

	// Enumerate the bundled / library plugins, themes and languages. This used to run only once
	// ("bundled plugins don't change during a session"), but we now also re-scan when they change
	// ON DISK (see the watcher below) — so a rebuilt or updated item (or an external
	// TIDDLYWIKI_PLUGIN_PATH / TIDDLYWIKI_THEME_PATH / TIDDLYWIKI_LANGUAGE_PATH change) shows up
	// live in the wiki-list "updates available" badge and the chooser, without restarting. Closures
	// below reference these vars by name, so reassigning them takes effect.
	var available = [], availableByTitle = {};
	function refreshAvailable() {
		available = [];
		LIBRARY_KINDS.forEach(function(kind) {
			available = available.concat(_getAvailableItems(kind.paths, kind.flat, fs, path));
		});
		availableByTitle = {};
		available.forEach(function(p) { availableByTitle[p.title] = p; });
	}
	refreshAvailable();

	// (Re)populate the chooser's available-plugin tiddlers for whichever wiki it currently targets.
	// Used both when opening the chooser and on a live disk re-scan. preserveSelection keeps the
	// user's tick state (for a live refresh) instead of resetting it to the installed state.
	function populateChooserAvailable(preserveSelection) {
		var target = $tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/target");
		if(!target) { return; }
		var wikiUrl           = target.fields.text;
		var isFile            = (target.fields["wiki-type"] === "file");
		var installed         = _getInstalledPlugins(wikiUrl, fs, path);
		var installedVersions = _getInstalledVersions(wikiUrl, fs, path);
		_clearChooserTiddlers(["available"]);
		available.forEach(function(plugin) {
			var isInstalled    = installed.indexOf(plugin.title) !== -1;
			var installedVer   = installedVersions[plugin.title] || "";
			// A newer bundled version than the embedded one (single-file wikis only — folder
			// wikis load the bundled copy at boot, so they're always current).
			var updateAvailable = isFile && isInstalled && _semverGt(plugin.version, installedVer);
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/temp/TiddlyDesktop/PluginChooser/available/" + plugin.title,
				tags: ["$:/temp/TiddlyDesktop/PluginChooser/available"],
				"plugin-title": plugin.title,
				"plugin-name": plugin.name,
				"plugin-path": plugin.path,
				"plugin-type": plugin["plugin-type"] || "plugin",
				description: plugin.description,
				version: plugin.version,
				"installed-version": installedVer,
				"update-available": updateAvailable ? "yes" : "",
				source: plugin.source
			}));
			// Selection: reset to the installed state on open; on a live refresh keep any existing
			// choice and only seed newly-appeared plugins.
			var selTitle = "$:/temp/TiddlyDesktop/PluginChooser/selected/" + plugin.title;
			if(!preserveSelection || !$tw.wiki.tiddlerExists(selTitle)) {
				$tw.wiki.addTiddler(new $tw.Tiddler({title: selTitle, text: isInstalled ? "yes" : "no"}));
			}
		});
	}

	// ── open chooser ──────────────────────────────────────────────────────────

	$tw.rootWidget.addEventListener("tiddlydesktop-open-plugin-chooser", function(event) {
		var wikiUrl = event.param;
		if(!wikiUrl) return false;

		var isOpen = _isWikiOpen(wikiUrl);
		var isFile = wikiUrl.startsWith("wikifile://");

		// Re-scan the library from disk so the chooser and its update buttons reflect the CURRENT
		// on-disk plugin versions, not a stale startup snapshot.
		refreshAvailable();

		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/TiddlyDesktop/PluginChooser/target",
			text: wikiUrl,
			"wiki-open": isOpen ? "yes" : "no",
			"wiki-type": isFile ? "file" : "folder"
		}));
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/TiddlyDesktop/PluginChooser/search", text: ""}));
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/TiddlyDesktop/PluginChooser/status", text: ""}));
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/TiddlyDesktop/PluginChooser/tab", text: "plugin"}));

		// Remove stale available/selected tiddlers, then populate fresh (resetting selection).
		_clearChooserTiddlers(["available", "selected"]);
		populateChooserAvailable(false);

		return false;
	});

	// ── update a single outdated plugin to the bundled version ──────────────────
	$tw.rootWidget.addEventListener("tiddlydesktop-update-plugin", function(event) {
		var pluginTitle = event.param;
		var target = $tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/target");
		if(!pluginTitle || !target) return false;
		var wikiUrl = target.fields.text;
		if(target.fields["wiki-open"] === "yes") {
			_setStatus("✗ " + $tw.wiki.getTiddlerText("$:/language/TiddlyDesktop/PluginChooser/OpenWarning", "Close the wiki first."));
			return false;
		}
		var availTiddler = $tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/available/" + pluginTitle);
		if(!availTiddler) return false;
		try {
			// Re-installing the bundled plugin replaces the wiki's older embedded copy.
			if(wikiUrl.startsWith("wikifile://")) {
				_applyFileChanges(wikiUrl, [availTiddler.fields], [], fs, path);
			} else {
				_applyFolderChanges(wikiUrl, [availTiddler.fields], [], fs, path);
			}
			// Reflect the new state in the chooser without reopening it.
			$tw.wiki.addTiddler(new $tw.Tiddler(availTiddler.fields, {
				"installed-version": availTiddler.fields.version,
				"update-available": ""
			}));
			_setStatus("✓ " + $tw.wiki.getTiddlerText("$:/language/TiddlyDesktop/PluginChooser/Updated", "Updated") + " " + pluginTitle);
			_scanUpdatesForWiki(wikiUrl, availableByTitle, fs, path);
		} catch(e) {
			_setStatus("✗ Error: " + e.message);
		}
		return false;
	});

	// ── apply changes ─────────────────────────────────────────────────────────

	$tw.rootWidget.addEventListener("tiddlydesktop-apply-plugin-changes", function(event) {
		var targetTid = $tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/target");
		if(!targetTid) return false;
		var wikiUrl = targetTid.fields.text;

		// Block if wiki is still open
		if(_isWikiOpen(wikiUrl)) {
			_setStatus("⚠ Please close the wiki window before applying changes.");
			return false;
		}

		// Collect toInstall / toRemove by diffing selection against installed
		var installed = _getInstalledPlugins(wikiUrl, fs, path);
		var toInstall = [], toRemove = [];

		$tw.wiki.filterTiddlers("[tag[$:/temp/TiddlyDesktop/PluginChooser/available]]").forEach(function(availTitle) {
			var pluginTitle = $tw.wiki.getTiddler(availTitle).fields["plugin-title"];
			var selected = $tw.wiki.getTiddlerText(
				"$:/temp/TiddlyDesktop/PluginChooser/selected/" + pluginTitle, "no"
			) === "yes";
			var wasInstalled = installed.indexOf(pluginTitle) !== -1;
			if(selected && !wasInstalled) {
				toInstall.push($tw.wiki.getTiddler(availTitle).fields);
			} else if(!selected && wasInstalled) {
				toRemove.push(pluginTitle);
			}
		});

		if(toInstall.length === 0 && toRemove.length === 0) {
			_closeChooser();
			return false;
		}

		try {
			if(wikiUrl.startsWith("wikifile://")) {
				_applyFileChanges(wikiUrl, toInstall, toRemove, fs, path);
			} else {
				_applyFolderChanges(wikiUrl, toInstall, toRemove, fs, path);
			}
			_scanUpdatesForWiki(wikiUrl, availableByTitle, fs, path);
			_closeChooser();
		} catch(e) {
			_setStatus("✗ Error: " + e.message);
		}

		return false;
	});

	// ── close chooser ─────────────────────────────────────────────────────────

	$tw.rootWidget.addEventListener("tiddlydesktop-close-plugin-chooser", function(event) {
		_closeChooser();
		return false;
	});

	// Background pass: flag wikis with outdated embedded plugins so the wiki list can badge
	// their Plugins button. Deferred so it never blocks boot; re-runs when the list changes.
	setTimeout(function() { _scanAllUpdates(availableByTitle, fs, path); }, 1500);
	$tw.wiki.addEventListener("change", function(changes) {
		var rescan = false;
		Object.keys(changes).forEach(function(title) {
			var t = $tw.wiki.getTiddler(title);
			if((t && t.fields.tags && t.fields.tags.indexOf("wikilist") !== -1) ||
					(changes[title].deleted && title.indexOf("wikifile://") === 0)) {
				rescan = true;
			}
		});
		if(rescan) { setTimeout(function() { _scanAllUpdates(availableByTitle, fs, path); }, 200); }
	});

	// ── live disk watch ─────────────────────────────────────────────────────────
	// Watch the plugin library on disk. When a plugin's files change there (a rebuild, an app
	// update, or an external TIDDLYWIKI_PLUGIN_PATH edit), re-scan so the wiki-list "updates
	// available" badge and any open chooser reflect the newer versions live — no restart needed.
	// fs.watch isn't recursive on Linux, so we watch each level explicitly: the roots, the author
	// dirs, and each plugin dir (where plugin.info — the version source — lives).
	var _watchers = [], _rescanTimer = null;
	function _setupWatchers() {
		_watchers.forEach(function(w) { try { w.close(); } catch(_e) {} });
		_watchers = [];
		var dirs = Object.create(null);
		LIBRARY_KINDS.forEach(function(kind) {
			kind.paths.forEach(function(root) {
				dirs[root] = true;
				try { fs.readdirSync(root).forEach(function(a) { var ad = path.join(root, a); if(_isDir(ad, fs)) { dirs[ad] = true; } }); } catch(_e) {}
			});
		});
		available.forEach(function(p) { if(p.path) { dirs[p.path] = true; } });
		Object.keys(dirs).forEach(function(d) {
			try { if(fs.existsSync(d)) { _watchers.push(fs.watch(d, function() { _scheduleRescan(); })); } } catch(_e) {}
		});
	}
	function _scheduleRescan() {
		if(_rescanTimer) { clearTimeout(_rescanTimer); }
		_rescanTimer = setTimeout(function() {
			_rescanTimer = null;
			refreshAvailable();
			_setupWatchers();   // the plugin set may have changed → re-establish watches
			_scanAllUpdates(availableByTitle, fs, path);   // refresh the wiki-list badges
			// If the chooser is open, refresh its rows (and update buttons) in place.
			if($tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/target")) {
				populateChooserAvailable(true);
			}
		}, 400);
	}
	try { _setupWatchers(); } catch(e) {}
};

// ── helpers ───────────────────────────────────────────────────────────────────

function _isWikiOpen(wikiUrl) {
	return ($tw.desktop.windowList.windows || []).some(function(w) {
		return typeof w.getIdentifier === "function" && w.getIdentifier() === wikiUrl;
	});
}

function _setStatus(text) {
	$tw.wiki.addTiddler(new $tw.Tiddler({
		title: "$:/temp/TiddlyDesktop/PluginChooser/status",
		text: text
	}));
}

function _clearChooserTiddlers(prefixes) {
	prefixes.forEach(function(prefix) {
		$tw.wiki.filterTiddlers(
			"[prefix[$:/temp/TiddlyDesktop/PluginChooser/" + prefix + "/]]"
		).forEach(function(t) { $tw.wiki.deleteTiddler(t); });
	});
}

function _closeChooser() {
	$tw.wiki.deleteTiddler("$:/temp/TiddlyDesktop/PluginChooser/target");
	$tw.wiki.deleteTiddler("$:/temp/TiddlyDesktop/PluginChooser/search");
	$tw.wiki.deleteTiddler("$:/temp/TiddlyDesktop/PluginChooser/status");
	$tw.wiki.deleteTiddler("$:/temp/TiddlyDesktop/PluginChooser/tab");
	_clearChooserTiddlers(["available", "selected"]);
}

// ── protected titles — never shown in chooser, never removed ─────────────────

// Full plugin titles that must never be removed from any wiki.
var _PROTECTED_TITLES = {
	"$:/core": true
};

// Short names (as they appear in tiddlywiki.info) that must never be removed
// from folder wikis — these are required for the TW server to function.
var _PROTECTED_FOLDER_NAMES = {
	"tiddlywiki/tiddlyweb": true,
	"tiddlywiki/filesystem": true
};

// ── library enumeration (plugins / themes / languages) ──────────────────────────

// Enumerate installable items under `searchPaths`. `flat` chooses the on-disk layout:
//   flat=false → `<root>/<author>/<name>/plugin.info`  (plugins, themes; name = "author/name")
//   flat=true  → `<root>/<name>/plugin.info`           (languages; name = "name")
// The recorded `name` is exactly what goes in tiddlywiki.info's plugins/themes/languages array.
function _getAvailableItems(searchPaths, flat, fs, path) {
	var items = [], seen = {};

	function addItem(itemDir, name, source) {
		var infoFile = path.join(itemDir, "plugin.info");
		if(!_isDir(itemDir, fs)) return;
		if(!fs.existsSync(infoFile)) return;
		try {
			var info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
			if(!info.title || seen[info.title]) return;
			// Skip protected and backstage-only plugins
			if(_PROTECTED_TITLES[info.title]) return;
			if(info.title === "$:/plugins/tiddlywiki/tiddlydesktop") return;
			seen[info.title] = true;
			items.push({
				path: itemDir,
				name: name,
				title: info.title,
				description: info.description || "",
				version: info.version || "",
				"plugin-type": info["plugin-type"] || "plugin",
				source: source
			});
		} catch(_e) {}
	}

	function scanFlat(rootDir, source) {           // <root>/<name>/plugin.info
		var entries;
		try { entries = fs.readdirSync(rootDir); } catch(_e) { return; }
		entries.forEach(function(name) { addItem(path.join(rootDir, name), name, source); });
	}
	function scanNested(rootDir, source) {         // <root>/<author>/<name>/plugin.info
		var authors;
		try { authors = fs.readdirSync(rootDir); } catch(_e) { return; }
		authors.forEach(function(author) {
			var authorDir = path.join(rootDir, author);
			if(!_isDir(authorDir, fs)) return;
			var names;
			try { names = fs.readdirSync(authorDir); } catch(_e) { return; }
			names.forEach(function(name) { addItem(path.join(authorDir, name), author + "/" + name, source); });
		});
	}

	(searchPaths || []).forEach(function(rootDir, i) {
		if(!fs.existsSync(rootDir)) return;
		var source = i === 0 ? "bundled" : "external";
		if(flat) { scanFlat(rootDir, source); } else { scanNested(rootDir, source); }
	});

	items.sort(function(a, b) { return a.title.localeCompare(b.title); });
	return items;
}

function _isDir(p, fs) {
	try { return fs.statSync(p).isDirectory(); } catch(_e) { return false; }
}

// ── installed-plugins query ───────────────────────────────────────────────────

function _getInstalledPlugins(wikiUrl, fs, path) {
	if(wikiUrl.startsWith("wikifile://")) {
		return _getInstalledFromFile(wikiUrl.slice("wikifile://".length), fs);
	} else {
		return _getInstalledFromFolder(wikiUrl.slice("wikifolder://".length), fs, path);
	}
}

function _getInstalledFromFile(filePath, fs) {
	try {
		var html  = fs.readFileSync(filePath, "utf8");
		var match = html.match(/<script[^>]*class="tiddlywiki-tiddler-store"[^>]*>([\s\S]*?)<\/script>/);
		if(!match) return [];
		return JSON.parse(match[1])
			.filter(function(t) { return !!t["plugin-type"]; })
			.map(function(t) { return t.title; });
	} catch(_e) {
		return [];
	}
}

function _getInstalledFromFolder(folderPath, fs, path) {
	var infoPath = path.join(folderPath, "tiddlywiki.info");
	try {
		var info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
		var titles = [];
		(info.plugins   || []).forEach(function(p) { titles.push("$:/plugins/" + p); });
		(info.themes    || []).forEach(function(t) { titles.push("$:/themes/" + t); });
		(info.languages || []).forEach(function(l) { titles.push("$:/languages/" + l); });
		return titles;
	} catch(_e) {
		return [];
	}
}

// ── update detection (single-file wikis only) ──────────────────────────────────
// Folder wikis reference plugins by name and load the bundled copy at boot, so they are
// always current; only single-file wikis embed a plugin (with its version) that can lag.

// title -> embedded version, for the plugins baked into a single-file wiki.
function _getInstalledVersions(wikiUrl, fs, path) {
	if(!wikiUrl.startsWith("wikifile://")) { return {}; }
	try {
		var html  = fs.readFileSync(wikiUrl.slice("wikifile://".length), "utf8");
		var match = html.match(/<script[^>]*class="tiddlywiki-tiddler-store"[^>]*>([\s\S]*?)<\/script>/);
		if(!match) { return {}; }
		var map = {};
		JSON.parse(match[1]).forEach(function(t) {
			if(t["plugin-type"] && t.title) { map[t.title] = t.version || ""; }
		});
		return map;
	} catch(_e) {
		return {};
	}
}

// True if version a is strictly newer than version b (numeric dotted compare). Returns
// false if either is missing, so an unknown version never falsely claims an update.
function _semverGt(a, b) {
	if(!a || !b) { return false; }
	var pa = String(a).split("."), pb = String(b).split(".");
	for(var i = 0; i < Math.max(pa.length, pb.length); i++) {
		var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
		if(x > y) { return true; }
		if(x < y) { return false; }
	}
	return false;
}

// Count this wiki's outdated plugins and write the count to a temp tiddler that the wiki
// list row reads to show a badge on its Plugins button (deleted when nothing is outdated).
function _scanUpdatesForWiki(wikiUrl, availableByTitle, fs, path) {
	var stateTitle = "$:/temp/TiddlyDesktop/plugin-updates/" + wikiUrl;
	var count = 0;
	if(wikiUrl.startsWith("wikifile://")) {
		var versions = _getInstalledVersions(wikiUrl, fs, path);
		Object.keys(versions).forEach(function(title) {
			var avail = availableByTitle[title];
			if(avail && _semverGt(avail.version, versions[title])) { count++; }
		});
	}
	if(count > 0) {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: stateTitle, text: String(count)}));
	} else {
		$tw.wiki.deleteTiddler(stateTitle);
	}
}

function _scanAllUpdates(availableByTitle, fs, path) {
	$tw.wiki.filterTiddlers("[tag[wikilist]]").forEach(function(wikiUrl) {
		try { _scanUpdatesForWiki(wikiUrl, availableByTitle, fs, path); } catch(_e) {}
	});
}

// ── apply changes ─────────────────────────────────────────────────────────────

function _backupWikiFile(filePath, fs, path) {
	if(!fs.existsSync(filePath)) return;
	var backupTemplate = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/BackupPath", "./$filename$_backup/");
	var filename = path.basename(filePath);
	var backupDir = backupTemplate
		.replace(/\$filename\$/mgi, filename)
		.replace(/\$filepath\$/mgi, filePath);
	backupDir = path.resolve(path.dirname(filePath), backupDir);
	var ext  = path.extname(filePath);
	var base = path.basename(filePath, ext);
	var ts   = $tw.utils.stringifyDate(fs.statSync(filePath).mtime || new Date());
	var count = 0, backupPath;
	do {
		backupPath = path.join(backupDir, base + "." + ts + (count ? " " + count : "") + ext);
		count++;
	} while(fs.existsSync(backupPath));
	$tw.utils.createDirectory(path.dirname(backupPath));
	fs.writeFileSync(backupPath, fs.readFileSync(filePath));
}

function _applyFileChanges(wikiUrl, toInstall, toRemove, fs, path) {
	var filePath = wikiUrl.slice("wikifile://".length);
	_backupWikiFile(filePath, fs, path);
	var html = fs.readFileSync(filePath, "utf8");

	var storeRe = /(<script[^>]*class="tiddlywiki-tiddler-store"[^>]*>)([\s\S]*?)(<\/script>)/;
	var match   = html.match(storeRe);
	if(!match) throw new Error("Not a TiddlyWiki5 file — tiddler store not found.");

	var tiddlers = JSON.parse(match[2]);

	// Remove (never touch protected titles)
	toRemove.forEach(function(title) {
		if(_PROTECTED_TITLES[title]) return;
		tiddlers = tiddlers.filter(function(t) { return t.title !== title; });
	});

	// Install — use TW's own loadPluginFolder so all file types are handled correctly
	toInstall.forEach(function(pluginFields) {
		var bundled = $tw.loadPluginFolder(pluginFields["plugin-path"]);
		if(!bundled) return;
		tiddlers = tiddlers.filter(function(t) { return t.title !== bundled.title; });
		tiddlers.push(bundled);
	});

	// Escape </script> inside JSON so it doesn't end the script tag prematurely
	var newStoreJson = JSON.stringify(tiddlers).replace(/<\/script>/gi, "<\\/script>");
	// Use a function replacer so $ characters in newStoreJson are not interpreted
	// as replacement pattern specifiers ($& $1 $` $' etc.) — plugin JS code is full of $
	var newHtml = html.replace(storeRe, function() { return match[1] + newStoreJson + match[3]; });
	fs.writeFileSync(filePath, newHtml, "utf8");
}

function _applyFolderChanges(wikiUrl, toInstall, toRemove, fs, path) {
	var folderPath = wikiUrl.slice("wikifolder://".length);
	var infoPath   = path.join(folderPath, "tiddlywiki.info");
	var info = {};
	try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch(_e) {}
	info.plugins   = info.plugins   || [];
	info.themes    = info.themes    || [];
	info.languages = info.languages || [];

	// tiddlywiki.info keeps plugins, themes and languages in separate arrays. Route by the title
	// prefix ($:/themes/… / $:/languages/… / else plugins); the bare name (after the prefix) is
	// what the array holds.
	function arrayFor(title) {
		if(title.indexOf("$:/themes/")    === 0) { return {arr: info.themes,    name: title.slice("$:/themes/".length)}; }
		if(title.indexOf("$:/languages/") === 0) { return {arr: info.languages, name: title.slice("$:/languages/".length)}; }
		return {arr: info.plugins, name: title.replace(/^\$:\/plugins\//, "")};
	}

	// Remove (never touch protected titles or required server plugins)
	toRemove.forEach(function(title) {
		if(_PROTECTED_TITLES[title]) return;
		var t = arrayFor(title);
		if(_PROTECTED_FOLDER_NAMES[t.name]) return;
		var arr = t.arr;
		for(var i = arr.length - 1; i >= 0; i--) { if(arr[i] === t.name) { arr.splice(i, 1); } }
	});

	// Install — into the array matching the item's plugin-type.
	toInstall.forEach(function(fields) {
		var name = fields["plugin-name"];
		if(!name) { return; }
		var type = fields["plugin-type"] || "plugin";
		var arr = type === "theme" ? info.themes : (type === "language" ? info.languages : info.plugins);
		if(arr.indexOf(name) === -1) { arr.push(name); }
	});

	fs.writeFileSync(infoPath, JSON.stringify(info, null, 4), "utf8");
}

