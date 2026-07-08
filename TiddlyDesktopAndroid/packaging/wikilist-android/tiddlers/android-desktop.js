/*\
title: $:/TiddlyDesktop/android/desktop.js
type: application/javascript
module-type: startup

Android implementation of the `$tw.desktop` API the classic tiddlydesktop plugin expects.

On NW.js this API is provided by the host process (source/js/*). On Android there is no
NW.js, so we implement it here on top of the native `window.TDHost` bridge (host/TDHost.kt).
This module also registers the rootWidget message handlers (replacing the plugin's
node-only handlers.js, which is stubbed out for Android).

Wiki identity: each wiki is a tiddler titled `wikifile://<b64>` or `wikifolder://<b64>`
(base64url of the content:// path — see host/WikiUrl.kt), tagged `wikilist`. Because the
WikiList is served by Node.js, these tiddlers persist to disk automatically.

\*/
"use strict";

exports.name = "tiddlydesktop-android";
exports.after = ["startup", "rootwidget"];
exports.synchronous = true;

exports.startup = function () {
	var host = (typeof window !== "undefined") ? window.TDHost : null;

	$tw.desktop = $tw.desktop || {};
	$tw.desktop.version = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/version", "");

	// The backstage, Settings and Help are VIEWS of this same backstage wiki (one $tw
	// instance), switched in-page via $:/temp/td-view (see $:/core/ui/RootTemplate). Because
	// it's the same runtime as the WikiList, changing theme/palette/language in the backstage
	// applies to the WikiList live — exactly like TiddlyDesktop.
	function setView(view, tiddler) {
		if (tiddler) {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/temp/td-view-tiddler", text: tiddler }));
		}
		if (view) {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/temp/td-view", text: view }));
		} else {
			$tw.wiki.deleteTiddler("$:/temp/td-view");
		}
	}

	function alert(msg) {
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/tiddlydesktop/alert",
			tags: "$:/tags/Alert",
			text: msg,
			component: "tiddlydesktop"
		}));
	}

	function titleFor(url) {
		return $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/title/" + url, "") || url;
	}

	function isFolderUrl(url) {
		return url.indexOf("wikifolder://") === 0;
	}

	// Native/live favicon arrives as a data: URI, but the WikiListRow renders it with <$image
	// source=tiddler>, which builds src="data:<type>;base64,<text>" from the tiddler's type+text.
	// Storing the whole data URI as text (type image/x-icon) double-wraps it → broken image. So
	// split the data URI into a raw base64 (or raw SVG) text + the real mime type.
	function storeFavicon(url, favicon) {
		var t = "$:/TiddlyDesktop/Config/favicon/" + url;
		if (!favicon) { return; }
		var type = "image/x-icon", text = favicon;
		var m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(favicon);
		if (m) {
			type = m[1] || "image/x-icon";
			text = m[2] ? m[3].replace(/\s+/g, "") : decodeURIComponent(m[3]);
		}
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: t, text: text, type: type }));
	}

	$tw.desktop.utils = $tw.desktop.utils || {};
	$tw.desktop.utils.wiki = { alert: alert };

	$tw.desktop.gui = {
		Shell: {
			openExternal: function (url) { if (host) host.openExternal(url); },
			openItem: function () { alert("Not available on Android."); },
			showItemInFolder: function () { alert("Not available on Android."); }
		},
		App: { dataPath: "" },
		Window: { open: function () {} }
	};

	$tw.desktop.backstageWindow = {
		show: function () { setView("backstage"); }
	};

	$tw.desktop.windowList = {
		windows: [],
		decodeUrl: function (url) { return { type: isFolderUrl(url) ? "folder" : "file" }; },
		openByUrl: function (url) {
			// backstage://<tiddler> switches THIS window to a backstage/settings/help view
			// (same $tw). Real wikis (wikifile://…/wikifolder://…) open in their own window.
			if (url.indexOf("backstage://") === 0) {
				var t = url.slice("backstage://".length);
				if (t && t !== "WikiListWindow") { setView("tiddler", t); }
				else { setView(""); }
				return;
			}
			if (host) {
				var disabled = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/disable-backups/" + url, "no") === "yes";
				var count = parseInt($tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/backup-count/" + url, "20"), 10);
				if (!(count >= 0)) { count = 20; }
				var folder = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + url, "");
				host.openWiki(url, titleFor(url), isFolderUrl(url), !disabled, count, folder);
			}
		},
		// On Android, adding a wiki goes through the native SAF picker (see the toolbar
		// overrides + window.__tdAddWiki below), so openByPathname isn't used directly.
		openByPathname: function () {
			alert("Use the Add buttons to pick a wiki via the file picker.");
		},
		removeByUrl: function (url) {
			$tw.wiki.deleteTiddler(url);
			$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/title/" + url);
			$tw.wiki.deleteTiddler("$:/TiddlyDesktop/Config/favicon/" + url);
		},
		revealByUrl: function () { alert("Reveal in file manager isn't available on Android."); },
		revealBackupsByUrl: function () { alert("Reveal backups isn't available on Android."); }
	};

	// Called by native (MainActivity) after a SAF pick: register the wiki, then open it.
	// `path` is a human-readable location; `folder` is the SAF tree URI of the containing
	// folder (single-file wikis) used for backups + Reveal.
	window.__tdAddWiki = function (url, title, favicon, isFolder, path, folder) {
		if (folder) {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/folder/" + url, text: folder }));
		}
		if (!$tw.wiki.getTiddler(url)) {
			$tw.wiki.addTiddler(new $tw.Tiddler(
				$tw.wiki.getCreationFields(),
				{ title: url, tags: "wikilist" },
				$tw.wiki.getModificationFields()
			));
		}
		if (title) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/TiddlyDesktop/Config/title/" + url, text: title
			}));
		}
		if (path) {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/TiddlyDesktop/Config/path/" + url, text: path
			}));
		}
		storeFavicon(url, favicon);
		$tw.desktop.windowList.openByUrl(url);
	};

	// Native re-linked a wiki to a newly-picked file/folder (its SAF grant had been lost):
	// carry over the folder config, drop the stale entry, register + open the new one.
	window.__tdRelinkWiki = function (oldUrl, newUrl, isFolder, title, path) {
		var folder = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + oldUrl, "");
		$tw.desktop.windowList.removeByUrl(oldUrl);
		// Pass the freshly-derived readable path so Config/path/<newUrl> is set — otherwise the row
		// (and PluginChooser) would fall back to showing the raw base64 wikifile:// URL.
		window.__tdAddWiki(newUrl, title, "", isFolder, path || "", folder);
	};

	// Native re-granted the containing folder of a single-file wiki.
	window.__tdSetWikiFolder = function (url, folder) {
		if (folder) {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/folder/" + url, text: folder }));
		}
	};

	// Native pushes live SiteTitle/SiteSubtitle/favicon (+ whether it's a TiddlyWiki Classic wiki)
	// extracted from the wiki content.
	window.__tdSetWikiMeta = function (url, title, subtitle, favicon, isClassic) {
		if (title) {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/title/" + url, text: title }));
		}
		// Only overwrite when we actually have a subtitle. The live push (meta-push.js) resolves
		// $:/SiteSubtitle including its shadow/default, but the static re-extraction returns ""
		// for a default subtitle — so deleting on "" would clobber the good live value.
		if (subtitle) {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/subtitle/" + url, text: subtitle }));
		}
		storeFavicon(url, favicon);
		// Classic wikis (TW 2.x) are single-file and have no plugins/folder concept — the row hides
		// the "to folder" + "Plugins" buttons when Config/classic/<url> is "yes".
		var classicTitle = "$:/TiddlyDesktop/Config/classic/" + url;
		if (isClassic === true || isClassic === "true") {
			$tw.wiki.addTiddler(new $tw.Tiddler({ title: classicTitle, text: "yes" }));
		} else {
			$tw.wiki.deleteTiddler(classicTitle);
		}
	};

	// Refresh metadata for every listed wiki (live favicon + SiteTitle/SiteSubtitle).
	function refreshAllMeta() {
		if (!host || !host.refreshWikiMeta) { return; }
		$tw.wiki.filterTiddlers("[tag[wikilist]]").forEach(function (url) {
			try { host.refreshWikiMeta(url); } catch (e) {}
		});
	}
	// Called by MainActivity.onResume so titles/favicons update when returning to the list
	// (e.g. after editing a wiki's SiteTitle/favicon and coming back).
	window.__tdRefreshAllMeta = refreshAllMeta;

	// Push the wiki list to native (SharedPreferences) so the Quick Note widget/activity can offer a
	// wiki chooser without booting this server. Refreshed on load and (debounced) on list/config change.
	function pushWikiList() {
		if (!host || !host.saveWikiList) { return; }
		try {
			var list = $tw.wiki.filterTiddlers("[tag[wikilist]]").map(function (url) {
				var disabled = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/disable-backups/" + url, "no") === "yes";
				var count = parseInt($tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/backup-count/" + url, "20"), 10);
				if (!(count >= 0)) { count = 20; }
				return {
					url: url, title: titleFor(url), isFolder: isFolderUrl(url),
					backupsEnabled: !disabled, backupCount: count,
					backupDir: $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + url, "")
				};
			});
			host.saveWikiList(JSON.stringify(list));
		} catch (e) {}
	}
	var _pushTimer = null;
	function schedulePush() { if (_pushTimer) { clearTimeout(_pushTimer); } _pushTimer = setTimeout(pushWikiList, 500); }
	pushWikiList();
	$tw.wiki.addEventListener("change", function (changes) {
		var relevant = Object.keys(changes).some(function (t) {
			return t.indexOf("wikifile://") === 0 || t.indexOf("wikifolder://") === 0 ||
				t.indexOf("$:/TiddlyDesktop/Config/") === 0 || t.indexOf("$:/SiteTitle") === 0;
		});
		if (relevant) { schedulePush(); }
	});

	// ── rootWidget message handlers (Android replacement for handlers.js) ────────────
	var rw = $tw.rootWidget;
	function on(type, fn) { rw.addEventListener(type, function (e) { fn(e); return false; }); }

	on("tiddlydesktop-open-backstage-wiki", function () { $tw.desktop.backstageWindow.show(); });
	on("tiddlydesktop-add-wiki-url", function (e) { $tw.desktop.windowList.openByUrl(e.param); });
	on("tiddlydesktop-remove-wiki-url", function (e) { $tw.desktop.windowList.removeByUrl(e.param); });
	function revealWikiFolder(url) {
		var folder = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + url, "");
		if (host) { host.revealFolder(folder); }
	}
	on("tiddlydesktop-reveal-url-in-shell", function (e) { revealWikiFolder(e.param); });
	on("tiddlydesktop-reveal-backups-wiki-url", function (e) {
		var folder = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + e.param, "");
		if (host) { host.revealBackups(folder, e.param); }
	});
	on("tiddlydesktop-convert-wiki", function (e) { if (host) host.convertWiki(e.param); });
	on("tiddlydesktop-clone-wiki", function (e) { if (host) host.cloneWiki(e.param); });
	// tiddlydesktop-open-plugin-chooser is handled by the Android plugin manager
	// ($:/TiddlyDesktop/startup/plugin-manager.js).

	// Android-native "add wiki" buttons (see the toolbar overrides).
	on("tiddlydesktop-android-add-file", function () { if (host) host.addSingleFileWiki(); });
	on("tiddlydesktop-android-add-folder", function () { if (host) host.addFolderWiki(); });
	on("tiddlydesktop-android-pick-plugin-folder", function () { if (host) host.pickPluginFolder(); });
	// Language switch: only the active language is loaded, so native reboots the WikiList server
	// with the chosen one and reloads. e.param is the language title, e.g. "$:/languages/de-DE".
	on("tiddlydesktop-android-set-language", function (e) { if (host && host.setLanguage) host.setLanguage(e.param); });

	// Native reports the chosen custom plugin folder's readable path (for display).
	window.__tdSetPluginPath = function (path) {
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/custom-plugin-path", text: path }));
	};

	// ── persistent settings (config folder) ──────────────────────────────────────────
	// The WikiList's user data (wiki list + settings) lives in app-private storage, wiped on
	// uninstall. If the user picks a config folder (SAF, outside the sandbox), we export the
	// user tiddlers there and restore them on a fresh install — surviving reinstalls.
	var USER_SETTINGS_FILTER =
		"[tag[wikilist]] [prefix[$:/TiddlyDesktop/Config/]] [[$:/theme]] [[$:/palette]] [[$:/language]]" +
		" -[[$:/TiddlyDesktop/Config/config-folder-path]] -[[$:/TiddlyDesktop/Config/custom-plugin-path]]" +
		" -[[$:/TiddlyDesktop/Config/backup-folder-path]]";

	function buildSettingsJson() { return $tw.wiki.getTiddlersAsJson(USER_SETTINGS_FILTER); }
	function importSettings(json) {
		try {
			$tw.wiki.deserializeTiddlers("application/json", json, {}).forEach(function (fields) {
				$tw.wiki.addTiddler(new $tw.Tiddler(fields));
			});
		} catch (e) {}
	}
	function hasLocalWikis() { return $tw.wiki.filterTiddlers("[tag[wikilist]]").length > 0; }

	var exportTimer = null;
	function scheduleExport() {
		if (!host || !host.exportSettings) { return; }
		if (exportTimer) { clearTimeout(exportTimer); }
		exportTimer = setTimeout(function () {
			try { host.exportSettings(buildSettingsJson()); } catch (e) {}
		}, 1500);
	}

	// ── share TO wiki (native ACTION_SEND → pick a wiki here → import) ────────────────
	function endShareMode() { $tw.wiki.deleteTiddler("$:/state/td-share-mode"); }
	window.__tdBeginShare = function () {
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/state/td-share-mode", text: "yes" }));
		if (window.__tdShareEnriched) { window.__tdShareEnriched(); } // populate the preview
	};
	on("tiddlydesktop-share-to-wiki", function (e) {
		var url = e.param;
		endShareMode();
		if (!url || !host) { return; }
		var disabled = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/disable-backups/" + url, "no") === "yes";
		var count = parseInt($tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/backup-count/" + url, "20"), 10);
		if (!(count >= 0)) { count = 20; }
		var folder = $tw.wiki.getTiddlerText("$:/TiddlyDesktop/Config/folder/" + url, "");
		// Render a share template unless it's a raw file share (native holds that payload).
		var tiddlersJson = "";
		try {
			var data = JSON.parse(host.getShareData() || "{}");
			if (data.kind && data.kind !== "file" && window.__tdApplyShareTemplate) {
				tiddlersJson = window.__tdApplyShareTemplate(JSON.stringify(data));
			}
		} catch (err) {}
		host.shareToWiki(url, titleFor(url), isFolderUrl(url), !disabled, count, folder, tiddlersJson);
	});
	on("tiddlydesktop-share-cancel", function () { if (host) { host.cancelShare(); } endShareMode(); });
	// Cold-launch share: pull the pending payload once the WikiList is ready.
	if (host && host.hasPendingShare) {
		try { if (host.hasPendingShare()) { window.__tdBeginShare(); } } catch (e) {}
	}

	on("tiddlydesktop-android-pick-config-folder", function () { if (host) host.pickConfigFolder(); });
	on("tiddlydesktop-android-open-config-folder", function () { if (host) host.openConfigFolder(); });
	on("tiddlydesktop-android-pick-backup-folder", function () { if (host) host.pickBackupFolder(); });
	on("tiddlydesktop-android-open-backup-folder", function () { if (host) host.openBackupFolder(); });

	window.__tdSetBackupPath = function (path) {
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/backup-folder-path", text: path }));
	};
	if (host && host.backupFolderPath) {
		try { var bp = host.backupFolderPath(); if (bp) { window.__tdSetBackupPath(bp); } } catch (e) {}
	}

	window.__tdSetConfigPath = function (path) {
		$tw.wiki.addTiddler(new $tw.Tiddler({ title: "$:/TiddlyDesktop/Config/config-folder-path", text: path }));
	};
	// Called right after a folder is picked: restore into a fresh install, else adopt current.
	window.__tdConfigFolderPicked = function () {
		var saved = ""; try { saved = host.readConfigJson(); } catch (e) {}
		if (saved && !hasLocalWikis()) { importSettings(saved); } else { scheduleExport(); }
	};

	// On boot: restore settings if this is a fresh install and a config folder is already set.
	if (host && host.readConfigJson) {
		try {
			var bootJson = host.readConfigJson();
			if (bootJson && !hasLocalWikis()) { importSettings(bootJson); }
		} catch (e) {}
		try { var cp = host.configFolderPath(); if (cp) { window.__tdSetConfigPath(cp); } } catch (e) {}
	}

	// Auto-export when user data changes (wiki list entries, config, theme/palette/language).
	$tw.wiki.addEventListener("change", function (changes) {
		var relevant = Object.keys(changes).some(function (t) {
			return t.indexOf("$:/TiddlyDesktop/Config/") === 0 ||
				t === "$:/theme" || t === "$:/palette" || t === "$:/language" ||
				t.indexOf("wikifile://") === 0 || t.indexOf("wikifolder://") === 0;
		});
		if (relevant) { scheduleExport(); }
	});

	// WikiList window title: reflect WikiListWindow's page-title as document.title (the host
	// picks this up via onReceivedTitle to label the Activity / Recents entry). Only in the
	// list view — the backstage/full TW manages its own title.
	function updateTitle() {
		try {
			if ($tw.wiki.getTiddlerText("$:/temp/td-view", "")) { return; }
			var t = $tw.wiki.getTiddler("WikiListWindow");
			var pt = (t && t.fields["page-title"]) || "TiddlyDesktop";
			if (document.title !== pt) { document.title = pt; }
		} catch (e) {}
	}
	updateTitle();
	$tw.wiki.addEventListener("change", function (ch) {
		if (ch["WikiListWindow"] || ch["$:/temp/td-view"]) { setTimeout(updateTitle, 30); }
	});

	// Live metadata: refresh once shortly after boot (favicon + SiteTitle/SiteSubtitle).
	setTimeout(refreshAllMeta, 600);
};
