/*
 * Runs inside each wiki window. Adds a "Share" tiddler-toolbar button that opens a "Share as"
 * dropdown (text / .tid / HTML) and shares the chosen form out via Android's share sheet
 * (window.TDShare). Also adds a "Share" button to Advanced Search's Filter tab, next to the
 * core "Upload" (export) button, so every tiddler matching the filter can be shared to another
 * wiki (Share as CSV / JSON / static HTML). Both button tiddlers are $:/temp tiddlers so they're
 * never saved into the wiki.
 */
(function () {
	if (window.__tdShareTiddler || typeof TDShare === "undefined") { return; }
	window.__tdShareTiddler = true;

	// Labels localized to the device language (native strings.xml), with English fallback.
	var L = { share: "Share", tooltip: "Share this tiddler", text: "Share as text", tid: "Share as .tid", html: "Share as HTML", json: "Share as JSON", csv: "Share as CSV" };
	try { if (TDShare.uiStrings) { L = Object.assign(L, JSON.parse(TDShare.uiStrings())); } } catch (e) {}

	function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

	// The Material/Android "share" glyph (three nodes joined by lines), sized like a core toolbar icon.
	var SHARE_ICON = '<svg class="tc-image-button" width="22pt" height="22pt" viewBox="0 0 24 24">' +
		'<path fill="currentColor" d="M18 16.08c-0.76 0-1.44 0.3-1.96 0.77L8.91 12.7c0.05-0.23 0.09-0.46 0.09-0.7' +
		's-0.04-0.47-0.09-0.7l7.05-4.11c0.54 0.5 1.25 0.81 2.04 0.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 0.24 0.04 0.47 0.09 0.7' +
		'L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c0.79 0 1.5-0.31 2.04-0.81l7.12 4.16' +
		'c-0.05 0.21-0.08 0.43-0.08 0.66 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>';

	var BTN =
		'<$button popup=<<qualify "$:/state/td-share-popup">> tooltip="' + esc(L.tooltip) + '" aria-label="' + esc(L.share) + '" class=<<tv-config-toolbar-class>>>' +
		'<$list filter="[<tv-config-toolbar-icons>match[yes]]">' + SHARE_ICON + '</$list>' +
		'<$list filter="[<tv-config-toolbar-text>match[yes]]"><span class="tc-btn-text">' + esc(L.share) + '</span></$list>' +
		'</$button>' +
		'<$reveal state=<<qualify "$:/state/td-share-popup">> type="popup" position="belowleft" animate="yes">' +
		'<div class="tc-drop-down">' +
		shareItem("text", L.text) +
		shareItem("tid", L.tid) +
		shareItem("html", L.html) +
		shareItem("json", L.json) +
		shareItem("csv", L.csv) +
		'</div></$reveal>';

	function shareItem(fmt, label) {
		return '<$button class="tc-btn-invisible">' +
			'<$action-sendmessage $message="tm-td-share-tiddler" tiddler=<<currentTiddler>> format="' + fmt + '"/>' +
			'<$action-deletetiddler $tiddler=<<qualify "$:/state/td-share-popup">>/>' +
			esc(label) + '</$button>';
	}

	// Advanced Search Filter-tab "Share" button — mirrors the core "Upload" (export) button, but
	// shares every tiddler matching the current filter ($:/temp/advancedsearch) via the Android
	// share sheet instead of downloading. Shown only when the filter is non-empty (like Upload).
	var FILTER_BTN =
		'<$reveal state="$:/temp/advancedsearch" type="nomatch" text="">' +
		'<span class="tc-popup-keep">' +
		'<$button popup=<<qualify "$:/state/td-share-export-popup">> tooltip="' + esc(L.share) + '" aria-label="' + esc(L.share) + '" class=<<tv-config-toolbar-class>>>' +
		SHARE_ICON +
		'<span class="tc-btn-text">&#32;' + esc(L.share) + '</span>' +
		'</$button></span>' +
		'<$reveal state=<<qualify "$:/state/td-share-export-popup">> type="popup" position="below" animate="yes">' +
		'<div class="tc-drop-down">' +
		exportItem("csv", L.csv) +
		exportItem("json", L.json) +
		exportItem("html", L.html) +
		'</div></$reveal></$reveal>';

	function exportItem(fmt, label) {
		return '<$button class="tc-btn-invisible">' +
			'<$action-sendmessage $message="tm-td-share-export" exportFilter={{$:/temp/advancedsearch}} format="' + fmt + '"/>' +
			'<$action-deletetiddler $tiddler=<<qualify "$:/state/td-share-export-popup">>/>' +
			esc(label) + '</$button>';
	}

	function whenReady(fn) {
		if (window.$tw && $tw.wiki && $tw.rootWidget) { fn(); } else { setTimeout(function () { whenReady(fn); }, 250); }
	}
	whenReady(function () {
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/TiddlyDesktop/ShareButton",
			tags: "$:/tags/ViewToolbar",
			caption: L.share,
			description: L.tooltip,
			text: BTN
		}));

		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: "$:/temp/TiddlyDesktop/ShareFilterButton",
			tags: "$:/tags/AdvancedSearch/FilterButton",
			text: FILTER_BTN
		}));

		$tw.rootWidget.addEventListener("tm-td-share-tiddler", function (event) {
			try {
				var po = event.paramObject || {};
				var title = po.tiddler || event.param;
				if (!title) { return false; }
				var fmt = po.format || "text";
				var exportFilter = "[[" + title + "]]";
				if (fmt === "tid") {
					// Share as an actual <title>.tid file (FileProvider).
					var tid = $tw.wiki.renderTiddler("text/plain", "$:/core/templates/tid-tiddler", { variables: { currentTiddler: title } });
					TDShare.shareTidFile(title, tid);
					return false;
				}
				if (fmt === "json") {
					// Standard TiddlyWiki JSON export (re-importable as tiddlers).
					var json = $tw.wiki.renderTiddler("text/plain", "$:/core/templates/exporters/JsonFile", { variables: { exportFilter: exportFilter } });
					TDShare.shareFile(title, json, "json", "application/json");
					return false;
				}
				if (fmt === "csv") {
					var csv = $tw.wiki.renderTiddler("text/plain", "$:/core/templates/exporters/CsvFile", { variables: { exportFilter: exportFilter } });
					TDShare.shareFile(title, csv, "csv", "text/csv");
					return false;
				}
				var content;
				if (fmt === "html") {
					content = $tw.wiki.renderTiddler("text/html", title);
				} else {
					var t = $tw.wiki.getTiddler(title);
					content = (t && t.fields.text != null) ? String(t.fields.text) : "";
				}
				TDShare.shareText(title, content);
			} catch (e) {}
			return false;
		});

		// Advanced Search "Share": share every tiddler matching the filter, as one file. Renders the
		// same core exporter templates as the "Upload" button's tm-download-file, then hands the
		// result to the Android share sheet instead of downloading it.
		var EXPORTERS = {
			csv:  { template: "$:/core/templates/exporters/CsvFile",     ext: "csv",  mime: "text/csv" },
			json: { template: "$:/core/templates/exporters/JsonFile",    ext: "json", mime: "application/json" },
			html: { template: "$:/core/templates/exporters/StaticRiver", ext: "html", mime: "text/html" }
		};
		$tw.rootWidget.addEventListener("tm-td-share-export", function (event) {
			try {
				var po = event.paramObject || {};
				var exportFilter = po.exportFilter || $tw.wiki.getTiddlerText("$:/temp/advancedsearch", "");
				if (!exportFilter) { return false; }
				var spec = EXPORTERS[po.format || "json"];
				if (!spec) { return false; }
				if (!$tw.wiki.filterTiddlers(exportFilter).length) { return false; }
				var content = $tw.wiki.renderTiddler("text/plain", spec.template, { variables: { exportFilter: exportFilter } });
				TDShare.shareFile("tiddlers", content, spec.ext, spec.mime);
			} catch (e) {}
			return false;
		});
	});
})();
