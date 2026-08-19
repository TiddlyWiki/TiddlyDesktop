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
	// (bundled dir + env var). No layout flag: _getAvailableItems scans both the author-nested and
	// the flat shape for every kind, because an env-var library may use either (see its comment).
	//
	// Resolved LAZILY, on every call, rather than captured once here — because "here" is too early
	// for languages. main.js points $tw.config.languagesPath at "../languages-backstage/" for the
	// duration of the backstage boot (those copies carry the injected $:/language/TiddlyDesktop/*
	// strings and plugin-priority 100, so the wiki list itself is translated) and restores the clean
	// "../languages/" in its boot callback. Startup modules run BEFORE that callback, so anything
	// captured at this point sees the backstage copies — which are the wrong thing to hand a user's
	// wiki. Recomputing per call means the chooser, which enumerates when the user opens it, gets the
	// clean library. (_cleanBundledLanguage below stays as a belt-and-braces strip for the same two
	// customisations, since TIDDLYWIKI_LANGUAGE_PATH can supply a priority-bumped language too.)
	function libraryKinds() {
		return [
			$tw.getLibraryItemSearchPaths($tw.config.pluginsPath,   $tw.config.pluginsEnvVar),
			$tw.getLibraryItemSearchPaths($tw.config.themesPath,    $tw.config.themesEnvVar),
			$tw.getLibraryItemSearchPaths($tw.config.languagesPath, $tw.config.languagesEnvVar)
		];
	}

	// Enumerate the bundled / library plugins, themes and languages. This used to run only once
	// ("bundled plugins don't change during a session"), but we now also re-scan when they change
	// ON DISK (see the watcher below) — so a rebuilt or updated item (or an external
	// TIDDLYWIKI_PLUGIN_PATH / TIDDLYWIKI_THEME_PATH / TIDDLYWIKI_LANGUAGE_PATH change) shows up
	// live in the wiki-list "updates available" badge and the chooser, without restarting. Closures
	// below reference these vars by name, so reassigning them takes effect.
	var available = [], availableByTitle = {}, titleByEntry = {}, entryByTitle = {};
	function refreshAvailable() {
		available = [];
		libraryKinds().forEach(function(paths) {
			available = available.concat(_getAvailableItems(paths, fs, path));
		});
		// Update detection (and the wiki-list badge) compares against the NEWEST available
		// version of each plugin, so collapse duplicates here keeping the highest version.
		availableByTitle = {};
		available.forEach(function(p) {
			var prev = availableByTitle[p.title];
			if(!prev || _semverGt(p.version, prev.version)) { availableByTitle[p.title] = p; }
		});
		// A tiddlywiki.info entry is a FILESYSTEM lookup key; the title comes from the folder's
		// plugin.info. They coincide for the bundled libraries (themes/tiddlywiki/vanilla ↔
		// $:/themes/tiddlywiki/vanilla) but need not in general — a flat library reached through
		// TIDDLYWIKI_THEME_PATH holds `elegant` for the title $:/themes/tiddlywiki/elegant. Derive
		// the mapping from what is actually on disk instead of assuming one can be sliced from the
		// other, so "is it installed?" and "remove it" work for any library layout.
		titleByEntry = Object.create(null);
		entryByTitle = Object.create(null);
		available.forEach(function(p) {
			var kind = _kindOf(p["plugin-type"]);
			titleByEntry[kind + "\u0000" + p.name] = p.title;
			if(!entryByTitle[p.title]) { entryByTitle[p.title] = {kind: kind, name: p.name}; }
		});
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
		var installed         = _getInstalledPlugins(wikiUrl, fs, path, titleByEntry);
		var installedVersions = _getInstalledVersions(wikiUrl, fs, path);
		_clearChooserTiddlers(["available"]);

		// The same plugin title can have several available versions (one per library path).
		// Group them so each version becomes its own selectable row, ordered newest-first,
		// and so the per-title default selection can pick the right one exactly once.
		var byTitle = Object.create(null);
		available.forEach(function(p) { (byTitle[p.title] = byTitle[p.title] || []).push(p); });

		var idx = 0;
		Object.keys(byTitle).forEach(function(title) {
			var isInstalled  = installed.indexOf(title) !== -1;
			var installedVer = installedVersions[title] || "";
			var group = byTitle[title].slice();
			// The wiki can hold a version the library doesn't have (installed from elsewhere, or
			// updated since). Give it a row of its own so it can be pre-selected and kept —
			// otherwise the newest LIBRARY version is pre-selected and pressing Apply silently
			// overwrites the wiki's copy with it, downgrading whenever the library is behind.
			// Only when the library actually reports versions. TiddlyWiki's bundled plugin.info
			// files carry no version field at all -- the version is stamped in when the plugin is
			// packed -- so the library says "" while the copy inside the wiki says e.g. "5.4.0".
			// That is a missing version string, not a different version, and treating it as a
			// mismatch put a second row on every bundled plugin.
			var libraryHasVersions = group.some(function(p) { return !!(p.version || ""); });
			if(isFile && isInstalled && installedVer && libraryHasVersions &&
				!group.some(function(p) { return (p.version || "") === installedVer; })) {
				group.push(_keepItem(title, installedVer, group[0] && group[0]["plugin-type"]));
			}
			var items = group.sort(function(a, b) {
				if(_semverGt(a.version, b.version)) { return -1; }
				if(_semverGt(b.version, a.version)) { return 1; }
				// Same version: prefer the bundled copy so reinstall/install uses it.
				if(a.source !== b.source) { return a.source === "bundled" ? -1 : 1; }
				return 0;
			});
			// Drop duplicate versions — the same version found in several library paths
			// should appear once, not once per path.
			var seenVer = Object.create(null);
			items = items.filter(function(it) {
				var v = it.version || "";
				if(seenVer[v]) { return false; }
				seenVer[v] = true;
				return true;
			});
			// The version to pre-select: the one matching what's installed (so opening + Apply
			// is a no-op), else the newest. Folder wikis don't embed a version, so "installed"
			// just means present — pre-select the newest there. For file wikis the match always
			// exists now, because the loop above adds a row for the embedded copy when the
			// library has no counterpart.
			var defaultItem = null;
			if(isInstalled) {
				if(isFile) {
					for(var k = 0; k < items.length; k++) { if((items[k].version || "") === installedVer) { defaultItem = items[k]; break; } }
				}
				if(!defaultItem) { defaultItem = items[0]; }
			}
			items.forEach(function(plugin, order) {
				// Mark the row that represents the current install — the same row we pre-select
				// (defaultItem: the version matching what's embedded, else the newest). Don't
				// require a version-string match here: themes carry no version in plugin.info, so
				// an exact match would never hold and the Reinstall button would never appear.
				var thisInstalled = !!defaultItem && plugin === defaultItem;
				// A newer version than the embedded one (single-file wikis only — folder wikis
				// load the library copy at boot, so they're always current).
				var updateAvailable = isFile && isInstalled && _semverGt(plugin.version, installedVer);
				$tw.wiki.addTiddler(new $tw.Tiddler({
					title: "$:/temp/TiddlyDesktop/PluginChooser/available/" + (idx++),
					tags: ["$:/temp/TiddlyDesktop/PluginChooser/available"],
					"plugin-title": title,
					"plugin-name": plugin.name,
					"plugin-path": plugin.path,
					"plugin-type": plugin["plugin-type"] || "plugin",
					description: plugin.description,
					version: plugin.version,
					"version-order": String(order),
					"version-count": String(items.length),
					"installed-version": installedVer,
					installed: thisInstalled ? "yes" : "",
					"update-available": updateAvailable ? "yes" : "",
					source: plugin.source
				}));
			});
		// Selection holds the chosen version's plugin-path (or "" for "not installed").
		// Reset to the installed state on open; on a live refresh keep any existing choice.
		var selTitle = "$:/temp/TiddlyDesktop/PluginChooser/selected/" + title;
		if(!preserveSelection || !$tw.wiki.tiddlerExists(selTitle)) {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: selTitle, text: defaultItem ? defaultItem.path : ""}));
		}
	});

	// Include plugins that are installed (in tiddlywiki.info) but not found in the
	// available library scan — e.g. from TIDDLYWIKI_PLUGIN_PATH or plugins with an
	// unexpected directory structure. Show them as installed so the user can see and
	// manage them.
	installed.forEach(function(title) {
		if(byTitle[title]) return;
		// A "keep" row, NOT an empty one. An empty plugin-path makes the checkbox's checked and
		// unchecked values identical, so the row renders as ticked, can never be ticked, and the
		// empty selection reads as "remove this" — silently deleting a plugin the user only
		// opened the chooser to look at. Untick it and the selection goes empty, so removal
		// still works; leave it alone and apply finds nothing to do.
		var ver = installedVersions[title] || "";
		var item = _keepItem(title, ver);
		var selTitle = "$:/temp/TiddlyDesktop/PluginChooser/selected/" + title;
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/TiddlyDesktop/PluginChooser/available/" + (idx++),
			tags: ["$:/temp/TiddlyDesktop/PluginChooser/available"],
			"plugin-title": title,
			"plugin-name": item.name,
			"plugin-path": item.path,
			"plugin-type": item["plugin-type"],
			description: "",
			version: ver,
			"version-order": "0",
			"version-count": "1",
			"installed-version": ver,
			installed: "yes",
			"update-available": "",
			source: ""
		}));
		if(!preserveSelection || !$tw.wiki.tiddlerExists(selTitle)) {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: selTitle, text: item.path}));
		}
	});
	}

	// ── open chooser ──────────────────────────────────────────────────────────

	$tw.rootWidget.addEventListener("tiddlydesktop-open-plugin-chooser", function(event) {
		var wikiUrl = event.param;
		if(!wikiUrl) return false;

		// "backstage://self" targets the running wiki-list (backstage) folder wiki itself; applying
		// edits its tiddlywiki.info and reloads the window. It's never "open" in the window list.
		var isSelf = (wikiUrl === "backstage://self");
		var isOpen = isSelf ? false : _isWikiOpen(wikiUrl);
		var isFile = !isSelf && wikiUrl.startsWith("wikifile://");

		// Re-scan the library from disk so the chooser and its update buttons reflect the CURRENT
		// on-disk plugin versions, not a stale startup snapshot.
		refreshAvailable();

		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/TiddlyDesktop/PluginChooser/target",
			text: wikiUrl,
			"wiki-open": isOpen ? "yes" : "no",
			"wiki-type": isSelf ? "self" : (isFile ? "file" : "folder")
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
		// param is the available-row tiddler (a specific version), not the plugin title.
		var availTiddler = event.param && $tw.wiki.getTiddler(event.param);
		var target = $tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/target");
		if(!availTiddler || !target) return false;
		// A "keep" row stands for the wiki's own embedded copy — there is no library folder
		// behind it to install from, so reinstall/update have nothing to do.
		if(String(availTiddler.fields["plugin-path"] || "").indexOf(_KEEP_PREFIX) === 0) return false;
		var wikiUrl = target.fields.text, pluginTitle = availTiddler.fields["plugin-title"];
		if(target.fields["wiki-open"] === "yes") {
			_setStatus("✗ " + $tw.wiki.getTiddlerText("$:/language/TiddlyDesktop/PluginChooser/OpenWarning", "Close the wiki first."));
			return false;
		}
		try {
			// Re-installing the chosen version replaces the wiki's older embedded copy.
			if(wikiUrl.startsWith("wikifile://")) {
				_applyFileChanges(wikiUrl, [availTiddler.fields], [], fs, path);
			} else {
				_applyFolderChanges(wikiUrl, [availTiddler.fields], [], fs, path, entryByTitle);
			}
			// Point the selection at the now-installed version and recompute every row from disk.
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/TiddlyDesktop/PluginChooser/selected/" + pluginTitle, text: availTiddler.fields["plugin-path"]}));
			populateChooserAvailable(true);
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

		// Collect toInstall / toRemove by diffing selection against installed. Selection holds
		// the chosen version's plugin-path per title (or "" for "remove / not installed").
		var isFile            = (targetTid.fields["wiki-type"] === "file");
		var installed         = _getInstalledPlugins(wikiUrl, fs, path, titleByEntry);
		var installedVersions = _getInstalledVersions(wikiUrl, fs, path);
		var toInstall = [], toRemove = [];

		// Index the available rows by path, and gather the distinct plugin titles.
		var fieldsByPath = Object.create(null), titles = [];
		$tw.wiki.filterTiddlers("[tag[$:/temp/TiddlyDesktop/PluginChooser/available]]").forEach(function(availTitle) {
			var f = $tw.wiki.getTiddler(availTitle).fields;
			fieldsByPath[f["plugin-path"]] = f;
			if(titles.indexOf(f["plugin-title"]) === -1) { titles.push(f["plugin-title"]); }
		});

		titles.forEach(function(pluginTitle) {
			var selPath = $tw.wiki.getTiddlerText("$:/temp/TiddlyDesktop/PluginChooser/selected/" + pluginTitle, "");
			var wasInstalled = installed.indexOf(pluginTitle) !== -1;
			var installedVer = installedVersions[pluginTitle] || "";
			if(selPath) {
				var item = fieldsByPath[selPath];
				// Install when not present, or when a different version was chosen (file wikis
				// only — folder wikis reference by name and load whatever the library holds).
				// A library item with no version string is not evidence of a different version
				// (bundled plugin.info files omit it), so it must not read as an upgrade —
				// otherwise Apply reinstalls every bundled plugin every time.
				var itemVer = item ? (item.version || "") : "";
				if(item && (!wasInstalled || (isFile && itemVer && itemVer !== installedVer))) {
					toInstall.push(item);
				}
			} else if(wasInstalled) {
				toRemove.push(pluginTitle);
			}
		});

		if(toInstall.length === 0 && toRemove.length === 0) {
			_closeChooser();
			return false;
		}

		try {
			if(wikiUrl === "backstage://self") {
				// Edit the running backstage folder wiki's tiddlywiki.info. The change is on disk
				// immediately; it takes effect the next time TiddlyDesktop starts.
				//
				// This deliberately does NOT try to reload the wiki list in place. Loading a plugin
				// means re-booting TiddlyWiki, which means re-running main.js in the hidden host
				// window that owns $tw — and main.js is not idempotent: every run creates a tray
				// icon, registers the custom protocol and installs deep-link hooks, none of which
				// are torn down. NW.js keeps a window's Node context across navigation, so a reload
				// orphans those resources; the tray in particular outlives every window and keeps
				// the process (and the profile's Singleton lock) alive after the last window
				// closes, which then blocks the next launch. Spawning a replacement instance
				// instead races that same Singleton and can be absorbed by the exiting one.
				//
				// Writing the change and letting the user restart is the only option with no way to
				// strand the app, so that is what we do.
				_applyFolderChanges(wikiUrl, toInstall, toRemove, fs, path, entryByTitle);
				_setStatus("\u2713 " + $tw.wiki.getTiddlerText("$:/language/TiddlyDesktop/PluginChooser/SavedPendingRestart",
					"Saved. Restart TiddlyDesktop to activate."));
			} else {
				if(wikiUrl.startsWith("wikifile://")) {
					_applyFileChanges(wikiUrl, toInstall, toRemove, fs, path);
				} else {
					_applyFolderChanges(wikiUrl, toInstall, toRemove, fs, path, entryByTitle);
				}
				_scanUpdatesForWiki(wikiUrl, availableByTitle, fs, path);
				_closeChooser();
			}
		} catch(e) {
			_setStatus("✗ Error: " + e.message);
		}

		return false;
	});

	// ── reinstall a single plugin ───────────────────────────────────────────────
	// Force-rewrite this plugin's embedded copy from the bundled version, regardless
	// of whether an update is flagged. A repair action (e.g. a plugin's tiddlers got
	// corrupted) — unlike Update it doesn't require a newer version to be available.
	$tw.rootWidget.addEventListener("tiddlydesktop-reinstall-plugin", function(event) {
		// param is the available-row tiddler (a specific version), not the plugin title.
		var availTiddler = event.param && $tw.wiki.getTiddler(event.param);
		var target = $tw.wiki.getTiddler("$:/temp/TiddlyDesktop/PluginChooser/target");
		if(!availTiddler || !target) return false;
		// A "keep" row stands for the wiki's own embedded copy — there is no library folder
		// behind it to install from, so reinstall/update have nothing to do.
		if(String(availTiddler.fields["plugin-path"] || "").indexOf(_KEEP_PREFIX) === 0) return false;
		var wikiUrl = target.fields.text, pluginTitle = availTiddler.fields["plugin-title"];
		if(target.fields["wiki-open"] === "yes") {
			_setStatus("✗ " + $tw.wiki.getTiddlerText("$:/language/TiddlyDesktop/PluginChooser/OpenWarning", "Close the wiki first."));
			return false;
		}
		try {
			if(wikiUrl.startsWith("wikifile://")) {
				_applyFileChanges(wikiUrl, [availTiddler.fields], [], fs, path);
			} else {
				_applyFolderChanges(wikiUrl, [availTiddler.fields], [], fs, path, entryByTitle);
			}
			// Point the selection at the reinstalled version and recompute every row from disk.
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/temp/TiddlyDesktop/PluginChooser/selected/" + pluginTitle, text: availTiddler.fields["plugin-path"]}));
			populateChooserAvailable(true);
			_setStatus("✓ " + $tw.wiki.getTiddlerText("$:/language/TiddlyDesktop/PluginChooser/Reinstalled", "Reinstalled") + " " + pluginTitle);
			_scanUpdatesForWiki(wikiUrl, availableByTitle, fs, path);
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
		libraryKinds().forEach(function(paths) {
			paths.forEach(function(root) {
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

// Full plugin titles that must never be removed from any wiki — and never offered in the
// chooser (they're core infrastructure, not user-managed plugins).
var _PROTECTED_TITLES = {
	"$:/core": true,
	"$:/core-server": true
};

// Short names (as they appear in tiddlywiki.info) that must never be removed
// from folder wikis — these are required for the TW server to function.
var _PROTECTED_FOLDER_NAMES = {
	"tiddlywiki/tiddlyweb": true,
	"tiddlywiki/filesystem": true
};

// ── "keep" rows ──────────────────────────────────────────────────────────────

// Prefix for the selection value of a row representing the copy a wiki ALREADY holds, where the
// library has nothing matching it. It must be non-empty and unique per title: an empty selection
// is how the chooser says "remove this".
var _KEEP_PREFIX = "keep:";

// A pseudo-library entry standing for that embedded copy. There is no folder behind it to install
// from, so selecting it means "leave this alone" — and because its version is the installed one,
// the apply diff compares equal and skips it.
function _keepItem(title, version, pluginType) {
	return {
		path: _KEEP_PREFIX + title,
		name: title.replace(/^\$:\/(plugins|themes|languages)\//, ""),
		title: title,
		description: "",
		version: version || "",
		"plugin-type": pluginType ||
			(title.indexOf("$:/themes/") === 0 ? "theme" :
				(title.indexOf("$:/languages/") === 0 ? "language" : "plugin")),
		source: ""
	};
}

// ── library enumeration (plugins / themes / languages) ──────────────────────────

// Enumerate installable items under `searchPaths`, in either on-disk layout:
//   `<root>/<author>/<name>/plugin.info`  → name = "author/name"
//   `<root>/<name>/plugin.info`           → name = "name"
// The recorded `name` is exactly what goes in tiddlywiki.info's plugins/themes/languages array —
// a FILESYSTEM lookup key, not a title. The two coincide for the bundled libraries but need not
// in general, which is why `title` is recorded separately and mapped explicitly below.
function _getAvailableItems(searchPaths, fs, path) {
	var items = [];

	function addItem(itemDir, name, source) {
		var infoFile = path.join(itemDir, "plugin.info");
		if(!_isDir(itemDir, fs)) return;
		if(!fs.existsSync(infoFile)) return;
		try {
			var info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
			// NB: no de-dup by title here — the same plugin can exist in several search
			// paths (e.g. a newer copy in TIDDLYWIKI_PLUGIN_PATH alongside the bundled one),
			// and the chooser lists every version so the user can pick which to install.
			if(!info.title) return;
			// Skip protected and backstage-only plugins
			if(_PROTECTED_TITLES[info.title]) return;
			if(info.title === "$:/plugins/tiddlywiki/tiddlydesktop") return;
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

	// Both layouts are scanned for every library, because TiddlyWiki itself doesn't care which one a
	// library uses: findLibraryItem() just resolves `<searchRoot>/<entry>` and takes the title from
	// that folder's plugin.info. The bundled libraries happen to be author-nested for plugins/themes
	// and flat for languages, but a library supplied through TIDDLYWIKI_PLUGIN_PATH /
	// TIDDLYWIKI_THEME_PATH / TIDDLYWIKI_LANGUAGE_PATH is free to be either — this repo's own
	// themes/ directory is flat (themes/elegant) while its titles are author-style
	// ($:/themes/tiddlywiki/elegant). Scanning only one shape made such a library invisible here.
	//
	// Running both is safe: addItem() skips anything without a plugin.info, so a flat scan over a
	// nested root sees only author directories (no plugin.info) and a nested scan over a flat root
	// sees only the item's own files (no sub-directory with a plugin.info).
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
		scanFlat(rootDir, source);
		scanNested(rootDir, source);
	});

	// Group by title, newest version first within each title.
	items.sort(function(a, b) {
		if(a.title !== b.title) { return a.title.localeCompare(b.title); }
		return _semverGt(a.version, b.version) ? -1 : (_semverGt(b.version, a.version) ? 1 : 0);
	});
	return items;
}

function _isDir(p, fs) {
	try { return fs.statSync(p).isDirectory(); } catch(_e) { return false; }
}

// ── installed-plugins query ───────────────────────────────────────────────────

// tiddlywiki.info's plugins/themes/languages arrays, mapped to the kind they live in.
function _kindOf(pluginType) {
	return pluginType === "theme" ? "themes" : (pluginType === "language" ? "languages" : "plugins");
}

function _getInstalledPlugins(wikiUrl, fs, path, titleByEntry) {
	if(wikiUrl === "backstage://self") {
		return _getInstalledFromFolder($tw.boot.wikiPath, fs, path, titleByEntry);
	} else if(wikiUrl.startsWith("wikifile://")) {
		return _getInstalledFromFile(wikiUrl.slice("wikifile://".length), fs);
	} else {
		return _getInstalledFromFolder(wikiUrl.slice("wikifolder://".length), fs, path, titleByEntry);
	}
}

function _getInstalledFromFile(filePath, fs) {
	try {
		var html  = fs.readFileSync(filePath, "utf8");
		var match = html.match(/<script[^>]*class="tiddlywiki-tiddler-store"[^>]*>([\s\S]*?)<\/script>/);
		if(!match) return [];
		// Protected titles are dropped here, once, so nothing downstream offers them in the
		// chooser or queues them for removal. $:/core carries a plugin-type like any plugin, and
		// a row for something the library has no copy of gets an empty selection — which apply
		// reads as "remove this". _applyFileChanges refuses to carry that out, but the chooser
		// should never ask in the first place.
		return JSON.parse(match[1])
			.filter(function(t) { return !!t["plugin-type"] && !_PROTECTED_TITLES[t.title]; })
			.map(function(t) { return t.title; });
	} catch(_e) {
		return [];
	}
}

// Resolve each tiddlywiki.info entry to the title it actually loads as, using the library scan.
// The `prefix + entry` fallback is only for an entry no longer present in any library — it is a
// guess (correct whenever the layout mirrors the title, which is the bundled convention).
function _getInstalledFromFolder(folderPath, fs, path, titleByEntry) {
	var infoPath = path.join(folderPath, "tiddlywiki.info");
	try {
		var info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
		var titles = [];
		function add(kind, entry, prefix) {
			var known = titleByEntry && titleByEntry[kind + "\u0000" + entry];
			titles.push(known || (prefix + entry));
		}
		(info.plugins   || []).forEach(function(p) { add("plugins",   p, "$:/plugins/");   });
		(info.themes    || []).forEach(function(t) { add("themes",    t, "$:/themes/");    });
		(info.languages || []).forEach(function(l) { add("languages", l, "$:/languages/"); });
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

// Strip the two customisations TiddlyDesktop's build applies to a language plugin, so what we install
// into a USER's wiki is a plain language:
//   * $:/language/TiddlyDesktop/* — the wiki-list UI strings (build-translations.js); unused noise
//     outside the backstage.
//   * plugin-priority 100 (set-language-priority.js) — needed in the backstage so the active
//     language's wiki-list strings beat the tiddlydesktop plugin's English defaults, but in a user's
//     wiki it makes the language override core globally. It must also stay a STRING: a numeric
//     plugin-priority in a single-file store white-screens the wiki on boot.
//
// Those customisations live in `languages-backstage/`, and the chooser now enumerates the clean
// `languages/` library (see libraryKinds() above), so this normally finds nothing to do. It is kept
// deliberately: TIDDLYWIKI_LANGUAGE_PATH is also on the search path and can supply a language that
// carries either customisation, and the failure mode — a globally-overriding or wiki-breaking
// language silently baked into someone's wiki — is much worse than a redundant check.
//
// Mutates and returns the loadPluginFolder result in place.
function _cleanBundledLanguage(bundled) {
	if(!bundled || bundled["plugin-type"] !== "language") { return bundled; }
	delete bundled["plugin-priority"];
	try {
		var payload = JSON.parse(bundled.text);
		Object.keys(payload.tiddlers).forEach(function(title) {
			if(title.indexOf("$:/language/TiddlyDesktop/") === 0) { delete payload.tiddlers[title]; }
		});
		bundled.text = JSON.stringify(payload);
	} catch(e) {}
	return bundled;
}

function _applyFileChanges(wikiUrl, toInstall, toRemove, fs, path) {
	var filePath = wikiUrl.slice("wikifile://".length);
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
		_cleanBundledLanguage(bundled);
		// TiddlyWiki tiddler fields must be strings. loadPluginFolder copies plugin.info verbatim, so a
		// numeric field there (e.g. many language plugins' "plugin-priority": 100) enters the store as a
		// JSON number and white-screens the wiki on boot — the plugin unpacker does string operations on
		// the value. Coerce to strings, as TiddlyWiki does when it constructs a tiddler.
		Object.keys(bundled).forEach(function(f) {
			if(typeof bundled[f] !== "string") { bundled[f] = String(bundled[f]); }
		});
		tiddlers = tiddlers.filter(function(t) { return t.title !== bundled.title; });
		tiddlers.push(bundled);
	});

	// Escape every "<" as <, exactly as TiddlyWiki's own saver does (the jsontiddler
	// widget, $:/core/modules/widgets/jsontiddler.js). Inside <script type="application/json">
	// the HTML parser still acts on "</script>", "<!--" and "<script", so a single one of those
	// in an embedded tiddler (language Docs/Help tiddlers are full of them) truncates the store
	// and the wiki boots to a white screen. JSON.parse decodes < back to "<" on load.
	var newStoreJson = JSON.stringify(tiddlers).replace(/</g, "\\u003C");
	// Use a function replacer so $ characters in newStoreJson are not interpreted
	// as replacement pattern specifiers ($& $1 $` $' etc.) — plugin JS code is full of $
	var newHtml = html.replace(storeRe, function() { return match[1] + newStoreJson + match[3]; });
	// Nothing actually changed: leave the file alone entirely — no rewrite, no mtime bump, and no
	// backup slot spent. Applying without installing or removing anything should be observable
	// only by the chooser closing.
	if(newHtml === html) { return; }
	// Back up only once we know we are going to write.
	_backupWikiFile(filePath, fs, path);
	fs.writeFileSync(filePath, newHtml, "utf8");
}

function _applyFolderChanges(wikiUrl, toInstall, toRemove, fs, path, entryByTitle) {
	// "backstage://self" edits the running wiki-list (backstage) folder wiki in place.
	var folderPath = (wikiUrl === "backstage://self") ? $tw.boot.wikiPath : wikiUrl.slice("wikifolder://".length);
	var infoPath   = path.join(folderPath, "tiddlywiki.info");
	var info = {};
	try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch(_e) {}
	info.plugins   = info.plugins   || [];
	info.themes    = info.themes    || [];
	info.languages = info.languages || [];

	// tiddlywiki.info keeps plugins, themes and languages in separate arrays, and each holds a
	// FILESYSTEM lookup key rather than a title. Prefer the entry recorded by the library scan —
	// slicing the prefix off the title only happens to be right when a library's layout mirrors its
	// titles (the bundled convention). For a flat library on TIDDLYWIKI_THEME_PATH the array holds
	// `elegant` while the title is $:/themes/tiddlywiki/elegant, and the sliced guess would look for
	// `tiddlywiki/elegant` — silently removing nothing.
	function arrayFor(title) {
		var known = entryByTitle && entryByTitle[title];
		if(known && info[known.kind]) { return {arr: info[known.kind], name: known.name}; }
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

