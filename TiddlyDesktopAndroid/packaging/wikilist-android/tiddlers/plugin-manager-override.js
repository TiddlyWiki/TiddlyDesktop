/*\
title: $:/TiddlyDesktop/startup/plugin-manager.js
type: application/javascript
module-type: startup

Android PluginChooser manager. The desktop original uses Node `fs` to enumerate the plugin
library and to install/remove plugins; the Android WebView has no `fs`, so this version gets
the same data from the native `window.TDPlugins` bridge (see node/PluginBridge.kt) while
keeping the PluginChooser.tid UI contract ($:/temp/TiddlyDesktop/PluginChooser/*).

\*/
"use strict";

exports.name = "tiddlydesktop-plugin-manager-android";
exports.after = ["startup", "rootwidget"];
exports.synchronous = true;

exports.startup = function () {
	var host = (typeof window !== "undefined") ? window.TDPlugins : null;
	var CH = "$:/temp/TiddlyDesktop/PluginChooser/";
	var available = [], availableByTitle = Object.create(null);

	// Core infrastructure, not user-manageable plugins. $:/core carries a plugin-type, so the
	// native scan reports it as installed like anything else — and since it is in no library, it
	// used to become a row with an empty selection, which apply reads as "remove this". Installing
	// any plugin then deleted $:/core and the wiki booted to a blank screen.
	var PROTECTED_TITLES = { "$:/core": true, "$:/core-server": true };

	// Selection value for a row standing for the copy the wiki ALREADY holds, when the library has
	// nothing matching it. It must be non-empty and unique per title, because "" means "remove".
	var KEEP_PREFIX = "keep:";

	function typeFromTitle(title) {
		if (title.indexOf("$:/themes/") === 0) { return "theme"; }
		if (title.indexOf("$:/languages/") === 0) { return "language"; }
		return "plugin";
	}

	// A pseudo-library entry for the copy embedded in the wiki. There is nothing to install from,
	// so selecting it means "leave this alone" — and because its version is the installed one,
	// apply's version comparison finds no difference and skips it. Untick it and the selection
	// goes empty, which still means remove, so managing these rows keeps working.
	function keepItem(title, version, pluginType) {
		return {
			path: KEEP_PREFIX + title,
			name: title.replace(/^\$:\/(plugins|themes|languages)\//, ""),
			title: title,
			description: "",
			version: version || "",
			"plugin-type": pluginType || typeFromTitle(title),
			source: ""
		};
	}

	function semverGt(a, b) {
		a = String(a || "0").split(".").map(Number); b = String(b || "0").split(".").map(Number);
		for (var i = 0; i < 3; i++) { var x = a[i] || 0, y = b[i] || 0; if (x > y) return true; if (x < y) return false; }
		return false;
	}
	function refreshAvailable() {
		available = [];
		if (host) { try { available = JSON.parse(host.listAvailable()) || []; } catch (e) {} }
		// Newest available version per plugin title — drives update detection + the list badges.
		availableByTitle = Object.create(null);
		available.forEach(function (p) {
			var prev = availableByTitle[p.title];
			if (!prev || semverGt(p.version, prev.version)) { availableByTitle[p.title] = p; }
		});
	}
	function clearChooser(prefixes) {
		prefixes.forEach(function (p) {
			$tw.wiki.filterTiddlers("[prefix[" + CH + p + "]]").forEach(function (t) { $tw.wiki.deleteTiddler(t); });
		});
	}
	function setStatus(t) { $tw.wiki.addTiddler(new $tw.Tiddler({ title: CH + "status", text: t })); }
	function getInstalled(url) {
		try {
			var res = (url === "backstage://self") ? JSON.parse(host.wikiListInstalled())
				: JSON.parse(host.getInstalled(url));
			// Drop protected titles here, once, so nothing downstream can offer or remove them.
			res.titles = (res.titles || []).filter(function (t) { return !PROTECTED_TITLES[t]; });
			return res;
		} catch (e) { return { titles: [], versions: {} }; }
	}
	// Back up to the wiki's folder (if granted) using its configured backup count.
	function backupFolder(url) { return $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + url, ""); }
	function backupCountFor(url) {
		var c = parseInt($tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/backup-count/" + url, "20"), 10);
		return (c >= 0) ? c : 20;
	}

	function populate() {
		var target = $tw.wiki.getTiddler(CH + "target");
		if (!target) { return; }
		var url = target.fields.text;
		var isFile = target.fields["wiki-type"] === "file";
		var inst = getInstalled(url);
		clearChooser(["available"]);

		var byTitle = Object.create(null);
		available.forEach(function (p) { (byTitle[p.title] = byTitle[p.title] || []).push(p); });

		var idx = 0;
		Object.keys(byTitle).sort().forEach(function (title) {
			var isInstalled = inst.titles.indexOf(title) !== -1;
			var installedVer = (inst.versions && inst.versions[title]) || "";
			var group = byTitle[title].slice();
			// The wiki can hold a version the library doesn't have (installed from elsewhere, or
			// updated since). Give it a row of its own so it can be pre-selected and kept —
			// otherwise the newest LIBRARY version is pre-selected, and pressing Apply silently
			// overwrites the wiki's copy with it, downgrading if the library is behind.
			// Only when the library actually reports versions. TiddlyWiki's bundled plugin.info
			// files carry no version field at all -- the version is stamped in when the plugin is
			// packed -- so the library says "" while the copy inside the wiki says e.g. "5.4.0".
			// That is a missing version string, not a different version, and treating it as a
			// mismatch put a second row on every bundled plugin.
			var libraryHasVersions = group.some(function (p) { return !!(p.version || ""); });
			if (isFile && isInstalled && installedVer && libraryHasVersions &&
				!group.some(function (p) { return (p.version || "") === installedVer; })) {
				group.push(keepItem(title, installedVer, group[0] && group[0]["plugin-type"]));
			}
			var items = group.sort(function (a, b) {
				return semverGt(a.version, b.version) ? -1 : (semverGt(b.version, a.version) ? 1 : 0);
			});
			var seen = Object.create(null);
			items = items.filter(function (it) { var v = it.version || ""; if (seen[v]) return false; seen[v] = true; return true; });

			var defaultItem = null;
			if (isInstalled) {
				if (isFile) { for (var k = 0; k < items.length; k++) { if ((items[k].version || "") === installedVer) { defaultItem = items[k]; break; } } }
				if (!defaultItem) { defaultItem = items[0]; }
			}
			items.forEach(function (plugin, order) {
				var thisInstalled = !!defaultItem && plugin === defaultItem;
				var updateAvailable = isFile && isInstalled && semverGt(plugin.version, installedVer);
				$tw.wiki.addTiddler(new $tw.Tiddler({
					title: CH + "available/" + (idx++),
					tags: [CH + "available"],
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
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: CH + "selected/" + title,
			text: (isInstalled && defaultItem) ? defaultItem.path : ""
		}));
	});

	// Include plugins that are installed (in tiddlywiki.info) but not found in the
	// available library scan — e.g. from the custom plugins dir or plugins with an
	// unexpected directory structure. Show them as installed so the user can see and
	// manage them.
	inst.titles.forEach(function (title) {
		if (byTitle[title]) return;
		// A "keep" row, NOT an empty one. An empty plugin-path made the checkbox's checked and
		// unchecked values identical, so the row rendered as ticked, could never be ticked, and
		// apply read the empty selection as "remove this" — which is how installing one plugin
		// deleted $:/core and any theme the library had no copy of.
		var ver = (inst.versions && inst.versions[title]) || "";
		var item = keepItem(title, ver);
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: CH + "available/" + (idx++),
			tags: [CH + "available"],
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
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: CH + "selected/" + title,
			text: item.path
		}));
	});
	}

	function closeChooser() {
		clearChooser(["available", "selected"]);
		["target", "search", "status", "tab"].forEach(function (s) { $tw.wiki.deleteTiddler(CH + s); });
	}

	var rw = $tw.rootWidget;

	rw.addEventListener("tiddlydesktop-open-plugin-chooser", function (event) {
		var url = event.param;
		if (!url || !host) { return false; }
		refreshAvailable();
		// "backstage://self" targets the running WikiList folder wiki itself; applying edits its
		// tiddlywiki.info and reboots the WikiList server. It's never "open" in the window list.
		var isSelf = (url === "backstage://self");
		var isOpen = false;
		if (!isSelf) { try { isOpen = !!host.isWikiOpen(url); } catch (e) {} }
		// text = the url (used internally); display-path = the friendly path shown in the header,
		// so the chooser doesn't show the raw base64 wikifile:// URL on Android.
		var displayPath = isSelf ? "" :
			($tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/path/" + url, "") ||
			$tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/title/" + url, "") || url);
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: CH + "target", text: url, "display-path": displayPath, "wiki-open": isOpen ? "yes" : "no",
			"wiki-type": isSelf ? "self" : (url.indexOf("wikifile://") === 0 ? "file" : "folder")
		}));
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: CH + "search", text: "" }));
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: CH + "status", text: "" }));
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: CH + "tab", text: "plugin" }));
		clearChooser(["available", "selected"]);
		populate();
		return false;
	});

	rw.addEventListener("tiddlydesktop-apply-plugin-changes", function () {
		var target = $tw.wiki.getTiddler(CH + "target");
		if (!target || !host) { return false; }
		var url = target.fields.text;
		var isSelf = (url === "backstage://self");
		// Don't modify a wiki's file while it's open — it would race the wiki's own saves.
		if (!isSelf) { try { if (host.isWikiOpen(url)) { setStatus("⚠ Please close the wiki window before applying changes."); return false; } } catch (e) {} }
		var isFile = target.fields["wiki-type"] === "file";
		var inst = getInstalled(url);
		var fieldsByPath = Object.create(null), titles = [];
		$tw.wiki.filterTiddlers("[tag[" + CH + "available]]").forEach(function (at) {
			var f = $tw.wiki.getTiddler(at).fields;
			fieldsByPath[f["plugin-path"]] = f;
			if (titles.indexOf(f["plugin-title"]) === -1) { titles.push(f["plugin-title"]); }
		});
		var toInstall = [], toRemove = [];
		titles.forEach(function (title) {
			var selPath = $tw.wiki.getTiddlerText(CH + "selected/" + title, "");
			var wasInstalled = inst.titles.indexOf(title) !== -1;
			var installedVer = (inst.versions && inst.versions[title]) || "";
			if (selPath) {
				var item = fieldsByPath[selPath];
				// A library item with no version string is not evidence of a different version
				// (bundled plugin.info files omit it), so it must not read as an upgrade --
				// otherwise Apply reinstalls every bundled plugin every time.
				var itemVer = item ? (item.version || "") : "";
				if (item && (!wasInstalled || (isFile && itemVer && itemVer !== installedVer))) {
					toInstall.push({ name: item["plugin-name"], "plugin-type": item["plugin-type"], title: title });
				}
			} else if (wasInstalled) { toRemove.push(title); }
		});
		if (toInstall.length === 0 && toRemove.length === 0) { closeChooser(); return false; }
		setStatus("Applying…");
		var res;
		try {
			if (isSelf) {
				// Edit the running WikiList folder's tiddlywiki.info, then reboot the server so the
				// plugin actually boots (TiddlyWiki only loads plugins at startup).
				res = host.applyToWikiList(JSON.stringify(toInstall), JSON.stringify(toRemove));
			} else {
				res = host.apply(url, JSON.stringify(toInstall), JSON.stringify(toRemove), backupFolder(url), backupCountFor(url));
			}
		} catch (e) { res = e.message; }
		if (res === "ok") {
			closeChooser();
			if (isSelf) { try { window.TDHost.reloadWikiList(); } catch (e) {} }
		} else { setStatus("✗ " + res); }
		return false;
	});

	rw.addEventListener("tiddlydesktop-close-plugin-chooser", function () { closeChooser(); return false; });

	function singleInstall(param) {
		var target = $tw.wiki.getTiddler(CH + "target");
		// param is the available-row tiddler title (a specific version), NOT a plugin path/title.
		var avail = param && $tw.wiki.getTiddler(param);
		if (!target || !host || !avail) { return; }
		var f = avail.fields;
		// A "keep" row stands for the wiki's own embedded copy; there is no library folder behind
		// it to install from, so reinstall/update are meaningless here. Doing nothing beats
		// rewriting the whole file to no effect.
		if (String(f["plugin-path"] || "").indexOf(KEEP_PREFIX) === 0) { return; }
		var url = target.fields.text;
		try { if (host.isWikiOpen(url)) { setStatus("⚠ Please close the wiki window before applying changes."); return; } } catch (e) {}
		setStatus("Applying…");
		var res;
		try {
			res = host.apply(url,
				JSON.stringify([{ name: f["plugin-name"], "plugin-type": f["plugin-type"], title: f["plugin-title"] }]),
				"[]", backupFolder(url), backupCountFor(url));
		} catch (e) { res = e.message; }
		if (res === "ok") {
			// Point the selection at the installed version, recompute rows, refresh this wiki's badge.
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: CH + "selected/" + f["plugin-title"], text: f["plugin-path"] }));
			populate(); setStatus("✓ Done");
			scanWiki(url);
		} else { setStatus("✗ " + res); }
	}
	rw.addEventListener("tiddlydesktop-reinstall-plugin", function (e) { singleInstall(e.param); return false; });
	rw.addEventListener("tiddlydesktop-update-plugin", function (e) { singleInstall(e.param); return false; });

	// ── wiki-list "updates available" badges ────────────────────────────────────
	// Flag single-file wikis whose embedded plugins are older than the bundled library so the row can
	// badge its Plugins button (state tiddler read by WikiListRow.tid). Folder wikis reference plugins
	// by name and resolve them at runtime from the current library, so they're never "outdated".
	function scanWiki(url) {
		var stateTitle = "$:/temp/TiddlyDesktop/plugin-updates/" + url;
		var count = 0;
		if (url.indexOf("wikifile://") === 0) {
			var vers = getInstalled(url).versions || {};
			Object.keys(vers).forEach(function (title) {
				var avail = availableByTitle[title];
				if (avail && semverGt(avail.version, vers[title])) { count++; }
			});
		}
		if (count > 0) { $tw.wiki.addTiddler(new $tw.Tiddler({ title: stateTitle, text: String(count) })); }
		else { $tw.wiki.deleteTiddler(stateTitle); }
	}
	function scanAllUpdates() {
		if (!host) { return; }
		var urls = $tw.wiki.filterTiddlers("[tag[wikilist]]"), i = 0;
		// One wiki per tick — each getInstalled() reads+parses a wiki file natively (synchronous),
		// so yield between them to keep the list responsive.
		(function step() {
			if (i >= urls.length) { return; }
			try { scanWiki(urls[i]); } catch (e) {}
			i++; setTimeout(step, 0);
		})();
	}

	// Called by MainActivity.onResume: re-read the plugin library (host.listAvailable) + re-scan the
	// per-wiki update badges, so a changed library (app update, custom plugin folder edit) shows up
	// on the Plugins buttons automatically — no manual re-scan needed.
	window.__tdRescanPlugins = function () { refreshAvailable(); scanAllUpdates(); };

	if (host) {
		refreshAvailable();
		setTimeout(scanAllUpdates, 1500); // deferred so it never blocks boot
		$tw.wiki.addEventListener("change", function (changes) {
			var rescan = false;
			Object.keys(changes).forEach(function (title) {
				var t = $tw.wiki.getTiddler(title);
				if ((t && t.fields.tags && t.fields.tags.indexOf("wikilist") !== -1) ||
					(changes[title].deleted && title.indexOf("wikifile://") === 0)) { rescan = true; }
			});
			if (rescan) { setTimeout(scanAllUpdates, 300); }
		});
	}
};
